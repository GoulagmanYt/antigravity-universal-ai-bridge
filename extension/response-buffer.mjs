/**
 * WebAI Bridge - Anti-Timeout Response Capture, Buffering & Polling Engine
 * Guarantees zero lost responses even when Web AI generation exceeds the 180s IDE MCP tool deadline:
 *   1. Real-time streaming ingestion (STREAM_CHUNK) into in-memory + disk-backed job store.
 *   2. Soft-deadline preemption (default 145s < 180s IDE limit): resolves the MCP call cleanly with
 *      status="partial_streaming", the partial text captured so far, and a `jobId` token while
 *      the browser tab continues generating uninterrupted.
 *   3. Idempotent polling & prompt-hash deduplication: subsequent calls with `jobId` (or identical
 *      prompt hash) attach to the running/completed job and deliver 100% of the final output.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_SOFT_TIMEOUT_MS = 145000; // 145s (35s safety margin before 180s client deadline)
export const DEFAULT_HARD_TIMEOUT_MS = 600000; // 10 minutes max background generation
export const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // Keep completed jobs for 30 minutes

export const JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  STREAMING: 'streaming',
  COMPLETED: 'completed',
  FAILED: 'failed'
});

/**
 * Computes a deterministic SHA-256 fingerprint for a prompt + provider + files tuple.
 * Used to automatically re-attach a retried IDE request to an in-flight or recently completed job.
 * @param {object} params
 * @param {string} params.prompt
 * @param {string} [params.provider]
 * @param {Array<object>} [params.files]
 * @returns {string}
 */
export function computePromptFingerprint({ prompt = '', provider = '', files = [] }) {
  const hash = crypto.createHash('sha256');
  hash.update(String(provider).toLowerCase());
  hash.update('\x00');
  hash.update(String(prompt).trim());
  hash.update('\x00');
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f && typeof f === 'object') {
        hash.update(`${f.name || f.path || ''}:${(f.content || '').length};`);
      }
    }
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * Manages long-running orchestrator jobs, streaming buffers, disk persistence, and soft-deadline awaits.
 */
