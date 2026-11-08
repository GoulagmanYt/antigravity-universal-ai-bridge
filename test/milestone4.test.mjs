/**
 * WebAI Bridge - Milestone 4 Unit & Architectural Verification Suite
 * Covers:
 *   1. Modular content script architecture (providers, upload, core, unified facade)
 *   2. DeepSeek hash-free selectors verification
 *   3. Formal UploadStateMachine transitions, validation, retries & rollback
 *   4. Configurable port & per-session cryptographic WebSocket authentication
 *   5. Anti-timeout (180s+) streaming buffer, soft-deadline preemption & idempotent polling
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import {
  resolveBridgePort,
  generateSessionToken,
  safeTokenCompare,
  isAllowedOrigin,
  SessionAuthManager
} from '../extension/session-auth.mjs';

import {
  JOB_STATUS,
  computePromptFingerprint,
  ResponseBufferManager
} from '../extension/response-buffer.mjs';

const require = createRequire(import.meta.url);
const ContentFacade = require('../extension/content.js');
const ProvidersMod = require('../extension/content-providers.js');
const UploadMod = require('../extension/content-upload.js');
const CoreMod = require('../extension/content-core.js');

test('Milestone 4.1 - Modular content.js architecture exports all sub-modules cleanly', () => {
  assert.ok(ContentFacade.PROVIDERS, 'PROVIDERS registry should be exported');
  assert.equal(typeof ContentFacade.detectProvider, 'function');
  assert.equal(typeof ContentFacade.UploadStateMachine, 'function');
  assert.equal(typeof ContentFacade.BridgeContentRuntime, 'function');
  assert.equal(typeof ContentFacade.buildWebSocketUrl, 'function');

  for (const id of ['gemini', 'claude', 'chatgpt', 'deepseek', 'aistudio']) {
    assert.ok(ProvidersMod.PROVIDERS[id], `Provider ${id} must be defined`);
    assert.ok(Array.isArray(ProvidersMod.PROVIDERS[id].inputSelectors));
    assert.ok(ProvidersMod.PROVIDERS[id].inputSelectors.length > 0);
  }
});

test('Milestone 4.2 - DeepSeek selectors are 100% free of hashed CSS module classes', () => {
  const ds = ProvidersMod.PROVIDERS.deepseek;
  assert.equal(ds.id, 'deepseek');
  assert.ok(ProvidersMod.detectProvider('chat.deepseek.com')?.id === 'deepseek');

  const allSelectorLists = [
    ds.inputSelectors,
    ds.sendButtonSelectors,
    ds.stopButtonSelectors,
    ds.streamingIndicators,
    ds.responseSelectors,
    ds.fileInputSelectors,
    ds.uploadTriggerSelectors
  ];

  // Hashed classes typically end with random hex/alphanumeric suffixes like `_[a-f0-9]{5,}` or `--[a-f0-9]{5,}`
  const hashedClassRegex = /\.[a-zA-Z0-9_-]+(?:__|--)([a-f0-9]{5,})\b/;
  for (const list of allSelectorLists) {
    for (const sel of list) {
      assert.equal(
        hashedClassRegex.test(sel),
        false,
        `Selector "${sel}" must not rely on unstable hashed CSS classes`
      );
    }
  }

  assert.equal(typeof ds.customResolver.findSendButton, 'function');
  assert.equal(typeof ds.customResolver.findStopButton, 'function');
  assert.equal(typeof ds.customResolver.findUploadTrigger, 'function');
});

test('Milestone 4.3 - Formal UploadStateMachine enforces legal transitions and bounded retries', async () => {
  const sm = new UploadMod.UploadStateMachine({ maxRetries: 1 });
  assert.equal(sm.state, UploadMod.UPLOAD_STATES.IDLE);

  // Illegal jump IDLE -> INJECTING must throw ERR_INVALID_UPLOAD_TRANSITION
  assert.throws(
    () => sm.transition(UploadMod.UPLOAD_STATES.INJECTING),
    (err) => err.code === 'ERR_INVALID_UPLOAD_TRANSITION'
  );

  // Empty file list transitions directly IDLE -> READY
  const emptyRes = await sm.executeUpload([], ProvidersMod.PROVIDERS.gemini);
  assert.equal(emptyRes.state, UploadMod.UPLOAD_STATES.READY);
  assert.equal(emptyRes.count, 0);

  sm.reset();
  assert.equal(sm.state, UploadMod.UPLOAD_STATES.IDLE);

  // Full lifecycle with retry on first verification attempt
  let verifyAttempts = 0;
  const fullRes = await sm.executeUpload(
    [{ name: '../unsafe/path/spec.md', content: '# Spec', encoding: 'utf8' }],
    ProvidersMod.PROVIDERS.gemini,
    {
      injectFn: async () => ({ strategy: 'mock_data_transfer' }),
      verifyFn: async () => {
        verifyAttempts++;
        return verifyAttempts >= 2; // Fail 1st verify, succeed on retry
      }
    }
  );

  assert.equal(fullRes.state, UploadMod.UPLOAD_STATES.READY);
  assert.equal(fullRes.count, 1);
  assert.equal(fullRes.attempts, 2);
  assert.equal(fullRes.strategy, 'mock_data_transfer');

  const statesVisited = sm.getHistory().map((h) => h.to);
  assert.deepEqual(statesVisited.slice(-6), [
    UploadMod.UPLOAD_STATES.VALIDATING,
    UploadMod.UPLOAD_STATES.PREPARING,
    UploadMod.UPLOAD_STATES.INJECTING,
    UploadMod.UPLOAD_STATES.VERIFYING_DOM,
    UploadMod.UPLOAD_STATES.INJECTING,
    UploadMod.UPLOAD_STATES.VERIFYING_DOM,
    UploadMod.UPLOAD_STATES.READY
  ].slice(-6));
});

test('Milestone 4.4 - Configurable port and per-session WebSocket authentication', () => {
  assert.equal(resolveBridgePort({ argv: ['node', 'bridge.mjs', '--port', '9123'], env: {} }), 9123);
  assert.equal(resolveBridgePort({ argv: [], env: { WEBAI_BRIDGE_PORT: '9200' } }), 9200);
  assert.throws(() => resolveBridgePort({ port: 80 }), /Invalid WebAI Bridge port/);

  const token = generateSessionToken(32);
  assert.equal(token.length, 64);
  assert.equal(safeTokenCompare(token, token), true);
  assert.equal(safeTokenCompare(token, 'wrong_token'), false);

  assert.equal(isAllowedOrigin('https://gemini.google.com'), true);
  assert.equal(isAllowedOrigin('https://chat.deepseek.com'), true);
  assert.equal(isAllowedOrigin('https://evil-attacker.example.com'), false);

  const tmpFile = path.join(os.tmpdir(), `webai-session-${Date.now()}.json`);
  const auth = new SessionAuthManager({
    port: 8899,
    token,
    requireToken: true,
    sessionFilePath: tmpFile
  });

  auth.persistSessionFile();
  assert.equal(fs.existsSync(tmpFile), true);
  const persisted = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.equal(persisted.port, 8899);
  assert.equal(persisted.token, token);

  // Reject invalid origin
  const badOriginCheck = auth.verifyUpgradeRequest({
    headers: { origin: 'https://malicious.site' },
    url: `/?token=${token}`
  });
  assert.equal(badOriginCheck.ok, false);
  assert.equal(badOriginCheck.code, 'ERR_WS_FORBIDDEN_ORIGIN');

  // Reject missing token when requireToken=true
  const missingTokenCheck = auth.verifyUpgradeRequest({
    headers: { origin: 'https://gemini.google.com' },
    url: '/'
  });
  assert.equal(missingTokenCheck.ok, false);
  assert.equal(missingTokenCheck.code, 'ERR_WS_INVALID_TOKEN');

  // Accept valid origin + token
  const validCheck = auth.verifyUpgradeRequest({
    headers: { origin: 'https://gemini.google.com' },
    url: `/?token=${token}`
  });
  assert.equal(validCheck.ok, true);
  assert.equal(validCheck.tokenVerified, true);

  // Handshake secret issuance and message verification
  const fakeWs = {};
  const handshake = auth.authenticateConnection(fakeWs, { authToken: token, provider: 'gemini' });
  assert.equal(handshake.ok, true);
  assert.ok(handshake.sessionSecret);
  assert.equal(auth.validateMessageAuth(fakeWs, { sessionSecret: handshake.sessionSecret }), true);
  assert.equal(auth.validateMessageAuth(fakeWs, { sessionSecret: 'forged_secret' }), false);

  auth.cleanupSessionFile();
  assert.equal(fs.existsSync(tmpFile), false);

  assert.equal(
    CoreMod.buildWebSocketUrl(8899, 'abc123token'),
    'ws://127.0.0.1:8899/?token=abc123token'
  );
});

test('Milestone 4.5 - Anti-timeout ResponseBufferManager preempts 180s deadline and resumes seamlessly', async () => {
  const cacheDir = path.join(os.tmpdir(), `webai-buffer-test-${Date.now()}`);
  const buffer = new ResponseBufferManager({
    softTimeoutMs: 80, // Fast soft timeout for unit test
    hardTimeoutMs: 5000,
    cacheDir
  });

  const { job, deduplicated } = buffer.createOrAttachJob({
    prompt: 'Design complete distributed rocket telemetry architecture',
    provider: 'gemini'
  });
  assert.equal(deduplicated, false);

  // Deduplication check: identical prompt attaches to the same in-flight jobId
  const secondAttach = buffer.createOrAttachJob({
    prompt: 'Design complete distributed rocket telemetry architecture',
    provider: 'gemini'
  });
  assert.equal(secondAttach.deduplicated, true);
  assert.equal(secondAttach.job.jobId, job.jobId);

  // Simulate progressive STREAM_CHUNK emissions before soft deadline
  buffer.ingestStreamChunk({
    jobId: job.jobId,
    fullText: 'Part 1: Telemetry ingestion pipeline...',
    chunksEmitted: 1,
    isThinking: false
  });

  // First wait hits the soft deadline (80ms) while generation is still streaming
  const firstWindow = await buffer.waitForWindowOrCompletion(job.jobId);
  assert.equal(firstWindow.status, 'partial_streaming');
  assert.equal(firstWindow.complete, false);
  assert.equal(firstWindow.jobId, job.jobId);
  assert.match(firstWindow.partialText, /Part 1: Telemetry ingestion pipeline/);
  assert.ok(firstWindow.resumeInstruction.includes(job.jobId));

  // Tab continues generating in the background and finishes 40ms later
  setTimeout(() => {
    buffer.ingestStreamChunk({
      jobId: job.jobId,
      fullText: 'Part 1: Telemetry ingestion pipeline...\nPart 2: Kalman filter fusion.',
      chunksEmitted: 2
    });
    buffer.completeJob(
      job.jobId,
      'Part 1: Telemetry ingestion pipeline...\nPart 2: Kalman filter fusion.\nPart 3: Complete.',
      { chunksEmitted: 3 }
    );
  }, 40);

  // IDE polls with jobId and receives 100% of the completed response without timeout
  const secondWindow = await buffer.waitForWindowOrCompletion(job.jobId, { softTimeoutMs: 500 });
  assert.equal(secondWindow.status, 'completed');
  assert.equal(secondWindow.complete, true);
  assert.equal(
    secondWindow.text,
    'Part 1: Telemetry ingestion pipeline...\nPart 2: Kalman filter fusion.\nPart 3: Complete.'
  );
  assert.equal(secondWindow.chunksEmitted, 3);

  fs.rmSync(cacheDir, { recursive: true, force: true });
});
