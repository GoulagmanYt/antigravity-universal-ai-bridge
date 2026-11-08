/**
 * WebAI Bridge - Declarative Provider Registry & DOM Extraction Helpers
 * Supports: Gemini, Claude, ChatGPT, DeepSeek (hash-free selectors), Google AI Studio.
 * Dual-environment module: Browser Content Script (window) & Node.js (CommonJS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WebAIBridgeProviders = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Checks whether an element is visible and interactive in the DOM.
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isVisibleElement(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Finds the first matching DOM element across an ordered list of CSS selectors.
   * @param {string[]} selectors
   * @param {object} [options]
   * @param {boolean} [options.requireVisible=true]
   * @param {ParentNode} [options.rootNode]
   * @returns {Element|null}
   */
  function queryFirst(selectors, options = {}) {
    const requireVisible = options.requireVisible !== false;
    const rootNode = options.rootNode || (typeof document !== 'undefined' ? document : null);
    if (!rootNode || !Array.isArray(selectors)) return null;

    for (const selector of selectors) {
      if (!selector || typeof selector !== 'string') continue;
      let nodes;
      try {
        nodes = rootNode.querySelectorAll(selector);
      } catch (_) {
        continue;
      }
      for (const node of nodes) {
        if (!requireVisible || isVisibleElement(node)) {
          return node;
        }
      }
    }
    return null;
  }

  /**
   * Structural fallback for DeepSeek and modern SPA chatboxes where action buttons
   * use unlabelled div[role="button"] elements with SVG icons instead of stable classes.
   * @param {Element|null} inputEl
   * @param {'send'|'stop'|'upload'} roleType
   * @returns {Element|null}
   */
  function findDeepSeekActionElement(inputEl, roleType) {
    if (typeof document === 'undefined') return null;

    const composerRoot =
      (inputEl && (inputEl.closest('form') || inputEl.closest('[role="group"]') || inputEl.parentElement?.parentElement?.parentElement)) ||
      document.body;

    if (!composerRoot) return null;

    const candidates = Array.from(
      composerRoot.querySelectorAll('button, div[role="button"], span[role="button"], label[role="button"]')
    ).filter((el) => {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      return Boolean(el.querySelector('svg'));
    });

    if (candidates.length === 0) return null;

    if (roleType === 'upload') {
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        const labelParent = fileInput.closest('label, div[role="button"], button');
        if (labelParent) return labelParent;
      }
      return candidates[0] || null;
    }

    if (roleType === 'stop') {
      for (let i = candidates.length - 1; i >= 0; i--) {
        const btn = candidates[i];
        const ariaLabel = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
        if (ariaLabel.includes('stop') || ariaLabel.includes('arrêter') || ariaLabel.includes('cancel')) {
          return btn;
        }
        const rectSvg = btn.querySelector('svg rect');
        const pathSvg = btn.querySelectorAll('svg path');
        if (rectSvg && pathSvg.length <= 1) {
          return btn;
        }
      }
      return null;
    }

    if (roleType === 'send') {
      for (let i = candidates.length - 1; i >= 0; i--) {
        const btn = candidates[i];
        const disabled =
          btn.disabled ||
          btn.getAttribute('aria-disabled') === 'true' ||
          btn.hasAttribute('disabled');
        if (!disabled && isVisibleElement(btn)) {
          return btn;
        }
      }
    }

    return null;
  }

  /**
   * Declarative Provider Registry.
   * Note: DeepSeek uses zero hashed CSS classes; only semantic IDs, ARIA attributes,
   * stable component prefixes ([class*="ds-markdown"]), and structural traversal.
   */
  const PROVIDERS = {
    gemini: {
      id: 'gemini',
      name: 'Google Gemini',
      hostPatterns: [/(^|\.)gemini\.google\.com$/i],
      inputSelectors: [
        'rich-textarea div.ql-editor[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][aria-label*="prompt" i]',
        'div[contenteditable="true"][aria-label*="message" i]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea[aria-label*="prompt" i]'
      ],
      sendButtonSelectors: [
        'button.send-button[aria-label]',
        'button[aria-label*="Send message" i]',
        'button[aria-label*="Envoyer" i]',
        'button[data-test-id="send-button"]',
        'button[mattooltip*="Send" i]',
        'button[mattooltip*="Envoyer" i]'
      ],
      stopButtonSelectors: [
        'button[aria-label*="Stop response" i]',
        'button[aria-label*="Stop generating" i]',
        'button[aria-label*="Arrêter" i]',
        'button.stop-button'
      ],
      streamingIndicators: [
        'button[aria-label*="Stop response" i]',
        'button[aria-label*="Arrêter" i]',
        'model-response [aria-busy="true"]',
        'mat-progress-bar',
        '.response-streaming'
      ],
      responseSelectors: [
        'model-response message-content .markdown',
        'model-response .markdown-main-panel',
        'model-response .model-response-text',
        '.response-container-content .markdown',
        'message-content.model-response-text'
      ],
      fileInputSelectors: [
        'input[type="file"]',
        'button[aria-label*="Upload" i] input[type="file"]',
        'button[aria-label*="Importer" i] input[type="file"]'
      ],
      uploadTriggerSelectors: [
        'button[aria-label*="Add files" i]',
        'button[aria-label*="Upload files" i]',
        'button[aria-label*="Ajouter des fichiers" i]',
        'button[aria-label*="Importer" i]',
        'uploader button'
      ],
      attachmentChipSelectors: [
        'uploader-file-preview',
        '[data-test-id*="file-preview"]',
        '.file-preview-container',
        '.attachment-chip',
        '[aria-label*="Remove file" i]',
        '[aria-label*="Supprimer le fichier" i]'
      ],
      uploadBusySelectors: [
        'uploader-file-preview mat-progress-spinner',
        'uploader-file-preview [role="progressbar"]',
        '.file-preview-container [aria-busy="true"]'
      ],
      artifactCleanupSelectors: [
        'code-block-decoration',
        '.code-block-decoration',
        'button[aria-label*="Copy" i]',
        'button[aria-label*="Copier" i]',
        '.response-footer',
        'sources-carousel',
        'tts-control'
      ]
    },

    claude: {
      id: 'claude',
      name: 'Anthropic Claude',
      hostPatterns: [/(^|\.)claude\.ai$/i],
      inputSelectors: [
        'div.ProseMirror[contenteditable="true"]',
        'fieldset div[contenteditable="true"]',
        'div[contenteditable="true"][data-placeholder]',
        'div[contenteditable="true"][role="textbox"]'
      ],
      sendButtonSelectors: [
        'button[aria-label*="Send Message" i]',
        'button[aria-label*="Send message" i]',
        'button[aria-label*="Envoyer" i]',
        'fieldset button[type="button"]:has(svg)'
      ],
      stopButtonSelectors: [
        'button[aria-label*="Stop Response" i]',
        'button[aria-label*="Stop generating" i]',
        'button[aria-label*="Arrêter" i]'
      ],
      streamingIndicators: [
        '[data-is-streaming="true"]',
        'button[aria-label*="Stop Response" i]',
        'button[aria-label*="Arrêter" i]'
      ],
      responseSelectors: [
        '[data-is-streaming] .font-claude-message',
        '.font-claude-message',
        '[data-testid="chat-message-content"]',
        'div[data-test-render-count] .grid'
      ],
      fileInputSelectors: [
        'input[type="file"][data-testid*="file-upload"]',
        'input[type="file"]'
      ],
      uploadTriggerSelectors: [
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
        'button[aria-label*="Joindre" i]'
      ],
      attachmentChipSelectors: [
        '[data-testid*="file-thumbnail"]',
        '[data-testid*="attachment"]',
        'fieldset [aria-label*="Remove" i]'
      ],
      uploadBusySelectors: [
        '[data-testid*="file-thumbnail"] [role="progressbar"]',
        'fieldset svg.animate-spin'
      ],
      artifactCleanupSelectors: [
        'button[aria-label*="Copy" i]',
        'button[aria-label*="Copier" i]',
        '.code-block__header'
      ]
    },

    chatgpt: {
      id: 'chatgpt',
      name: 'OpenAI ChatGPT',
      hostPatterns: [/(^|\.)chatgpt\.com$/i, /(^|\.)chat\.openai\.com$/i],
      inputSelectors: [
        '#prompt-textarea',
        'div#prompt-textarea[contenteditable="true"]',
        'textarea[data-id="root"]',
        'form div[contenteditable="true"]'
      ],
      sendButtonSelectors: [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send prompt" i]',
        'button[aria-label*="Envoyer" i]',
        'form button[type="submit"]'
      ],
      stopButtonSelectors: [
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop streaming" i]',
        'button[aria-label*="Stop generating" i]',
        'button[aria-label*="Arrêter" i]'
      ],
      streamingIndicators: [
        'button[data-testid="stop-button"]',
        '.result-streaming',
        'article[data-testid*="conversation-turn"] [data-message-author-role="assistant"].result-streaming'
      ],
      responseSelectors: [
        'article [data-message-author-role="assistant"] .markdown',
        'div[data-message-author-role="assistant"] .markdown',
        'div[data-message-author-role="assistant"]'
      ],
      fileInputSelectors: [
        'input[type="file"][multiple]',
        'input[type="file"]'
      ],
      uploadTriggerSelectors: [
        'button[data-testid="composer-plus-btn"]',
        'button[aria-label*="Attach files" i]',
        'button[aria-label*="Joindre" i]'
      ],
      attachmentChipSelectors: [
        '[data-testid*="attachment"]',
        'form [aria-label*="Remove file" i]',
        'form [aria-label*="Supprimer" i]'
      ],
      uploadBusySelectors: [
        'form [role="progressbar"]',
        'form svg.animate-spin'
      ],
      artifactCleanupSelectors: [
        '.flex.items-center.justify-between',
        'button[aria-label*="Copy" i]',
        'button[aria-label*="Copier" i]'
      ]
    },

    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek Chat',
      hostPatterns: [/(^|\.)chat\.deepseek\.com$/i],
      // Strict hash-free semantic & structural selectors
      inputSelectors: [
        'textarea#chat-input',
        'textarea[placeholder]',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]'
      ],
      sendButtonSelectors: [
        'button[type="submit"]',
        'div[role="button"][aria-disabled="false"][aria-label*="Send" i]',
        'div[role="button"][aria-disabled="false"][aria-label*="Envoyer" i]'
      ],
      stopButtonSelectors: [
        'div[role="button"][aria-label*="Stop" i]',
        'div[role="button"][aria-label*="Arrêter" i]',
        'button[aria-label*="Stop" i]'
      ],
      streamingIndicators: [
        '[aria-busy="true"]',
        'div[role="button"][aria-label*="Stop" i]'
      ],
      responseSelectors: [
        '[class*="ds-markdown"]',
        '.markdown-body',
        '[data-message-author-role="assistant"]',
        'article .markdown'
      ],
      thinkingSelectors: [
        '[class*="ds-think"]',
        '[class*="thought-content"]',
        'details[open] summary'
      ],
      fileInputSelectors: [
        'input[type="file"]'
      ],
      uploadTriggerSelectors: [
        'div[role="button"][aria-label*="upload" i]',
        'div[role="button"][aria-label*="file" i]',
        'div[role="button"][aria-label*="fichier" i]'
      ],
      attachmentChipSelectors: [
        '[class*="file-card"]',
        '[class*="attachment-item"]',
        '[aria-label*="Remove" i]',
        '[aria-label*="delete" i]'
      ],
      uploadBusySelectors: [
        '[role="progressbar"]',
        '[aria-busy="true"]'
      ],
      artifactCleanupSelectors: [
        '.md-code-block-banner',
        '[class*="md-code-block-banner"]',
        '[class*="code-info-button"]',
        'button[aria-label*="Copy" i]',
        'button[aria-label*="Copier" i]'
      ],
      customResolver: {
        findSendButton(inputEl) {
          return findDeepSeekActionElement(inputEl, 'send');
        },
        findStopButton(inputEl) {
          return findDeepSeekActionElement(inputEl, 'stop');
        },
        findUploadTrigger(inputEl) {
          return findDeepSeekActionElement(inputEl, 'upload');
        }
      }
    },

    aistudio: {
      id: 'aistudio',
      name: 'Google AI Studio',
      hostPatterns: [/(^|\.)aistudio\.google\.com$/i],
      inputSelectors: [
        'ms-autosize-textarea textarea',
        'textarea[aria-label*="Type something" i]',
        'textarea[aria-label*="Start typing" i]',
        'footer textarea',
        'textarea'
      ],
      sendButtonSelectors: [
        'run-button button',
        'button[aria-label*="Run" i]',
        'button[type="submit"]'
      ],
      stopButtonSelectors: [
        'run-button button[aria-label*="Stop" i]',
        'button[aria-label*="Cancel" i]',
        'button[aria-label*="Stop" i]'
      ],
      streamingIndicators: [
        'run-button button[aria-label*="Stop" i]',
        'ms-chat-turn [aria-busy="true"]',
        'mat-spinner'
      ],
      responseSelectors: [
        'ms-chat-turn .model-prompt-container ms-cmark-node',
        'ms-chat-turn[data-turn-role="Model"] ms-cmark-node',
        'ms-cmark-node'
      ],
      fileInputSelectors: [
        'input[type="file"]'
      ],
      uploadTriggerSelectors: [
        'button[aria-label*="Insert" i]',
        'button[aria-label*="Add" i]',
        'ms-add-chunk-menu button'
      ],
      attachmentChipSelectors: [
        'ms-media-chip',
        'ms-file-chip',
        '.media-chip'
      ],
      uploadBusySelectors: [
        'ms-media-chip mat-spinner',
        'ms-file-chip [role="progressbar"]'
      ],
      artifactCleanupSelectors: [
        'button[aria-label*="Copy" i]',
        '.code-header'
      ]
    }
  };

  /**
   * Detects the active provider based on hostname or URL.
   * @param {string} [hostnameOrUrl]
   * @returns {object|null}
   */
  function detectProvider(hostnameOrUrl) {
    let host = hostnameOrUrl;
    if (!host && typeof window !== 'undefined' && window.location) {
      host = window.location.hostname;
    }
    if (!host || typeof host !== 'string') return null;

    let cleanHost = host.trim().toLowerCase();
    try {
      if (cleanHost.includes('://')) {
        cleanHost = new URL(cleanHost).hostname.toLowerCase();
      }
    } catch (_) {
      // Keep raw string if URL parsing fails
    }

    for (const provider of Object.values(PROVIDERS)) {
      if (provider.hostPatterns.some((regex) => regex.test(cleanHost))) {
        return provider;
      }
    }
    return null;
  }

  /**
   * Resolves the active input element for a given provider.
   * @param {object} provider
   * @returns {Element|null}
   */
  function findInputElement(provider) {
    if (!provider) return null;
    return queryFirst(provider.inputSelectors, { requireVisible: true });
  }

  /**
   * Resolves the send button for a given provider, using custom structural resolvers when needed.
   * @param {object} provider
   * @param {Element|null} [inputEl]
   * @returns {Element|null}
   */
  function findSendButton(provider, inputEl) {
    if (!provider) return null;
    const direct = queryFirst(provider.sendButtonSelectors, { requireVisible: true });
    if (direct) return direct;
    if (provider.customResolver && typeof provider.customResolver.findSendButton === 'function') {
      return provider.customResolver.findSendButton(inputEl || findInputElement(provider));
    }
    return null;
  }

  /**
   * Determines whether the provider is currently streaming a response.
   * @param {object} provider
   * @param {Element|null} [inputEl]
   * @returns {boolean}
   */
  function isProviderStreaming(provider, inputEl) {
    if (!provider) return false;
    const indicator = queryFirst(provider.streamingIndicators || [], { requireVisible: true });
    if (indicator) return true;
    const stopBtn = queryFirst(provider.stopButtonSelectors || [], { requireVisible: true });
    if (stopBtn) return true;
    if (provider.customResolver && typeof provider.customResolver.findStopButton === 'function') {
      const structuralStop = provider.customResolver.findStopButton(inputEl || findInputElement(provider));
      if (structuralStop) return true;
    }
    return false;
  }

  /**
   * Extracts clean text and preserved fenced code blocks from a response DOM container,
   * stripping UI artifacts ("Copy code" headers, toolbars, citation carousels).
   * @param {Element|null} containerEl
   * @param {object} [provider]
   * @returns {string}
   */
  function extractCleanResponse(containerEl, provider) {
    if (!containerEl) return '';

    const clone = containerEl.cloneNode(true);

    const cleanupSelectors = [
      'script',
      'style',
      'noscript',
      'svg',
      'button.copy-code-button',
      '[aria-hidden="true"]',
      ...((provider && provider.artifactCleanupSelectors) || [])
    ];

    for (const sel of cleanupSelectors) {
      try {
        const nodes = clone.querySelectorAll(sel);
        for (const node of nodes) {
          node.remove();
        }
      } catch (_) {
        // Ignore invalid selector
      }
    }

    // Preserve fenced code blocks accurately if not already formatted with backticks
    const preBlocks = clone.querySelectorAll('pre');
    for (const pre of preBlocks) {
      const codeEl = pre.querySelector('code') || pre;
      const rawCode = codeEl.textContent || '';
      if (!rawCode.trim()) continue;

      let lang = '';
      const classAttr = (codeEl.getAttribute('class') || '') + ' ' + (pre.getAttribute('class') || '');
      const langMatch = classAttr.match(/(?:language-|lang-)([a-zA-Z0-9_+-]+)/);
      if (langMatch) {
        lang = langMatch[1];
      }

      if (!rawCode.trim().startsWith('```')) {
        const replacement = clone.ownerDocument.createTextNode(`\n\`\`\`${lang}\n${rawCode.replace(/\n$/, '')}\n\`\`\`\n`);
        pre.replaceWith(replacement);
      }
    }

    const rawText = (clone.innerText !== undefined ? clone.innerText : clone.textContent) || '';
    return rawText
      .replace(/\r\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  /**
   * Retrieves the latest assistant response container and its extracted text.
   * For DeepSeek (R1 / DeepThink), separates reasoning blocks from the final answer container.
   * @param {object} provider
   * @returns {{ element: Element|null, text: string, isThinking: boolean, count: number }}
   */
  function getLatestResponseSnapshot(provider) {
    if (!provider || typeof document === 'undefined') {
      return { element: null, text: '', isThinking: false, count: 0 };
    }

    let nodes = [];
    for (const selector of provider.responseSelectors || []) {
      try {
        const found = Array.from(document.querySelectorAll(selector));
        if (found.length > 0) {
          nodes = found;
          break;
        }
      } catch (_) {
        continue;
      }
    }

    // Filter out DeepSeek thinking containers if multiple markdown blocks exist in the same turn
    if (provider.id === 'deepseek' && nodes.length > 0) {
      const nonThinkingNodes = nodes.filter((el) => {
        const parentClass = (el.parentElement?.className || '') + ' ' + (el.className || '');
        return !/think|thought/i.test(parentClass);
      });
      if (nonThinkingNodes.length > 0) {
        nodes = nonThinkingNodes;
      }
    }

    let isThinking = false;
    if (provider.thinkingSelectors) {
      const thinkEl = queryFirst(provider.thinkingSelectors, { requireVisible: true });
      if (thinkEl && isProviderStreaming(provider)) {
        isThinking = true;
      }
    }

    if (nodes.length === 0) {
      return { element: null, text: '', isThinking, count: 0 };
    }

    const latestEl = nodes[nodes.length - 1];
    const text = extractCleanResponse(latestEl, provider);
    return {
      element: latestEl,
      text,
      isThinking,
      count: nodes.length
    };
  }

  return {
    PROVIDERS,
    isVisibleElement,
    queryFirst,
    findDeepSeekActionElement,
    detectProvider,
    findInputElement,
    findSendButton,
    isProviderStreaming,
    extractCleanResponse,
    getLatestResponseSnapshot
  };
});