export class ResponseBufferManager {
  /**
   * @param {object} [options]
   * @param {number} [options.softTimeoutMs]
   * @param {number} [options.hardTimeoutMs]
   * @param {number} [options.jobTtlMs]
   * @param {string} [options.cacheDir]
   * @param {boolean} [options.persistToDisk]
   */
  constructor(options = {}) {
    this.softTimeoutMs = options.softTimeoutMs || DEFAULT_SOFT_TIMEOUT_MS;
    this.hardTimeoutMs = options.hardTimeoutMs || DEFAULT_HARD_TIMEOUT_MS;
    this.jobTtlMs = options.jobTtlMs || DEFAULT_JOB_TTL_MS;
    this.persistToDisk = options.persistToDisk !== false;
    this.cacheDir =
      options.cacheDir ||
      path.join(os.tmpdir(), 'webai-bridge-response-cache');

    this.jobs = new Map();
    this.fingerprintIndex = new Map();
    this.waiters = new Map(); // jobId -> Set<Function>

    if (this.persistToDisk) {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
      } catch (_) {
        this.persistToDisk = false;
      }
    }
  }

  /**
   * Creates a new buffered job or returns an existing active/recent job matching the same fingerprint.
   * @param {object} params
   * @param {string} [params.jobId]
   * @param {string} params.prompt
   * @param {string} [params.provider]
   * @param {Array<object>} [params.files]
   * @param {boolean} [params.allowDedupe=true]
   * @returns {{ job: object, deduplicated: boolean }}
   */
  createOrAttachJob({ jobId, prompt = '', provider = 'unknown', files = [], allowDedupe = true }) {
    this.pruneExpiredJobs();

    const fingerprint = computePromptFingerprint({ prompt, provider, files });

    if (allowDedupe && this.fingerprintIndex.has(fingerprint)) {
      const existingId = this.fingerprintIndex.get(fingerprint);
      const existingJob = this.getJob(existingId);
      if (
        existingJob &&
        (existingJob.status === JOB_STATUS.PENDING || existingJob.status === JOB_STATUS.STREAMING)
      ) {
        return { job: existingJob, deduplicated: true };
      }
    }

    const id = jobId || `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const job = {
      jobId: id,
      fingerprint,
      provider,
      status: JOB_STATUS.PENDING,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      partialText: '',
      finalText: null,
      chunksEmitted: 0,
      isThinking: false,
      error: null
    };

    this.jobs.set(id, job);
    this.fingerprintIndex.set(fingerprint, id);
    this._persistJobToDisk(job);
    return { job, deduplicated: false };
  }

  /**
   * Ingests a `STREAM_CHUNK` payload emitted by `content-core.js`.
   * @param {object} chunkMsg
   * @returns {object|null} Updated job
   */
  ingestStreamChunk(chunkMsg) {
    if (!chunkMsg || typeof chunkMsg !== 'object') return null;
    const jobId = chunkMsg.jobId || chunkMsg.requestId;
    if (!jobId) return null;

    let job = this.jobs.get(jobId);
    if (!job) {
      job = this.createOrAttachJob({
        jobId,
        prompt: '',
        provider: chunkMsg.provider || 'unknown',
        allowDedupe: false
      }).job;
    }

    if (job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.FAILED) {
      return job;
    }

    job.status = JOB_STATUS.STREAMING;
    job.updatedAt = Date.now();
    if (typeof chunkMsg.fullText === 'string' && chunkMsg.fullText.length >= job.partialText.length) {
      job.partialText = chunkMsg.fullText;
    }
    if (typeof chunkMsg.chunksEmitted === 'number') {
      job.chunksEmitted = chunkMsg.chunksEmitted;
    } else {
      job.chunksEmitted += 1;
    }
    job.isThinking = Boolean(chunkMsg.isThinking);

    this._persistJobToDisk(job);
    return job;
  }

  /**
   * Marks a job as completed with its full final response text and wakes all waiting callers.
   * @param {string} jobId
   * @param {string} finalText
   * @param {object} [meta]
   * @returns {object|null}
   */
  completeJob(jobId, finalText, meta = {}) {
    let job = this.jobs.get(jobId);
    if (!job) {
      job = this.createOrAttachJob({
        jobId,
        prompt: '',
        provider: meta.provider || 'unknown',
        allowDedupe: false
      }).job;
    }

    const now = Date.now();
    job.status = JOB_STATUS.COMPLETED;
    job.updatedAt = now;
    job.completedAt = now;
    job.finalText = typeof finalText === 'string' ? finalText : job.partialText;
    job.partialText = job.finalText;
    job.isThinking = false;
    if (typeof meta.chunksEmitted === 'number') {
      job.chunksEmitted = meta.chunksEmitted;
    }

    this._persistJobToDisk(job);
    this._notifyWaiters(jobId, job);
    return job;
  }

  /**
   * Marks a job as failed and wakes any waiting callers.
   * @param {string} jobId
   * @param {object|Error} error
   * @returns {object|null}
   */
  failJob(jobId, error) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    job.status = JOB_STATUS.FAILED;
    job.updatedAt = Date.now();
    job.error = {
      code: (error && error.code) || 'ERR_JOB_FAILED',
      message: (error && error.message) || String(error)
    };

    this._persistJobToDisk(job);
    this._notifyWaiters(jobId, job);
    return job;
  }

  /**
   * Retrieves a job by ID from memory or disk cache.
   * @param {string} jobId
   * @returns {object|null}
   */
  getJob(jobId) {
    if (!jobId) return null;
    if (this.jobs.has(jobId)) {
      return this.jobs.get(jobId);
    }
    if (this.persistToDisk) {
      const diskJob = this._readJobFromDisk(jobId);
      if (diskJob) {
        this.jobs.set(jobId, diskJob);
        return diskJob;
      }
    }
    return null;
  }

  /**
   * Waits for a job to complete up to `softTimeoutMs` (default 145s).
   * - If the job completes in time: returns `{ status: 'completed', jobId, text, ... }`.
   * - If `softTimeoutMs` elapses while the tab is still streaming/generating:
   *   returns `{ status: 'partial_streaming', jobId, partialText, capturedChars, resumeInstruction }`
   *   WITHOUT aborting the browser job, completely preventing 180s IDE timeouts!
   * @param {string} jobId
   * @param {object} [options]
   * @param {number} [options.softTimeoutMs]
   * @returns {Promise<object>}
   */
  async waitForWindowOrCompletion(jobId, options = {}) {
    const windowMs = options.softTimeoutMs || this.softTimeoutMs;
    const job = this.getJob(jobId);

    if (!job) {
      return {
        status: 'not_found',
        jobId,
        error: {
          code: 'ERR_JOB_NOT_FOUND',
          message: `No active or cached orchestrator job found for jobId "${jobId}"`
        }
      };
    }

    if (job.status === JOB_STATUS.COMPLETED) {
      return this._formatResolution(job, false);
    }

    if (job.status === JOB_STATUS.FAILED) {
      return this._formatResolution(job, false);
    }

    return new Promise((resolve) => {
      let timer = null;

      const onSettled = (settledJob) => {
        if (timer) clearTimeout(timer);
        this._removeWaiter(jobId, onSettled);
        resolve(this._formatResolution(settledJob, false));
      };

      this._addWaiter(jobId, onSettled);

      timer = setTimeout(() => {
        this._removeWaiter(jobId, onSettled);
        const currentJob = this.getJob(jobId) || job;
        resolve(this._formatResolution(currentJob, true));
      }, windowMs);
    });
  }

  /**
   * Formats a structured resolution envelope for completed, failed, or soft-preempted streaming jobs.
   * @param {object} job
   * @param {boolean} softTimedOut
   * @returns {object}
   */
  _formatResolution(job, softTimedOut) {
    if (job.status === JOB_STATUS.COMPLETED) {
      return {
        status: 'completed',
        complete: true,
        jobId: job.jobId,
        provider: job.provider,
        text: job.finalText ?? job.partialText,
        capturedChars: (job.finalText ?? job.partialText).length,
        chunksEmitted: job.chunksEmitted,
        elapsedMs: (job.completedAt || Date.now()) - job.createdAt
      };
    }

    if (job.status === JOB_STATUS.FAILED) {
      return {
        status: 'failed',
        complete: false,
        jobId: job.jobId,
        provider: job.provider,
        partialText: job.partialText,
        capturedChars: job.partialText.length,
        error: job.error || { code: 'ERR_JOB_FAILED', message: 'Job failed' }
      };
    }

    // Soft-timeout preemption: generation is still running in the browser tab
    return {
      status: 'partial_streaming',
      complete: false,
      softTimedOut: Boolean(softTimedOut),
      jobId: job.jobId,
      provider: job.provider,
      isThinking: job.isThinking,
      partialText: job.partialText,
      capturedChars: job.partialText.length,
      chunksEmitted: job.chunksEmitted,
      elapsedMs: Date.now() - job.createdAt,
      resumeInstruction:
        `Generation is still in progress (${job.partialText.length} chars captured so far). ` +
        `Call consult_orchestrator or orchestrator_status with jobId="${job.jobId}" to retrieve the remaining output without restarting generation.`
    };
  }

  _addWaiter(jobId, fn) {
    if (!this.waiters.has(jobId)) {
      this.waiters.set(jobId, new Set());
    }
    this.waiters.get(jobId).add(fn);
  }

  _removeWaiter(jobId, fn) {
    const set = this.waiters.get(jobId);
    if (set) {
      set.delete(fn);
      if (set.size === 0) {
        this.waiters.delete(jobId);
      }
    }
  }

  _notifyWaiters(jobId, job) {
    const set = this.waiters.get(jobId);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(job);
      } catch (_) {
        // Ignore waiter callback errors
      }
    }
  }

  _jobFilePath(jobId) {
    const safeId = String(jobId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.cacheDir, `${safeId}.json`);
  }

  _persistJobToDisk(job) {
    if (!this.persistToDisk) return;
    try {
      fs.writeFileSync(this._jobFilePath(job.jobId), JSON.stringify(job), {
        encoding: 'utf8',
        mode: 0o600
      });
    } catch (_) {
      // Non-fatal cache write failure
    }
  }

  _readJobFromDisk(jobId) {
    if (!this.persistToDisk) return null;
    try {
      const file = this._jobFilePath(jobId);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  /**
   * Cleans up expired completed/failed jobs and times out abandoned streaming jobs exceeding hardTimeoutMs.
   */
  pruneExpiredJobs() {
    const now = Date.now();
    for (const [id, job] of this.jobs.entries()) {
      const age = now - job.updatedAt;
      if (
        (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.STREAMING) &&
        now - job.createdAt > this.hardTimeoutMs
      ) {
        this.failJob(id, {
          code: 'ERR_HARD_TIMEOUT_EXCEEDED',
          message: `Job ${id} exceeded hard generation timeout (${this.hardTimeoutMs}ms)`
        });
        continue;
      }

      if (
        (job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.FAILED) &&
        age > this.jobTtlMs
      ) {
        this.jobs.delete(id);
        this.fingerprintIndex.delete(job.fingerprint);
        if (this.persistToDisk) {
          try {
            fs.unlinkSync(this._jobFilePath(id));
          } catch (_) {
            // Ignore
          }
        }
      }
    }
  }
}
