/**
 * WebAI Bridge - Content Script Core Execution & Streaming Engine
 * Manages authenticated WebSocket lifecycle, configurable port/token via chrome.storage,
 * prompt injection, real-time MutationObserver streaming chunks (STREAM_CHUNK),
 * and adaptive response stabilization.
 * Dual-environment module: Browser Content Script (window) & Node.js (CommonJS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const providersMod = require('./content-providers.js');
    const uploadMod = require('./content-upload.js');
    module.exports = factory(providersMod, uploadMod);
  } else {
    root.WebAIBridgeCore = factory(root.WebAIBridgeProviders, root.WebAIBridgeUpload);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Providers, Upload) {
  'use strict';

  const DEFAULT_BRIDGE_PORT = 8765;
  const STREAM_TICK_MS = 1200;
  const STABILIZE_QUIET_MS = 4500;
  const MAX_GENERATION_WAIT_MS = 600000; // 10 minutes max generation in tab

  /**
   * Sleeps for a given number of milliseconds.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Reads bridge connection settings (port & authToken) from chrome.storage.local
   * with safe defaults when running in tests or without storage permissions.
   * @returns {Promise<{ port: number, authToken: string, autoConnect: boolean }>}
   */
  async function loadBridgeConfig() {
    const defaults = {
      port: DEFAULT_BRIDGE_PORT,
      authToken: '',
      autoConnect: true,
      debugMode: false
    };

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(['bridgePort', 'bridgeAuthToken', 'bridgeAutoConnect', 'debugMode'], (items) => {
            if (chrome.runtime && chrome.runtime.lastError) {
              resolve(defaults);
              return;
            }
            const parsedPort = Number(items && items.bridgePort);
            resolve({
              port: Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
                ? parsedPort
                : DEFAULT_BRIDGE_PORT,
              authToken: typeof (items && items.bridgeAuthToken) === 'string' ? items.bridgeAuthToken.trim() : '',
              autoConnect: items && items.bridgeAutoConnect !== undefined ? Boolean(items.bridgeAutoConnect) : true,
              debugMode: Boolean(items && items.debugMode)
            });
          });
        } catch (_) {
          resolve(defaults);
        }
      });
    }

    return defaults;
  }

  /**
   * Builds the WebSocket endpoint URL for the configured port and session token.
   * @param {number} port
   * @param {string} [authToken]
   * @returns {string}
   */
  function buildWebSocketUrl(port, authToken) {
    const validPort = Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535
      ? Number(port)
      : DEFAULT_BRIDGE_PORT;
    const base = `ws://127.0.0.1:${validPort}`;
    if (authToken && typeof authToken === 'string' && authToken.trim().length > 0) {
      return `${base}/?token=${encodeURIComponent(authToken.trim())}`;
    }
    return base;
  }

  /**
   * Injects prompt text into either a <textarea> or a contenteditable element
   * while firing React/ProseMirror/Quill compatible input events.
   * @param {Element} inputEl
   * @param {string} promptText
   * @param {object} [options]
   */
  function injectPromptText(inputEl, promptText, options = {}) {
    const logger = options.logger || ((_c, _l, _m, _d) => {});
    if (!inputEl) {
      logger('INPUT', 'error', 'Cannot inject prompt: input element is null');
      throw new Error('Cannot inject prompt: input element is null');
    }

    inputEl.focus();
    const tag = (inputEl.tagName || '').toLowerCase();
    logger('INPUT', 'debug', `Injecting prompt into <${tag}>`, { textLength: promptText.length });

    if (tag === 'textarea' || tag === 'input') {
      if (typeof inputEl.select === 'function') {
        inputEl.select();
      }

      let inserted = false;
      if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
        try {
          inserted = document.execCommand('insertText', false, promptText);
          logger('INPUT', 'debug', `execCommand('insertText') result: ${inserted}`);
        } catch (_) {
          inserted = false;
        }
      }

      if (!inserted || inputEl.value !== promptText) {
        if (inputEl._valueTracker && typeof inputEl._valueTracker.setValue === 'function') {
          inputEl._valueTracker.setValue('');
        }
        const proto = tag === 'textarea'
          ? (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : null)
          : (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null);
        const nativeSetter =
          proto && Object.getOwnPropertyDescriptor(proto, 'value')
            ? Object.getOwnPropertyDescriptor(proto, 'value').set
            : null;

        if (nativeSetter) {
          nativeSetter.call(inputEl, promptText);
          logger('INPUT', 'debug', 'nativeSetter called on prototype');
        } else {
          inputEl.value = promptText;
        }
      }

      if (typeof InputEvent === 'function') {
        try {
          inputEl.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            composed: true,
            inputType: 'insertText',
            data: promptText
          }));
        } catch (_) {}
      }
      inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      const parentArea = inputEl.closest ? inputEl.closest('.input-area-container, .initial-input-area-container, .initial-input-area, rich-textarea') : null;
      if (parentArea) {
        parentArea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        parentArea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
      logger('INPUT', 'debug', 'Events input & change dispatched on input element', { finalValueLength: (inputEl.value || '').length });
      return;
    }

    // Modern ProseMirror direct access (ChatGPT / Claude)
    try {
      const pmView = inputEl.pmViewDesc?.view || inputEl.__vue__?.editorView;
      if (pmView && pmView.state && pmView.dispatch) {
        const { state, dispatch } = pmView;
        const tr = state.tr.replaceWith(0, state.doc.content.size, state.schema.text(promptText));
        dispatch(tr);
        inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        return;
      }
    } catch (_) {}

    // Direct Quill & rich-textarea instance access (Google Gemini)
    try {
      const rich = inputEl.closest ? inputEl.closest('rich-textarea') : null;
      const quill = inputEl.__quill ||
                    inputEl.parentElement?.__quill ||
                    rich?.__quill ||
                    rich?.quill ||
                    (typeof window !== 'undefined' && window.Quill?.find?.(inputEl));
      if (quill && typeof quill.setText === 'function') {
        quill.setText(promptText);
        if (typeof quill.update === 'function') quill.update();
        inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        if (rich) {
          rich.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          rich.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
        return;
      }
    } catch (_) {}

    // Synthetic ClipboardEvent('paste') with DataTransfer (ProseMirror & Lexical native handling)
    let pasted = false;
    try {
      if (typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
        const dt = new DataTransfer();
        dt.setData('text/plain', promptText);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dt
        });
        Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
        inputEl.dispatchEvent(pasteEvent);
        if ((inputEl.textContent || inputEl.innerText || '').trim().length > 0) {
          pasted = true;
        }
      }
    } catch (_) {}

    if (pasted) {
      inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return;
    }

    // Fallback: execCommand with Selection
    if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
      try {
        if (typeof inputEl.focus === 'function') inputEl.focus();
        const selection = window.getSelection ? window.getSelection() : null;
        if (selection && document.createRange) {
          const range = document.createRange();
          range.selectNodeContents(inputEl);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const inserted = document.execCommand('insertText', false, promptText);
        if (inserted && (inputEl.textContent || inputEl.innerText || '').trim().length > 0) {
          inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: promptText, inputType: 'insertText' }));
          inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          const rich = inputEl.closest ? inputEl.closest('rich-textarea') : null;
          if (rich) {
            rich.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            rich.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
          return;
        }
      } catch (_) {}
    }

    // Fallback paragraph population for ProseMirror / Quill
    inputEl.innerHTML = '';
    const lines = String(promptText).split('\n');
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line || '\u200B';
      inputEl.appendChild(p);
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }

  function isButtonDisabled(btn) {
    if (!btn) return true;
    if (btn.disabled || btn.hasAttribute('disabled')) return true;
    if (btn.getAttribute('aria-disabled') === 'true') return true;
    const classList = btn.classList;
    if (classList) {
      if (classList.contains('disabled') || classList.contains('ds-button--disabled')) return true;
      for (const cls of classList) {
        if (typeof cls === 'string' && cls.toLowerCase().includes('disabled')) return true;
      }
    }
    return false;
  }

  /**
   * Triggers prompt submission via the provider's send button or Enter key event.
   * Dispatches pointerdown, mousedown, mouseup, click, and keyboard Enter for maximum SPA compatibility.
   * @param {object} provider
   * @param {Element} inputEl
   * @param {object} [options]
   * @returns {Promise<string>} Method used ('button_click' | 'enter_key')
   */
  async function triggerSend(provider, inputEl, options = {}) {
    const logger = options.logger || ((_c, _l, _m, _d) => {});
    const maxWaitMs = options.hasFiles ? 15000 : 6000;
    const deadline = Date.now() + maxWaitMs;
    logger('SEND', 'debug', 'triggerSend loop initialized', { maxWaitMs, hasFiles: Boolean(options.hasFiles) });

    let sendBtn = null;
    let anyCandidate = null;
    let ticks = 0;
    while (Date.now() < deadline) {
      ticks++;
      const candidate = Providers.findSendButton(provider, inputEl);
      if (candidate) {
        anyCandidate = candidate;
        const disabled = isButtonDisabled(candidate);
        const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(candidate) : null;
        if (ticks % 4 === 1) {
          logger('SEND', 'debug', `Poll tick #${ticks}: Candidate found`, {
            tag: candidate.tagName,
            classes: Array.from(candidate.classList || []).join(' '),
            disabled,
            display: style?.display,
            visibility: style?.visibility,
            opacity: style?.opacity
          });
        }
        if (!disabled) {
          if (!style || (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.2)) {
            sendBtn = candidate;
            logger('SEND', 'info', 'Active send button verified and enabled', {
              tag: sendBtn.tagName,
              classes: Array.from(sendBtn.classList || []).join(' ')
            });
            break;
          }
        }
      }
      await sleep(150);
    }

    // Follow-up fallback: If candidate exists but aria-disabled is lingering, and the input has content, force enable & click!
    if (!sendBtn && anyCandidate) {
      const hasContent = (inputEl && (inputEl.value || inputEl.textContent || inputEl.innerText || '').trim().length > 0);
      logger('SEND', 'warn', 'Send button remained disabled after polling timeout, checking force-enable fallback', {
        hasContent,
        candidateTag: anyCandidate.tagName,
        candidateClasses: Array.from(anyCandidate.classList || []).join(' ')
      });
      if (hasContent) {
        try {
          anyCandidate.removeAttribute('disabled');
          anyCandidate.removeAttribute('aria-disabled');
          anyCandidate.setAttribute('aria-disabled', 'false');
          anyCandidate.classList.remove('disabled');
          if (anyCandidate.style) {
            anyCandidate.style.display = 'inline-flex';
            anyCandidate.style.visibility = 'visible';
            anyCandidate.style.opacity = '1';
          }
          logger('SEND', 'warn', 'Force-enabled candidate button attributes');
        } catch (_) {}
        sendBtn = anyCandidate;
      }
    }

    await sleep(250);

    let sendMethod = null;
    if (sendBtn && typeof sendBtn.click === 'function') {
      try {
        logger('SEND', 'info', 'Dispatched sendBtn.click()', {
          tag: sendBtn.tagName,
          classes: Array.from(sendBtn.classList || []).join(' ')
        });
        sendBtn.click();
        sendMethod = 'button_click';
      } catch (clickErr) {
        logger('SEND', 'warn', 'sendBtn.click() failed, attempting MouseEvent fallback', { error: clickErr.message });
        try {
          const evtView = typeof window !== 'undefined' ? window : null;
          sendBtn.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: evtView
          }));
          sendMethod = 'button_click';
        } catch (_) {}
      }
    }

    // Only fallback to Enter key if no send button was located or clicked (avoids double submission)
    if (!sendMethod && inputEl && typeof KeyboardEvent === 'function') {
      logger('SEND', 'info', 'No send button clicked, evaluating Enter key fallback');
      try {
        if (typeof inputEl.focus === 'function') inputEl.focus();
        const keyOpts = {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          composed: true
        };
        inputEl.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
        inputEl.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
        inputEl.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
        sendMethod = 'enter_key';
        logger('SEND', 'info', 'Dispatched Enter keyboard events');
      } catch (_) {}
    }

    if (sendMethod) return sendMethod;
    logger('SEND', 'error', 'Could not locate or trigger send');
    throw new Error(`Could not locate send trigger for provider "${provider ? provider.id : 'unknown'}"`);
  }

  /**
   * Observes the DOM for streaming response chunks and emits progressive updates via `onProgress`
   * until the response stabilizes and streaming indicators disappear.
   * @param {object} params
   * @param {object} params.provider
   * @param {Element} params.inputEl
   * @param {string} params.baselineText
   * @param {number} params.baselineCount
   * @param {Function} [params.onProgress]
   * @param {number} [params.maxWaitMs]
   * @returns {Promise<{ text: string, elapsedMs: number, chunksEmitted: number }>}
   */
  async function captureStreamingResponse(params) {
    const {
      provider,
      inputEl,
      baselineText = '',
      baselineCount = 0,
      onProgress,
      logger = ((_c, _l, _m, _d) => {}),
      maxWaitMs = MAX_GENERATION_WAIT_MS
    } = params;

    const startTime = Date.now();
    let lastText = '';
    let lastChangeTime = Date.now();
    let hasStarted = false;
    let chunksEmitted = 0;
    let mutationDirty = false;
    logger('STREAM', 'info', 'Streaming observer started', { baselineCount, baselineLength: baselineText.length });

    let observer = null;
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body) {
      observer = new MutationObserver(() => {
        mutationDirty = true;
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    try {
      while (Date.now() - startTime < maxWaitMs) {
        const snapshot = Providers.getLatestResponseSnapshot(provider);
        const streaming = Providers.isProviderStreaming(provider, inputEl);
        const isNewTurn =
          snapshot.count > baselineCount ||
          (snapshot.text.length > 0 && snapshot.text !== baselineText);

        if (streaming || snapshot.isThinking || isNewTurn) {
          if (!hasStarted) {
            hasStarted = true;
            logger('STREAM', 'info', 'Generation start detected in DOM', {
              isStreaming: streaming,
              isThinking: snapshot.isThinking,
              isNewTurn
            });
          }
        }

        if (hasStarted && isNewTurn && snapshot.text && snapshot.text !== lastText) {
          const deltaLength = snapshot.text.length - lastText.length;
          lastText = snapshot.text;
          lastChangeTime = Date.now();
          chunksEmitted++;
          if (chunksEmitted === 1 || chunksEmitted % 5 === 0) {
            logger('STREAM', 'debug', `Stream chunk #${chunksEmitted} received`, {
              deltaLength,
              totalLength: lastText.length,
              elapsedMs: Date.now() - startTime
            });
          }

          if (typeof onProgress === 'function') {
            try {
              onProgress({
                fullText: lastText,
                deltaLength,
                chunksEmitted,
                isThinking: snapshot.isThinking,
                isStreaming: streaming,
                elapsedMs: Date.now() - startTime
              });
            } catch (_) {
              // Ignore callback errors
            }
          }
        } else if (hasStarted && typeof onProgress === 'function' && mutationDirty) {
          // Heartbeat ping while thinking (e.g. DeepSeek R1 / Gemini Thinking) before text changes
          mutationDirty = false;
          try {
            onProgress({
              fullText: lastText,
              deltaLength: 0,
              chunksEmitted,
              isThinking: snapshot.isThinking,
              isStreaming: streaming,
              elapsedMs: Date.now() - startTime
            });
          } catch (_) {
            // Ignore callback errors
          }
        }

        const quietDuration = Date.now() - lastChangeTime;
        if (
          hasStarted &&
          lastText.length > 0 &&
          !streaming &&
          !snapshot.isThinking &&
          quietDuration >= STABILIZE_QUIET_MS
        ) {
          logger('STREAM', 'info', 'Generation completed and stabilized', {
            totalLength: lastText.length,
            elapsedMs: Date.now() - startTime,
            chunksEmitted
          });
          return {
            text: lastText,
            elapsedMs: Date.now() - startTime,
            chunksEmitted
          };
        }

        await sleep(STREAM_TICK_MS);
      }

      if (lastText.length > 0) {
        return {
          text: lastText,
          elapsedMs: Date.now() - startTime,
          chunksEmitted,
          timedOutWithPartial: true
        };
      }

      const err = new Error(`Response capture timed out after ${maxWaitMs}ms on ${provider ? provider.id : 'unknown'}`);
      err.code = 'ERR_RESPONSE_CAPTURE_TIMEOUT';
      throw err;
    } finally {
      if (observer) {
        observer.disconnect();
      }
    }
  }

  /**
   * Performs a comprehensive, live DOM inspection of the active Web AI tab.
   * Extracts input element state, send/stop button states, computed styles,
   * visible error banners, composer snippet, and custom selector queries.
   * @param {BridgeContentRuntime} runtime
   * @param {object} [options]
   * @returns {object}
   */
  function collectTabDiagnostics(runtime, options = {}) {
    const doc = (typeof document !== 'undefined' ? document : null);
    const win = (typeof window !== 'undefined' ? window : null);
    const provider = runtime ? runtime.provider : Providers.detectProvider();

    const result = {
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      provider: provider ? { id: provider.id, name: provider.name } : null,
      tab: {
        url: win && win.location ? win.location.href : '',
        title: doc ? doc.title : '',
        readyState: doc ? doc.readyState : 'unknown',
        isBusy: runtime ? runtime.isBusy : false,
        activeRequestId: runtime ? runtime.activeRequestId : null,
        debugMode: runtime ? runtime.debugMode : false
      },
      input: null,
      sendButton: null,
      stopButton: null,
      streaming: false,
      notifications: [],
      composerSnippet: '',
      matchedElements: [],
      debugLogs: []
    };

    if (!doc) return result;

    // 1. Input element diagnosis
    try {
      const inputEl = Providers.findInputElement(provider);
      if (inputEl) {
        const style = win && win.getComputedStyle ? win.getComputedStyle(inputEl) : null;
        result.input = {
          found: true,
          tag: inputEl.tagName.toLowerCase(),
          id: inputEl.id || null,
          name: inputEl.getAttribute('name') || null,
          placeholder: inputEl.getAttribute('placeholder') || null,
          classes: Array.from(inputEl.classList || []),
          disabled: Boolean(inputEl.disabled || inputEl.hasAttribute('disabled')),
          readOnly: Boolean(inputEl.readOnly || inputEl.hasAttribute('readonly')),
          valueLength: (inputEl.value || inputEl.textContent || '').length,
          valueSnippet: (inputEl.value || inputEl.textContent || '').slice(0, 200),
          isFocused: doc.activeElement === inputEl,
          style: style ? {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity
          } : null
        };
      } else {
        result.input = { found: false };
      }
    } catch (e) {
      result.input = { found: false, error: e.message };
    }

    // 2. Send button diagnosis
    try {
      const effectiveInput = Providers.findInputElement(provider);
      const sendBtn = Providers.findSendButton(provider, effectiveInput);
      if (sendBtn) {
        const style = win && win.getComputedStyle ? win.getComputedStyle(sendBtn) : null;
        result.sendButton = {
          found: true,
          tag: sendBtn.tagName.toLowerCase(),
          id: sendBtn.id || null,
          classes: Array.from(sendBtn.classList || []),
          disabled: isButtonDisabled(sendBtn),
          ariaDisabled: sendBtn.getAttribute('aria-disabled'),
          ariaLabel: sendBtn.getAttribute('aria-label') || sendBtn.getAttribute('title') || null,
          outerHtmlSnippet: sendBtn.outerHTML ? sendBtn.outerHTML.slice(0, 400) : '',
          style: style ? {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity
          } : null
        };
      } else {
        result.sendButton = { found: false };
      }
    } catch (e) {
      result.sendButton = { found: false, error: e.message };
    }

    // 3. Stop button & streaming
    try {
      result.streaming = Providers.isProviderStreaming(provider);
      const effectiveInput = Providers.findInputElement(provider);
      const stopBtn = (provider && provider.customResolver && provider.customResolver.findStopButton)
        ? provider.customResolver.findStopButton(effectiveInput)
        : null;
      if (stopBtn) {
        result.stopButton = {
          found: true,
          tag: stopBtn.tagName.toLowerCase(),
          classes: Array.from(stopBtn.classList || []),
          outerHtmlSnippet: stopBtn.outerHTML ? stopBtn.outerHTML.slice(0, 300) : ''
        };
      }
    } catch (_) {}

    // 4. Notifications & visible error banners in DOM
    try {
      const errorCandidates = Array.from(
        doc.querySelectorAll(
          '[class*="warning"], [class*="error"], [class*="notification"], [class*="alert"], .ds-notification, [role="alert"]'
        )
      );
      for (const el of errorCandidates) {
        if (!el || typeof el.getBoundingClientRect !== 'function') continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length < 3 || text.length > 500) continue;
        const style = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) continue;
        result.notifications.push({
          tag: el.tagName.toLowerCase(),
          classes: Array.from(el.classList || []).join(' '),
          text: text.slice(0, 250)
        });
      }
    } catch (_) {}

    // 5. Custom selector query if requested
    if (options && options.selector && typeof options.selector === 'string') {
      try {
        const matches = Array.from(doc.querySelectorAll(options.selector)).slice(0, 15);
        result.matchedElements = matches.map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          classes: Array.from(el.classList || []).join(' '),
          ariaLabel: el.getAttribute('aria-label') || null,
          textSnippet: (el.textContent || '').trim().slice(0, 150),
          outerHtmlSnippet: el.outerHTML ? el.outerHTML.slice(0, 350) : ''
        }));
      } catch (err) {
        result.matchedElements = [{ error: `Invalid selector "${options.selector}": ${err.message}` }];
      }
    }

    // 6. Composer HTML snippet
    try {
      const inputEl = Providers.findInputElement(provider);
      const composer = inputEl
        ? (inputEl.closest('form, [class*="input"], [class*="composer"], .aaff8b8f, ._77cefa5') || inputEl.parentElement)
        : null;
      if (composer && composer.outerHTML) {
        result.composerSnippet = composer.outerHTML.slice(0, 2500);
      }
    } catch (_) {}

    // 7. Recent debug logs
    if (runtime && Array.isArray(runtime.debugLogs)) {
      const limit = Number.isInteger(options.limitLogs) ? options.limitLogs : 50;
      result.debugLogs = runtime.debugLogs.slice(-limit);
    }

    return result;
  }

  /**
   * Main Bridge Client Controller running inside the Web AI tab.
   */
  class BridgeContentRuntime {
    constructor(options = {}) {
      this.provider = options.provider || Providers.detectProvider();
      this.uploadMachine = new Upload.UploadStateMachine();
      this.ws = null;
      this.port = options.port || DEFAULT_BRIDGE_PORT;
      this.authToken = options.authToken || '';
      this.sessionSecret = null;
      this.isBusy = false;
      this.activeRequestId = null;
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;
      this.heartbeatTimer = null;
      this.debugMode = Boolean(options.debugMode);
      this.debugLogs = [];
      this.maxLogs = 500;
    }

    /**
     * Toggles debug mode and synchronizes with global window state.
     * @param {boolean} enabled
     */
    setDebugMode(enabled) {
      this.debugMode = Boolean(enabled);
      this.log('SYSTEM', 'info', `Debug mode set to ${this.debugMode}`);
      if (typeof window !== 'undefined') {
        window.__WEBAI_BRIDGE_DEBUG__ = this.debugMode;
      }
    }

    /**
     * Appends a log entry to the in-memory circular ring buffer and outputs to console if debug is active.
     * @param {string} category
     * @param {'info'|'warn'|'error'|'debug'} level
     * @param {string} message
     * @param {any} [details]
     */
    log(category, level = 'info', message = '', details = null) {
      const entry = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        category: String(category || 'GENERAL').toUpperCase(),
        level: level || 'info',
        message: String(message || ''),
        details: (details !== null && details !== undefined)
          ? (typeof details === 'object' ? JSON.parse(JSON.stringify(details)) : details)
          : undefined
      };
      this.debugLogs.push(entry);
      if (this.debugLogs.length > this.maxLogs) {
        this.debugLogs.shift();
      }
      if (this.debugMode || (typeof window !== 'undefined' && window.__WEBAI_BRIDGE_DEBUG__)) {
        const prefix = `[WebAI Bridge:${entry.category}]`;
        const logFn = (console[level] && typeof console[level] === 'function') ? console[level] : console.log;
        if (entry.details !== undefined) {
          logFn(prefix, message, entry.details);
        } else {
          logFn(prefix, message);
        }
      }
    }

    /**
     * Returns the latest recorded debug logs.
     * @param {number} [limit=100]
     * @returns {Array<object>}
     */
    getDebugLogs(limit = 100) {
      return this.debugLogs.slice(-limit);
    }

    /**
     * Clears all debug logs in memory.
     */
    clearDebugLogs() {
      this.debugLogs = [];
      this.log('SYSTEM', 'info', 'Debug logs buffer cleared');
    }

    /**
     * Sends a JSON payload over the active WebSocket if open.
     * @param {object} payload
     * @returns {boolean}
     */
    sendWs(payload) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      try {
        const enriched = {
          ...payload,
          provider: this.provider ? this.provider.id : 'unknown',
          timestamp: Date.now()
        };
        if (this.sessionSecret) {
          enriched.sessionSecret = this.sessionSecret;
        } else if (this.authToken) {
          enriched.authToken = this.authToken;
        }
        this.ws.send(JSON.stringify(enriched));
        return true;
      } catch (_) {
        return false;
      }
    }

    /**
     * Connects to the local MCP WebSocket server using the configured port and auth token.
     */
    async connect() {
      if (!this.provider) return;
      if (typeof WebSocket === 'undefined') return;

      const config = await loadBridgeConfig();
      this.port = config.port;
      this.authToken = config.authToken;

      if (!config.autoConnect) return;

      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
        return;
      }

      const wsUrl = buildWebSocketUrl(this.port, this.authToken);
      try {
        this.ws = new WebSocket(wsUrl);
      } catch (_) {
        this.scheduleReconnect();
        return;
      }

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.sendWs({
          type: 'AUTH_HELLO',
          role: 'content_script',
          provider: this.provider.id,
          url: typeof window !== 'undefined' && window.location ? window.location.href : '',
          title: typeof document !== 'undefined' ? document.title : '',
          authToken: this.authToken
        });
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        this.handleServerMessage(msg);
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.sessionSecret = null;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // Error is followed by onclose which schedules reconnect
      };
    }

    startHeartbeat() {
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        this.sendWs({
          type: 'HEARTBEAT',
          busy: this.isBusy,
          activeRequestId: this.activeRequestId
        });
      }, 15000);
    }

    stopHeartbeat() {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }

    scheduleReconnect() {
      if (this.reconnectTimer) return;
      const backoff = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, backoff);
    }

    /**
     * Reconnects immediately when port or authToken changes in popup.
     * @param {number} newPort
     * @param {string} newToken
     * @param {boolean} [newDebugMode]
     */
    async reconfigure(newPort, newToken, newDebugMode) {
      if (newPort) this.port = Number(newPort) || DEFAULT_BRIDGE_PORT;
      if (typeof newToken === 'string') this.authToken = newToken.trim();
      if (newDebugMode !== undefined) this.setDebugMode(newDebugMode);
      if (this.ws) {
        try {
          this.ws.close();
        } catch (_) {
          // Ignore
        }
        this.ws = null;
      }
      await this.connect();
    }

    /**
     * Handles incoming messages from the MCP server.
     * @param {object} msg
     */
    async handleServerMessage(msg) {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'AUTH_OK') {
        if (msg.sessionSecret) {
          this.sessionSecret = msg.sessionSecret;
        }
        return;
      }

      if (msg.type === 'inspect_tab' || msg.type === 'INSPECT_PAGE' || msg.type === 'GET_DIAGNOSTICS') {
        this.log('DIAGNOSTIC', 'info', 'Executing inspect_tab diagnostic', { selector: msg.selector || msg.payload?.selector });
        const diagnostics = collectTabDiagnostics(this, msg.payload || msg);
        this.sendWs({
          id: msg.id || msg.requestId || null,
          type: 'inspect_tab_response',
          requestId: msg.requestId || msg.id || null,
          payload: diagnostics
        });
        return;
      }

      if (msg.type === 'GET_DEBUG_LOGS') {
        const limit = Number(msg.limit || msg.payload?.limit || 100);
        this.sendWs({
          id: msg.id || msg.requestId || null,
          type: 'debug_logs_response',
          requestId: msg.requestId || msg.id || null,
          payload: { logs: this.getDebugLogs(limit) }
        });
        return;
      }

      if (msg.type === 'CLEAR_DEBUG_LOGS') {
        this.clearDebugLogs();
        this.sendWs({
          id: msg.id || msg.requestId || null,
          type: 'clear_logs_response',
          requestId: msg.requestId || msg.id || null,
          payload: { ok: true }
        });
        return;
      }

      if (msg.type === 'PING' || msg.type === 'STATUS_CHECK' || msg.type === 'check_session') {
        const snapshot = Providers.getLatestResponseSnapshot(this.provider);
        this.sendWs({
          id: msg.id || msg.requestId || null,
          type: msg.type === 'check_session' ? 'check_session' : 'PONG',
          requestId: msg.requestId || msg.id || null,
          busy: this.isBusy,
          activeRequestId: this.activeRequestId,
          uploadState: this.uploadMachine.state,
          payload: {
            provider: this.provider ? this.provider.name : 'unknown',
            providerId: this.provider ? this.provider.id : 'unknown',
            isEmptyChat: snapshot.count === 0,
            chatKey: typeof window !== 'undefined' && window.location ? window.location.href : 'unknown',
            debugMode: this.debugMode,
            logCount: this.debugLogs.length,
            domDiagnostic: {
              lastResponseSnippet: snapshot.text.slice(0, 500),
              lastResponseFull: snapshot.text
            }
          }
        });
        return;
      }

      if (msg.type === 'EXECUTE_PROMPT' || msg.type === 'CONSULT_ORCHESTRATOR' || msg.type === 'prompt') {
        const task = Object.assign({}, msg.payload, msg);
        await this.executePromptTask(task);
      }
    }

    /**
     * Executes a full prompt + optional file upload cycle and streams chunks back to the server.
     * @param {object} task
     */
    async executePromptTask(task) {
      const requestId = task.requestId || task.jobId || task.id || `req_${Date.now()}`;
      this.log('TASK', 'info', `Executing prompt task ${requestId}`, { promptLength: (task.prompt || '').length });

      if (this.isBusy) {
        this.log('TASK', 'warn', `Tab is already executing request ${this.activeRequestId}, rejecting ${requestId}`);
        this.sendWs({
          id: requestId,
          type: 'ERROR',
          requestId,
          code: 'ERR_TAB_BUSY',
          message: `Tab is already executing request ${this.activeRequestId}`
        });
        return;
      }

      this.isBusy = true;
      this.activeRequestId = requestId;

      try {
        const inputEl = Providers.findInputElement(this.provider);
        if (!inputEl) {
          this.log('INPUT', 'error', `Prompt input element not found on ${this.provider?.name}`);
          const err = new Error(`Prompt input element not found on ${this.provider.name}`);
          err.code = 'ERR_INPUT_NOT_FOUND';
          throw err;
        }

        const baseline = Providers.getLatestResponseSnapshot(this.provider);

        // Step 1: Formal file upload state machine
        const files = Array.isArray(task.files)
          ? task.files
          : (Array.isArray(task.attachments) ? task.attachments : []);

        if (files.length > 0) {
          this.log('UPLOAD', 'info', `Starting upload of ${files.length} attachments`);
          this.sendWs({
            id: requestId,
            type: 'UPLOAD_PROGRESS',
            requestId,
            state: Upload.UPLOAD_STATES.VALIDATING,
            count: files.length
          });
          await this.uploadMachine.executeUpload(files, this.provider);
          this.sendWs({
            id: requestId,
            type: 'UPLOAD_PROGRESS',
            requestId,
            state: Upload.UPLOAD_STATES.READY,
            count: files.length
          });
        }

        // Step 2: Inject prompt and trigger send
        this.log('INPUT', 'debug', 'Injecting prompt text into DOM input');
        injectPromptText(inputEl, task.prompt || '', {
          logger: (c, l, m, d) => this.log(c, l, m, d)
        });
        const sendMethod = await triggerSend(this.provider, inputEl, {
          hasFiles: files.length > 0,
          logger: (c, l, m, d) => this.log(c, l, m, d)
        });
        this.log('SEND', 'info', `Prompt dispatched using ${sendMethod}`);

        this.sendWs({
          id: requestId,
          type: 'PROMPT_DISPATCHED',
          requestId,
          sendMethod
        });

        // Step 3: Stream intermediate chunks back to prevent 180s client timeouts
        const result = await captureStreamingResponse({
          provider: this.provider,
          inputEl,
          baselineText: baseline.text,
          baselineCount: baseline.count,
          logger: (c, l, m, d) => this.log(c, l, m, d),
          maxWaitMs: task.maxWaitMs || MAX_GENERATION_WAIT_MS,
          onProgress: (progress) => {
            this.sendWs({
              id: requestId,
              type: 'STREAM_CHUNK',
              requestId,
              jobId: requestId,
              fullText: progress.fullText,
              deltaLength: progress.deltaLength,
              chunksEmitted: progress.chunksEmitted,
              isThinking: progress.isThinking,
              isStreaming: progress.isStreaming,
              elapsedMs: progress.elapsedMs
            });
          }
        });

        this.log('STREAM', 'info', `Response captured successfully in ${result.elapsedMs}ms`, {
          chars: result.text.length,
          chunks: result.chunksEmitted
        });

        this.sendWs({
          id: requestId,
          type: 'RESPONSE_COMPLETE',
          requestId,
          jobId: requestId,
          text: result.text,
          response: result.text,
          payload: { reply: result.text },
          reply: result.text,
          elapsedMs: result.elapsedMs,
          chunksEmitted: result.chunksEmitted
        });
      } catch (err) {
        this.log('ERROR', 'error', `Task execution failed: ${err.message}`, { code: err.code });
        this.sendWs({
          id: requestId,
          type: 'ERROR',
          requestId,
          jobId: requestId,
          code: err.code || 'ERR_EXECUTION_FAILED',
          message: err.message || String(err),
          uploadState: this.uploadMachine.state
        });
      } finally {
        this.uploadMachine.reset();
        this.isBusy = false;
        this.activeRequestId = null;
      }
    }
  }

  return {
    DEFAULT_BRIDGE_PORT,
    STREAM_TICK_MS,
    STABILIZE_QUIET_MS,
    MAX_GENERATION_WAIT_MS,
    loadBridgeConfig,
    buildWebSocketUrl,
    injectPromptText,
    triggerSend,
    captureStreamingResponse,
    collectTabDiagnostics,
    BridgeContentRuntime
  };
});
