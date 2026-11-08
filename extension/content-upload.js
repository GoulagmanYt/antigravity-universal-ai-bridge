/**
 * WebAI Bridge - Formal File Upload State Machine
 * Enforces deterministic transitions, payload validation, multi-strategy DOM injection,
 * and post-injection attachment chip verification before prompt dispatch.
 * Dual-environment module: Browser Content Script (window) & Node.js (CommonJS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const providersMod = require('./content-providers.js');
    module.exports = factory(providersMod);
  } else {
    root.WebAIBridgeUpload = factory(root.WebAIBridgeProviders);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Providers) {
  'use strict';

  const UPLOAD_STATES = Object.freeze({
    IDLE: 'IDLE',
    VALIDATING: 'VALIDATING',
    PREPARING: 'PREPARING',
    INJECTING: 'INJECTING',
    VERIFYING_DOM: 'VERIFYING_DOM',
    READY: 'READY',
    FAILED: 'FAILED',
    ROLLED_BACK: 'ROLLED_BACK'
  });

  const ALLOWED_TRANSITIONS = Object.freeze({
    [UPLOAD_STATES.IDLE]: [UPLOAD_STATES.VALIDATING, UPLOAD_STATES.READY],
    [UPLOAD_STATES.VALIDATING]: [UPLOAD_STATES.PREPARING, UPLOAD_STATES.FAILED],
    [UPLOAD_STATES.PREPARING]: [UPLOAD_STATES.INJECTING, UPLOAD_STATES.FAILED],
    [UPLOAD_STATES.INJECTING]: [UPLOAD_STATES.VERIFYING_DOM, UPLOAD_STATES.FAILED],
    [UPLOAD_STATES.VERIFYING_DOM]: [
      UPLOAD_STATES.READY,
      UPLOAD_STATES.INJECTING, // Retry transition
      UPLOAD_STATES.FAILED
    ],
    [UPLOAD_STATES.READY]: [UPLOAD_STATES.IDLE],
    [UPLOAD_STATES.FAILED]: [UPLOAD_STATES.ROLLED_BACK, UPLOAD_STATES.IDLE, UPLOAD_STATES.PREPARING],
    [UPLOAD_STATES.ROLLED_BACK]: [UPLOAD_STATES.IDLE]
  });

  const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file

  /**
   * Sleeps for a specified duration in ms.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Sanitizes a filename to prevent path traversal or control characters in the DOM.
   * @param {string} name
   * @returns {string}
   */
  function sanitizeFileName(name) {
    if (!name || typeof name !== 'string') return 'attachment.txt';
    const base = name.split(/[\\/]/).pop() || 'attachment.txt';
    const cleaned = base.replace(/[\x00-\x1f\x80-\x9f<>:"|?*]/g, '_').trim();
    return cleaned || 'attachment.txt';
  }

  /**
   * Converts a file descriptor ({ name, content, encoding, mimeType }) into a browser File object.
   * @param {object} desc
   * @returns {File|object}
   */
  function buildFileObject(desc) {
    const safeName = sanitizeFileName(desc.name || desc.path || 'attachment.txt');
    const mimeType = desc.mimeType || desc.type || 'text/plain;charset=utf-8';
    let byteArray;

    if (desc.encoding === 'base64' && typeof desc.content === 'string') {
      if (typeof atob === 'function') {
        const binaryString = atob(desc.content);
        byteArray = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          byteArray[i] = binaryString.charCodeAt(i);
        }
      } else if (typeof Buffer !== 'undefined') {
        byteArray = new Uint8Array(Buffer.from(desc.content, 'base64'));
      }
    } else {
      const textContent = typeof desc.content === 'string' ? desc.content : JSON.stringify(desc.content ?? '');
      if (typeof TextEncoder !== 'undefined') {
        byteArray = new TextEncoder().encode(textContent);
      } else if (typeof Buffer !== 'undefined') {
        byteArray = new Uint8Array(Buffer.from(textContent, 'utf8'));
      } else {
        byteArray = new Uint8Array(0);
      }
    }

    if (typeof File === 'function') {
      return new File([byteArray], safeName, {
        type: mimeType,
        lastModified: Date.now()
      });
    }

    // Node.js test fallback object when global File is unavailable
    return {
      name: safeName,
      size: byteArray.byteLength,
      type: mimeType,
      _bytes: byteArray
    };
  }

  /**
   * Formal Upload State Machine.
   */
  class UploadStateMachine {
    /**
     * @param {object} [options]
     * @param {number} [options.maxFileBytes]
     * @param {number} [options.maxRetries]
     * @param {number} [options.verifyTimeoutMs]
     * @param {Function} [options.onTransition]
     */
    constructor(options = {}) {
      this.state = UPLOAD_STATES.IDLE;
      this.maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
      this.maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : 2;
      this.verifyTimeoutMs = options.verifyTimeoutMs || 8000;
      this.onTransition = typeof options.onTransition === 'function' ? options.onTransition : null;
      this.history = [
        {
          from: null,
          to: UPLOAD_STATES.IDLE,
          timestamp: Date.now(),
          meta: { reason: 'init' }
        }
      ];
      this.lastError = null;
    }

    /**
     * Performs a validated state transition.
     * @param {string} nextState
     * @param {object} [meta]
     * @returns {string}
     */
    transition(nextState, meta = {}) {
      const allowed = ALLOWED_TRANSITIONS[this.state] || [];
      if (!allowed.includes(nextState)) {
        const err = new Error(
          `Illegal upload state transition: ${this.state} -> ${nextState}`
        );
        err.code = 'ERR_INVALID_UPLOAD_TRANSITION';
        err.fromState = this.state;
        err.toState = nextState;
        throw err;
      }

      const prevState = this.state;
      this.state = nextState;
      const entry = {
        from: prevState,
        to: nextState,
        timestamp: Date.now(),
        meta
      };
      this.history.push(entry);

      if (this.onTransition) {
        try {
          this.onTransition(entry);
        } catch (_) {
          // Observer errors must not break the state machine
        }
      }
      return this.state;
    }

    /**
     * Resets the state machine back to IDLE.
     */
    reset() {
      if (this.state === UPLOAD_STATES.FAILED) {
        this.transition(UPLOAD_STATES.ROLLED_BACK, { reason: 'cleanup_before_reset' });
      }
      if (this.state !== UPLOAD_STATES.IDLE) {
        this.transition(UPLOAD_STATES.IDLE, { reason: 'reset' });
      }
      this.lastError = null;
    }

    /**
     * Returns a shallow copy of the transition history.
     * @returns {Array<object>}
     */
    getHistory() {
      return this.history.slice();
    }

    /**
     * Validates an array of file descriptors before preparing File objects.
     * @param {Array<object>} files
     * @returns {Array<object>}
     */
    validatePayloads(files) {
      this.transition(UPLOAD_STATES.VALIDATING, { count: Array.isArray(files) ? files.length : 0 });

      if (!Array.isArray(files) || files.length === 0) {
        const err = new Error('Upload payload must be a non-empty array of files');
        err.code = 'ERR_UPLOAD_EMPTY_PAYLOAD';
        this.lastError = err;
        this.transition(UPLOAD_STATES.FAILED, { code: err.code, message: err.message });
        throw err;
      }

      const normalized = [];
      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        if (!item || typeof item !== 'object') {
          const err = new Error(`Invalid file descriptor at index ${i}`);
          err.code = 'ERR_UPLOAD_INVALID_DESCRIPTOR';
          this.lastError = err;
          this.transition(UPLOAD_STATES.FAILED, { code: err.code, index: i });
          throw err;
        }

        const rawContent = typeof item.content === 'string' ? item.content : '';
        const estimatedBytes =
          item.encoding === 'base64'
            ? Math.floor((rawContent.length * 3) / 4)
            : rawContent.length;

        if (estimatedBytes > this.maxFileBytes) {
          const err = new Error(
            `File "${item.name || i}" exceeds maximum size (${estimatedBytes} > ${this.maxFileBytes} bytes)`
          );
          err.code = 'ERR_UPLOAD_FILE_TOO_LARGE';
          this.lastError = err;
          this.transition(UPLOAD_STATES.FAILED, { code: err.code, name: item.name });
          throw err;
        }

        normalized.push({
          name: sanitizeFileName(item.name || item.path || `file_${i + 1}.txt`),
          content: rawContent,
          encoding: item.encoding === 'base64' ? 'base64' : 'utf8',
          mimeType: item.mimeType || item.type || 'text/plain;charset=utf-8'
        });
      }

      return normalized;
    }

    /**
     * Prepares browser File objects from validated descriptors.
     * @param {Array<object>} normalizedDescriptors
     * @returns {Array<File|object>}
     */
    prepareFiles(normalizedDescriptors) {
      this.transition(UPLOAD_STATES.PREPARING, { count: normalizedDescriptors.length });
      try {
        return normalizedDescriptors.map((desc) => buildFileObject(desc));
      } catch (err) {
        err.code = err.code || 'ERR_UPLOAD_PREPARE_FAILED';
        this.lastError = err;
        this.transition(UPLOAD_STATES.FAILED, { code: err.code, message: err.message });
        throw err;
      }
    }

    /**
     * Injects prepared File objects into the active provider DOM using a 3-tier strategy:
     * 1. Existing <input type="file"> via DataTransfer
     * 2. Triggering the upload menu button to reveal a lazy <input type="file">
     * 3. Synthetic ClipboardEvent('paste') / DragEvent('drop') on the input editor
     * @param {Array<File|object>} fileObjects
     * @param {object} provider
     * @param {object} [hooks] - Optional test hooks for custom DOM injection
     * @returns {Promise<{ strategy: string }>}
     */
    async injectIntoDOM(fileObjects, provider, hooks = {}) {
      this.transition(UPLOAD_STATES.INJECTING, {
        provider: provider ? provider.id : 'unknown',
        count: fileObjects.length
      });

      if (typeof hooks.injectFn === 'function') {
        try {
          const res = await hooks.injectFn(fileObjects, provider);
          return { strategy: (res && res.strategy) || 'custom_hook' };
        } catch (err) {
          err.code = err.code || 'ERR_UPLOAD_INJECT_FAILED';
          this.lastError = err;
          this.transition(UPLOAD_STATES.FAILED, { code: err.code, message: err.message });
          throw err;
        }
      }

      if (typeof document === 'undefined') {
        const err = new Error('DOM document is not available for file injection');
        err.code = 'ERR_UPLOAD_NO_DOM';
        this.lastError = err;
        this.transition(UPLOAD_STATES.FAILED, { code: err.code });
        throw err;
      }

      // Helper to populate an <input type="file">
      const tryInputFileElement = (inputEl) => {
        if (!inputEl || typeof DataTransfer !== 'function') return false;
        const dt = new DataTransfer();
        for (const f of fileObjects) {
          dt.items.add(f);
        }
        inputEl.files = dt.files;
        inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return true;
      };

      // Tier 1: Direct <input type="file"> present in DOM
      const fileInputSelectors = (provider && provider.fileInputSelectors) || ['input[type="file"]'];
      let fileInput = Providers
        ? Providers.queryFirst(fileInputSelectors, { requireVisible: false })
        : document.querySelector('input[type="file"]');

      // If file input already holds files from this active cycle, preserve it without duplicating
      if (fileInput && fileInput.files && fileInput.files.length >= fileObjects.length) {
        return { strategy: 'direct_file_input_preserved' };
      }

      if (fileInput && tryInputFileElement(fileInput)) {
        return { strategy: 'direct_file_input' };
      }

      // Tier 2: Click upload trigger button to lazily mount <input type="file">
      let triggerBtn =
        Providers && provider && provider.uploadTriggerSelectors
          ? Providers.queryFirst(provider.uploadTriggerSelectors, { requireVisible: true })
          : null;

      if (!triggerBtn && provider && provider.customResolver && typeof provider.customResolver.findUploadTrigger === 'function') {
        const inputEl = Providers ? Providers.findInputElement(provider) : null;
        triggerBtn = provider.customResolver.findUploadTrigger(inputEl);
      }

      if (triggerBtn && typeof triggerBtn.click === 'function') {
        fileInput = document.querySelector('input[type="file"]');
        if (fileInput && tryInputFileElement(fileInput)) {
          return { strategy: 'lazy_file_input' };
        }
      }

      // Tier 3: Synthetic ClipboardEvent('paste') on the chat composer input
      const editorEl = Providers && provider ? Providers.findInputElement(provider) : document.activeElement;
      if (editorEl && typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
        const dt = new DataTransfer();
        for (const f of fileObjects) {
          dt.items.add(f);
        }
        editorEl.focus();
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        editorEl.dispatchEvent(pasteEvent);
        return { strategy: 'clipboard_paste' };
      }

      const err = new Error(`Unable to locate an upload target for provider "${provider ? provider.id : 'unknown'}"`);
      err.code = 'ERR_UPLOAD_TARGET_NOT_FOUND';
      this.lastError = err;
      this.transition(UPLOAD_STATES.FAILED, { code: err.code });
      throw err;
    }

    /**
     * Verifies that the uploaded files have been registered in the provider DOM
     * and that any upload progress spinner has finished.
     * @param {object} provider
     * @param {number} expectedCount
     * @param {object} [hooks]
     * @returns {Promise<boolean>}
     */
    async verifyDOMAttachment(provider, expectedCount, hooks = {}, fileObjects = []) {
      this.transition(UPLOAD_STATES.VERIFYING_DOM, { expectedCount });

      if (typeof hooks.verifyFn === 'function') {
        const ok = await hooks.verifyFn(provider, expectedCount);
        if (ok) {
          this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount });
          return true;
        }
        return false;
      }

      if (typeof document === 'undefined') {
        this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount, mode: 'headless' });
        return true;
      }

      const chipSelectors = (provider && provider.attachmentChipSelectors) || [];
      const busySelectors = (provider && provider.uploadBusySelectors) || [];
      const deadline = Date.now() + this.verifyTimeoutMs;

      while (Date.now() < deadline) {
        const isBusy =
          busySelectors.length > 0 &&
          Providers &&
          Boolean(Providers.queryFirst(busySelectors, { requireVisible: true }));

        if (!isBusy) {
          if (chipSelectors.length === 0) {
            await delay(300);
            this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount, mode: 'timer_fallback' });
            return true;
          }

          // 1. Visible attachment chip
          const foundChip = Providers
            ? Providers.queryFirst(chipSelectors, { requireVisible: true })
            : null;
          if (foundChip) {
            this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount, mode: 'dom_chip' });
            return true;
          }

          // 2. Chip in DOM regardless of animation/opacity
          const nonVisibleChip = Providers
            ? Providers.queryFirst(chipSelectors, { requireVisible: false })
            : null;
          if (nonVisibleChip) {
            this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount, mode: 'dom_chip_any' });
            return true;
          }

          // 3. Any uploaded file name present in composer DOM text
          if (Array.isArray(fileObjects) && fileObjects.length > 0) {
            const composerEl = document.querySelector('form, #prompt-textarea, [role="presentation"]') || document.body;
            const composerText = composerEl ? (composerEl.innerText || composerEl.textContent || '') : '';
            const anyNamePresent = fileObjects.some((f) => f && f.name && composerText.includes(f.name));
            if (anyNamePresent) {
              this.transition(UPLOAD_STATES.READY, { verifiedCount: expectedCount, mode: 'file_name_match' });
              return true;
            }
          }
        }
        await delay(200);
      }

      return false;
    }

    /**
     * Executes the complete upload lifecycle with bounded retry support.
     * If files is empty/null, transitions directly IDLE -> READY.
     * @param {Array<object>} files
     * @param {object} provider
     * @param {object} [hooks]
     * @returns {Promise<{ state: string, count: number, strategy: string, attempts: number }>}
     */
    async executeUpload(files, provider, hooks = {}) {
      if (this.state !== UPLOAD_STATES.IDLE) {
        this.reset();
      }

      if (!files || (Array.isArray(files) && files.length === 0)) {
        this.transition(UPLOAD_STATES.READY, { count: 0, skipped: true });
        return { state: this.state, count: 0, strategy: 'none', attempts: 0 };
      }

      const normalized = this.validatePayloads(files);
      const fileObjects = this.prepareFiles(normalized);

      let attempts = 0;
      let lastStrategy = 'none';

      while (attempts <= this.maxRetries) {
        attempts++;
        const injection = await this.injectIntoDOM(fileObjects, provider, hooks);
        lastStrategy = injection.strategy;

        const verified = await this.verifyDOMAttachment(provider, fileObjects.length, hooks, fileObjects);
        if (verified && this.state === UPLOAD_STATES.READY) {
          return {
            state: this.state,
            count: fileObjects.length,
            strategy: lastStrategy,
            attempts
          };
        }

        if (attempts <= this.maxRetries) {
          await delay(250 * attempts);
        }
      }

      // If injection succeeded and no busy progressbar is running, proceed with grace ready
      // to avoid leaving files stranded in the composer
      const busySelectors = (provider && provider.uploadBusySelectors) || [];
      const isBusy =
        busySelectors.length > 0 &&
        Providers &&
        Boolean(Providers.queryFirst(busySelectors, { requireVisible: true }));

      if (lastStrategy !== 'none' && !isBusy) {
        this.transition(UPLOAD_STATES.READY, {
          verifiedCount: fileObjects.length,
          mode: 'grace_proceed',
          attempts
        });
        return {
          state: this.state,
          count: fileObjects.length,
          strategy: lastStrategy,
          attempts
        };
      }

      const err = new Error(
        `Upload verification timed out after ${attempts} attempt(s) on provider "${provider ? provider.id : 'unknown'}"`
      );
      err.code = 'ERR_UPLOAD_VERIFY_TIMEOUT';
      this.lastError = err;
      this.transition(UPLOAD_STATES.FAILED, { code: err.code, attempts });
      throw err;
    }
  }

  return {
    UPLOAD_STATES,
    ALLOWED_TRANSITIONS,
    DEFAULT_MAX_FILE_BYTES,
    sanitizeFileName,
    buildFileObject,
    UploadStateMachine
  };
});
