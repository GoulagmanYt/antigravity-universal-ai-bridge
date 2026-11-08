/**
 * WebAI Bridge - Unified Content Script Entrypoint (v2.4.0-alpha.1)
 * Orchestrates modular sub-systems:
 *   - content-providers.js (Gemini, Claude, ChatGPT, DeepSeek hash-free, AI Studio)
 *   - content-upload.js (Formal UploadStateMachine: IDLE -> VALIDATING -> PREPARING -> INJECTING -> VERIFYING_DOM -> READY | FAILED)
 *   - content-core.js (Authenticated WebSocket client, STREAM_CHUNK anti-timeout emitter, DOM execution)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const providers = require('./content-providers.js');
    const upload = require('./content-upload.js');
    const core = require('./content-core.js');
    module.exports = factory(providers, upload, core);
  } else {
    root.WebAIBridge = factory(
      root.WebAIBridgeProviders,
      root.WebAIBridgeUpload,
      root.WebAIBridgeCore
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Providers, Upload, Core) {
  'use strict';

  if (!Providers || !Upload || !Core) {
    throw new Error('WebAI Bridge content modules failed to initialize');
  }

  let activeRuntime = null;

  /**
   * Backward compatibility & diagnostic helper for doctor.mjs.
   * Utilizes the formal state machine: new DataTransfer() and ClipboardEvent('paste') vectors.
   * @param {Array<object>} files
   * @param {object} [provider]
   * @returns {Promise<object>}
   */
  async function uploadAttachmentsToDOM(files, provider) {
    const p = provider || Providers.detectProvider();
    const sm = new Upload.UploadStateMachine();
    return sm.executeUpload(files, p);
  }

  /**
   * Boots the content script runtime inside a supported Web AI tab
   * and binds Chrome extension runtime messaging for live popup control.
   * @returns {object|null}
   */
  function initContentBridge() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return null;
    }

    if (window.__WEBAI_BRIDGE_INITIALIZED__ && activeRuntime) {
      return activeRuntime;
    }

    const provider = Providers.detectProvider(window.location.hostname);
    if (!provider) {
      return null;
    }

    window.__WEBAI_BRIDGE_INITIALIZED__ = true;
    activeRuntime = new Core.BridgeContentRuntime({ provider });
    activeRuntime.connect();

    // Listen for live popup configuration updates & status queries
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message !== 'object') return false;

        if (message.type === 'WEBAI_GET_TAB_STATUS') {
          sendResponse({
            ok: true,
            provider: provider.id,
            providerName: provider.name,
            connected: Boolean(activeRuntime.ws && activeRuntime.ws.readyState === 1),
            port: activeRuntime.port,
            busy: activeRuntime.isBusy,
            activeRequestId: activeRuntime.activeRequestId,
            uploadState: activeRuntime.uploadMachine.state
          });
          return true;
        }

        if (message.type === 'WEBAI_RECONFIGURE_BRIDGE') {
          activeRuntime
            .reconfigure(message.port, message.authToken)
            .then(() => {
              sendResponse({ ok: true, port: activeRuntime.port });
            })
            .catch((err) => {
              sendResponse({ ok: false, error: err.message });
            });
          return true;
        }

        return false;
      });
    }

    // Also react to chrome.storage.onChanged for instant multi-tab sync
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !activeRuntime) return;
        const newPort = changes.bridgePort ? changes.bridgePort.newValue : activeRuntime.port;
        const newToken = changes.bridgeAuthToken ? changes.bridgeAuthToken.newValue : activeRuntime.authToken;
        if (changes.bridgePort || changes.bridgeAuthToken) {
          activeRuntime.reconfigure(newPort, newToken);
        }
      });
    }

    return activeRuntime;
  }

  // Auto-start in browser environment
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initContentBridge, { once: true });
    } else {
      initContentBridge();
    }
  }

  return {
    PROVIDERS: Providers.PROVIDERS,
    detectProvider: Providers.detectProvider,
    findInputElement: Providers.findInputElement,
    findSendButton: Providers.findSendButton,
    isProviderStreaming: Providers.isProviderStreaming,
    extractCleanResponse: Providers.extractCleanResponse,
    getLatestResponseSnapshot: Providers.getLatestResponseSnapshot,
    UPLOAD_STATES: Upload.UPLOAD_STATES,
    ALLOWED_TRANSITIONS: Upload.ALLOWED_TRANSITIONS,
    UploadStateMachine: Upload.UploadStateMachine,
    uploadAttachmentsToDOM,
    sanitizeFileName: Upload.sanitizeFileName,
    buildFileObject: Upload.buildFileObject,
    DEFAULT_BRIDGE_PORT: Core.DEFAULT_BRIDGE_PORT,
    buildWebSocketUrl: Core.buildWebSocketUrl,
    injectPromptText: Core.injectPromptText,
    triggerSend: Core.triggerSend,
    captureStreamingResponse: Core.captureStreamingResponse,
    BridgeContentRuntime: Core.BridgeContentRuntime,
    initContentBridge
  };
});
