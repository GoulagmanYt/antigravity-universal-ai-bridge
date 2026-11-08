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

    let composerRoot = inputEl ? (inputEl.closest('form') || inputEl.closest('[role="group"]')) : null;
    if (!composerRoot && inputEl) {
      let cur = inputEl.parentElement;
      for (let i = 0; i < 15 && cur && cur !== document.body; i++) {
        if (cur.querySelector && cur.querySelector('.ds-button--circle, div[role="button"].ds-button--primary, input[type="file"]')) {
          composerRoot = cur;
          break;
        }
        cur = cur.parentElement;
      }
    }
    if (!composerRoot) composerRoot = document.body;

    if (!composerRoot) return null;

    const candidates = Array.from(
      composerRoot.querySelectorAll('button, div[role="button"], span[role="button"], label[role="button"]')
    ).filter((el) => {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      // Exclude toggle buttons (e.g. DeepThink R1, Web Search toggles)
      if (el.classList.contains('ds-toggle-button') || (typeof el.closest === 'function' && el.closest('.ds-toggle-button'))) {
        return false;
      }
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
        const prevSibling = fileInput.previousElementSibling;
        if (prevSibling && (prevSibling.getAttribute('role') === 'button' || prevSibling.querySelector?.('[role="button"]'))) {
          return prevSibling.getAttribute('role') === 'button' ? prevSibling : prevSibling.querySelector('[role="button"]');
        }
        const parentBtn = fileInput.parentElement?.querySelector('div[role="button"], button');
        if (parentBtn) return parentBtn;
      }
      return candidates[0] || null;
    }

    if (roleType === 'stop') {
      for (let i = candidates.length - 1; i >= 0; i--) {
        const btn = candidates[i];
        const ariaLabel = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
        if (ariaLabel.includes('stop') || ariaLabel.includes('arrê') || ariaLabel.includes('cancel')) {
          return btn;
        }
        // Direct rect in svg body (must not be inside <clipPath> or <defs>)
        const rectSvg = btn.querySelector('svg > rect, svg > g:not(defs) > rect');
        const clipPath = rectSvg && typeof rectSvg.closest === 'function' ? rectSvg.closest('clipPath, defs') : null;
        if (rectSvg && !clipPath) {
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
          btn.hasAttribute('disabled') ||
          btn.classList.contains('disabled') ||
          btn.classList.contains('ds-button--disabled');
        if (!disabled && isVisibleElement(btn)) {
          return btn;
        }
      }
      return null;
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
        'button[aria-label*="Stop generating" i]',
        'button[aria-label*="Arrêter" i]',
        'model-response [aria-busy="true"]',
        'model-response .sparkle-container',
        'model-response .loading-indicator',
        'model-response loading-dots',
        'mat-progress-bar',
        'mat-progress-spinner',
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
        'user-query',
        '.user-query-container',
        '[data-test-id*="user-query"]',
        '.user-query',
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
        'div#prompt-textarea',
        'div.ProseMirror[contenteditable="true"]',
        'textarea[data-id="root"]',
        'form div[contenteditable="true"]',
        'textarea'
      ],
      sendButtonSelectors: [
        '#composer-submit-button',
        'button[data-testid="send-button"]',
        'button[data-testid="fruitjuice-send-button"]',
        'button[aria-label*="Send prompt" i]',
        'button[aria-label*="Send message" i]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Envoyer" i]',
        'form button[type="submit"]'
      ],
      stopButtonSelectors: [
        'button[data-testid="stop-button"]',
        'button[data-testid*="stop"]',
        '#composer-submit-button[aria-label*="Stop" i]',
        '#composer-submit-button[aria-label*="Arrêt" i]',
        'button[aria-label*="Stop streaming" i]',
        'button[aria-label*="Stop generating" i]',
        'button[aria-label*="Arrêter la réponse" i]',
        'button[aria-label*="Arrêter de générer" i]',
        'button[aria-label*="Arrêter" i]'
      ],
      streamingIndicators: [
        'button[data-testid="stop-button"]',
        'button[data-testid*="stop"]',
        '#composer-submit-button[aria-label*="Stop" i]',
        '#composer-submit-button[aria-label*="Arrêt" i]',
        '.result-streaming',
        '[data-message-author-role="assistant"].result-streaming',
        'article[data-testid*="conversation-turn"] .result-streaming',
        '[data-is-streaming="true"]'
      ],
      thinkingSelectors: [
        '[data-testid="thought-content"]',
        '[data-testid="reasoning-summary"]',
        '[data-testid*="thought"]',
        '[data-testid*="reasoning"]',
        'details.group',
        'details[open]',
        '.thought-container',
        '.model-thought',
        '[class*="thought"]',
        '[class*="reasoning"]'
      ],
      responseSelectors: [
        '.markdown',
        '[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="assistant"]',
        '[data-testid="assistant-message"] .markdown',
        '[data-testid="assistant-message"]',
        '.agent-turn .markdown',
        '.agent-turn',
        'article [data-message-author-role="assistant"] .markdown',
        'div[data-message-author-role="assistant"] .markdown',
        'div[data-message-author-role="assistant"]'
      ],
      fileInputSelectors: [
        'input[type="file"][multiple]',
        'input[type="file"]'
      ],
      uploadTriggerSelectors: [
        'button[data-testid="attach-button"]',
        'button[data-testid="composer-plus-btn"]',
        'button[aria-label*="Attach files" i]',
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Joindre" i]',
        'button[aria-label*="Ajouter" i]',
        'button[aria-label*="file" i]',
        'button[aria-label*="fichier" i]'
      ],
      attachmentChipSelectors: [
        '[data-testid*="attachment"]',
        '[data-testid*="file-thumbnail"]',
        '[data-testid*="composer-file"]',
        '.group.relative.inline-block',
        '.attachment-preview',
        'div[class*="attachment"]',
        'div[class*="file-preview"]',
        'form button[aria-label*="Remove" i]',
        'form button[aria-label*="Supprimer" i]',
        'button[aria-label*="Remove" i]',
        'button[aria-label*="Supprimer" i]',
        'button[aria-label*="Fermer" i]',
        'button[aria-label*="Delete" i]',
        '[aria-label*="Remove file" i]',
        '[aria-label*="Supprimer le fichier" i]',
        '[aria-label*="Remove" i]',
        '[aria-label*="Supprimer" i]'
      ],
      uploadBusySelectors: [
        'form [role="progressbar"]',
        'form svg.animate-spin',
        '[data-testid*="attachment"] [role="progressbar"]',
        '[data-testid*="attachment"] svg.animate-spin',
        '.group.relative.inline-block [role="progressbar"]',
        '.group.relative.inline-block svg.animate-spin'
      ],
      artifactCleanupSelectors: [
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
        'textarea[name="search"]',
        'textarea[placeholder*="DeepSeek" i]',
        'textarea[placeholder]',
        'textarea._27c9245',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]'
      ],
      sendButtonSelectors: [
        'div[role="button"].ds-button--circle:not(.ds-button--disabled)',
        'div[role="button"].ds-button--primary:not(.ds-button--disabled)',
        '.ds-button--circle:not(.ds-button--disabled)',
        '.ds-button--primary:not(.ds-button--disabled)',
        'button[type="submit"]:not([disabled])',
        'div[role="button"][aria-disabled="false"][aria-label*="Send" i]',
        'div[role="button"][aria-disabled="false"][aria-label*="Envoyer" i]'
      ],
      stopButtonSelectors: [
        'div[role="button"][aria-label*="Stop" i]',
        'div[role="button"][aria-label*="Arrêter" i]',
        'button[aria-label*="Stop" i]'
      ],
      streamingIndicators: [
        'div[role="button"][aria-label*="Stop" i]',
        'div[role="button"][aria-label*="Arrêter" i]',
        'button[aria-label*="Stop" i]'
      ],
      responseSelectors: [
        '.ds-markdown.ds-assistant-message-main-content',
        '.ds-markdown:not(.ds-markdown--thought):not([class*="ds-think"])',
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
        'div[role="button"][aria-label*="fichier" i]',
        '.ds-button--icon'
      ],
      attachmentChipSelectors: [
        '[class*="file-card"]',
        '[class*="attachment-item"]',
        '[class*="file-chip"]',
        '[class*="file-item"]',
        '[aria-label*="Remove" i]',
        '[aria-label*="delete" i]'
      ],
      uploadBusySelectors: [
        '[role="progressbar"]'
      ],
      artifactCleanupSelectors: [
        '[class*="ds-think"]',
        '.ds-think-content',
        '[class*="thought-content"]',
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
      if (structuralStop && isVisibleElement(structuralStop)) return true;
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

    // If container holds an inner assistant bubble or markdown wrapper, target it
    const assistantBubble = containerEl.querySelector
      ? containerEl.querySelector('[data-message-author-role="assistant"], div.agent-turn, .markdown, .prose')
      : null;
    const target = assistantBubble || containerEl;
    const clone = target.cloneNode(true);

    const cleanupSelectors = [
      'script',
      'style',
      'noscript',
      'svg',
      'button',
      '.code-header',
      '[data-testid="copy-code-button"]',
      '[data-testid="copy-turn-action-button"]',
      'button.copy-code-button',
      '[data-message-author-role="user"]',
      '[data-testid="user-message"]',
      '.user-message-bubble',
      '.user-turn',
      'user-query',
      '.user-query-container',
      '[data-test-id*="user-query"]',
      '.user-query',
      'details',
      '[data-testid="thought-content"]',
      '[data-testid="reasoning-summary"]',
      '[data-testid*="thought"]',
      '[data-testid*="reasoning"]',
      '.thought-container',
      '.model-thought',
      '.thinking-process',
      '.ds-markdown--thought',
      'collapsible-panel',
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

    // Chromium: clone.innerText on a detached DOM node can evaluate to empty string ""
    // Prioritize non-empty innerText, then non-empty textContent, then target's live innerText/textContent
    let rawText = '';
    if (typeof clone.innerText === 'string' && clone.innerText.trim().length > 0) {
      rawText = clone.innerText;
    } else if (typeof clone.textContent === 'string' && clone.textContent.trim().length > 0) {
      rawText = clone.textContent;
    } else if (typeof target.innerText === 'string' && target.innerText.trim().length > 0) {
      rawText = target.innerText;
    } else {
      rawText = target.textContent || '';
    }

    // Strip user message prefix if ancestor container captured the full turn
    if (rawText.includes('ChatGPT a dit :')) {
      const parts = rawText.split('ChatGPT a dit :');
      rawText = parts[parts.length - 1];
    } else if (rawText.includes('ChatGPT said :')) {
      const parts = rawText.split('ChatGPT said :');
      rawText = parts[parts.length - 1];
    } else if (rawText.includes('ChatGPT said:')) {
      const parts = rawText.split('ChatGPT said:');
      rawText = parts[parts.length - 1];
    }
    rawText = rawText.replace(/^ChatGPT\s*/i, '');

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

    // Fallback: If no direct response selector matched, check for assistant turn containers via action buttons
    if (nodes.length === 0) {
      const actionBtns = Array.from(
        document.querySelectorAll(
          'button[data-testid="copy-turn-action-button"], ' +
          'button[data-testid="read-aloud-turn-action-button"], ' +
          'button[data-testid="thumbs-up-turn-action-button"], ' +
          'button[data-testid*="thumbs"], ' +
          'button[data-testid*="read-aloud"], ' +
          'button[aria-label*="Copier" i], ' +
          'button[aria-label*="Copy" i]'
        )
      );
      if (actionBtns.length > 0) {
        const foundTurns = [];
        for (const btn of actionBtns) {
          let cur = btn.parentElement;
          let turn = null;
          for (let d = 0; d < 8 && cur && cur.tagName !== 'MAIN' && cur.tagName !== 'BODY'; d++) {
            if (cur.querySelector && cur.querySelector('.markdown, pre, code')) {
              turn = cur;
              break;
            }
            if ((cur.innerText || cur.textContent || '').trim().length > 20) {
              turn = cur;
              if (cur.getAttribute('data-testid')?.includes('turn') || cur.className?.includes('turn')) {
                break;
              }
            }
            cur = cur.parentElement;
          }
          if (turn && !foundTurns.includes(turn)) {
            const isUserTurn = Boolean(
              turn.tagName === 'USER-QUERY' ||
              (turn.matches && turn.matches('user-query, [data-test-id*="user-query"], .user-query, [data-message-author-role="user"], [data-testid="user-message"]')) ||
              (turn.closest && turn.closest('user-query, [data-test-id*="user-query"], .user-query, [data-message-author-role="user"], [data-testid="user-message"]')) ||
              (turn.querySelector && turn.querySelector('user-query, [data-message-author-role="user"], [data-testid="user-message"], [data-test-id*="user-query"], .user-query'))
            );
            if (!isUserTurn) {
              foundTurns.push(turn);
            }
          }
        }
        if (foundTurns.length > 0) {
          nodes = foundTurns;
        }
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
