const PROVIDERS = {
    "gemini.google.com": {
        name: "Gemini",
        input: 'div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], rich-textarea .input-area, rich-textarea div[contenteditable="true"], div[contenteditable="true"]',
        sendBtn: 'button.send-button, button[aria-label*="Send" i], button[aria-label*="Envoyer" i], .send-button-container button',
        response: 'message-content, .model-response-text, model-response .response-content, .response-container-content',
        stopBtn: 'button[aria-label*="Stop" i], button[aria-label*="Arrêter" i]',
        attachmentBtn: 'button[aria-label*="Ajouter" i], button[aria-label*="Importer" i], button[aria-label*="Add" i], button[aria-label*="Upload" i], button[aria-label*="Attach" i], button.uploader-button, [data-testid="plus-button"]',
        fileInput: 'input[type="file"], .file-input',
        attachmentChip: 'uploader-file-preview, .file-preview, .attachment-preview, [data-test-id*="file"], mat-chip, .uploaded-file, [aria-label*="Supprimer" i], [aria-label*="Remove" i], .preview-container',
        maxFilesPerTurn: 10
    },
    "aistudio.google.com": {
        name: "Google AI Studio",
        input: 'textarea.textarea, textarea, div[contenteditable="true"]',
        sendBtn: 'button.run-button, button[aria-label*="Run"], button[type="submit"]',
        response: '.chat-turn-content, ms-chat-turn, .model-prompt-container',
        stopBtn: 'button.stop-button, button[aria-label*="Stop"]',
        attachmentBtn: 'button[aria-label*="Insert" i], button[aria-label*="Upload" i], button[aria-label*="Ajouter" i]',
        fileInput: 'input[type="file"]',
        attachmentChip: '.media-chip, .file-chip, ms-media-chip',
        maxFilesPerTurn: 15
    },
    "claude.ai": {
        name: "Claude",
        input: 'div.ProseMirror[contenteditable="true"], fieldset div[contenteditable="true"]',
        sendBtn: 'button[aria-label*="Send" i], button[aria-label*="Envoyer" i], button[data-testid="send-button"]',
        response: '.font-claude-message, .font-claude-response, [data-testid="chat-message-content"]',
        stopBtn: 'button[aria-label*="Stop" i], [data-is-streaming="true"]',
        attachmentBtn: 'button[aria-label*="Upload" i], button[aria-label*="Attach" i], button[aria-label*="Ajouter" i]',
        fileInput: 'input[type="file"][data-testid="file-upload"], input[type="file"]',
        attachmentChip: '[data-testid*="file"], .file-thumbnail, [aria-label*="Remove" i]',
        maxFilesPerTurn: 15
    },
    "chatgpt.com": {
        name: "ChatGPT",
        input: '#prompt-textarea, div#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"], textarea',
        sendBtn: '#composer-submit-button, button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label*="Send" i], button[aria-label*="Envoyer" i]',
        response: '[data-message-author-role="assistant"], div[data-message-author-role="assistant"], [data-testid="assistant-message"], .agent-turn',
        stopBtn: 'button[data-testid="stop-button"], button[aria-label*="Arrêter" i], button[aria-label*="Stop" i], #composer-submit-button[aria-label*="Arrêter" i], #composer-submit-button[aria-label*="Stop" i], .result-streaming',
        attachmentBtn: 'button[data-testid="attach-button"], button[aria-label*="Attach" i], button[aria-label*="Ajouter" i], button[aria-label*="Joindre" i], button[aria-label*="file" i]',
        fileInput: 'input[type="file"]',
        attachmentChip: '[data-testid*="attachment"], .group.relative.inline-block, [aria-label*="Remove" i], [aria-label*="Supprimer" i]',
        maxFilesPerTurn: 10
    },
    "chat.openai.com": {
        name: "ChatGPT",
        input: '#prompt-textarea, div#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"], textarea',
        sendBtn: '#composer-submit-button, button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label*="Send" i], button[aria-label*="Envoyer" i]',
        response: '[data-message-author-role="assistant"], div[data-message-author-role="assistant"], [data-testid="assistant-message"], .agent-turn',
        stopBtn: 'button[data-testid="stop-button"], button[aria-label*="Arrêter" i], button[aria-label*="Stop" i], #composer-submit-button[aria-label*="Arrêter" i], #composer-submit-button[aria-label*="Stop" i], .result-streaming',
        attachmentBtn: 'button[data-testid="attach-button"], button[aria-label*="Attach" i], button[aria-label*="Ajouter" i]',
        fileInput: 'input[type="file"]',
        attachmentChip: '[data-testid*="attachment"], .group.relative.inline-block, [aria-label*="Remove" i]',
        maxFilesPerTurn: 10
    },
    "chat.deepseek.com": {
        name: "DeepSeek",
        input: 'textarea#chat-input, textarea',
        sendBtn: 'div[role="button"][aria-disabled="false"], button[type="submit"], button.ds-icon-button',
        response: '.ds-markdown',
        stopBtn: 'button[aria-label*="Stop"], .ds-icon-button[aria-label*="Stop"], div[role="button"][aria-label*="Stop"]',
        attachmentBtn: 'button[aria-label*="Upload" i], button[aria-label*="Attach" i]',
        fileInput: 'input[type="file"]',
        attachmentChip: '.ds-file-card, [class*="file-item"], [class*="attachment"]',
        maxFilesPerTurn: 10
    }
};

const currentHost = Object.keys(PROVIDERS).find(host => window.location.hostname.includes(host));
const provider = PROVIDERS[currentHost] || {
    name: window.location.hostname,
    input: 'div[contenteditable="true"], textarea',
    sendBtn: 'button[type="submit"], button[aria-label*="Send"]',
    response: '.markdown, message-content',
    stopBtn: null,
    attachmentBtn: null,
    fileInput: 'input[type="file"]',
    attachmentChip: null,
    maxFilesPerTurn: 10
};

let ws = null;
let isTabDedicated = false;
let retryTimer = null;
let isDragging = false;

const statusBtn = document.createElement('div');
statusBtn.style.cssText = `
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 999999;
  padding: 7px 18px;
  border-radius: 22px;
  border: 1px solid #444;
  background: #1e1e1e;
  color: #fff;
  font-family: system-ui, -apple-system, sans-serif;
  cursor: grab;
  box-shadow: 0 4px 14px rgba(0,0,0,0.45);
  transition: background 0.2s ease, border-color 0.2s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  user-select: none;
`;

// Restore saved pill position if exists
try {
    const savedPos = JSON.parse(localStorage.getItem('antigravity_pill_pos'));
    if (savedPos && savedPos.left && savedPos.top) {
        statusBtn.style.left = savedPos.left;
        statusBtn.style.top = savedPos.top;
        statusBtn.style.transform = 'none';
    }
} catch (e) {}

const statusLabel = document.createElement('div');
statusLabel.style.cssText = `
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.2px;
  pointer-events: none;
`;

const watermarkLabel = document.createElement('div');
watermarkLabel.innerText = 'Powered by Trignod.ai';
watermarkLabel.style.cssText = `
  font-size: 10px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.65);
  letter-spacing: 0.4px;
  pointer-events: none;
`;

statusBtn.appendChild(statusLabel);
statusBtn.appendChild(watermarkLabel);
updateUI('standby');
document.body.appendChild(statusBtn);

// Draggable status pill
let startX = 0, startY = 0, origLeft = 0, origTop = 0;
statusBtn.addEventListener('mousedown', (e) => {
    isDragging = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = statusBtn.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    statusBtn.style.cursor = 'grabbing';

    function onMouseMove(moveEvent) {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
            isDragging = true;
            statusBtn.style.transform = 'none';
            statusBtn.style.left = `${Math.max(10, Math.min(window.innerWidth - rect.width - 10, origLeft + dx))}px`;
            statusBtn.style.top = `${Math.max(10, Math.min(window.innerHeight - rect.height - 10, origTop + dy))}px`;
        }
    }

    function onMouseUp() {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        statusBtn.style.cursor = 'grab';
        if (isDragging) {
            try {
                localStorage.setItem('antigravity_pill_pos', JSON.stringify({
                    left: statusBtn.style.left,
                    top: statusBtn.style.top
                }));
            } catch (e) {}
        }
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
});

function updateUI(state, detail = '') {
    const suffix = detail ? ` (${detail})` : '';
    if (state === 'standby') {
        statusLabel.innerText = `⚪ Click to dedicate (${provider.name}) to Antigravity`;
        statusBtn.style.background = '#242424';
        statusBtn.style.borderColor = '#555';
    } else if (state === 'connecting') {
        statusLabel.innerText = `🟡 Connecting (${provider.name}) to Antigravity MCP...`;
        statusBtn.style.background = '#4d3800';
        statusBtn.style.borderColor = '#f5b000';
    } else if (state === 'connected') {
        statusLabel.innerText = `🟢 (${provider.name}) Connected to Antigravity`;
        statusBtn.style.background = '#0d3b1e';
        statusBtn.style.borderColor = '#2ea043';
    } else if (state === 'working') {
        statusLabel.innerText = `🔵 (${provider.name}) Processing Task${suffix}...`;
        statusBtn.style.background = '#0a2d4d';
        statusBtn.style.borderColor = '#388bfd';
    }
}

statusBtn.addEventListener('click', () => {
    if (isDragging) return;
    isTabDedicated = !isTabDedicated;
    if (isTabDedicated) {
        try { sessionStorage.setItem('antigravity_bridge_dedicated', 'true'); } catch (e) {}
        connectBridge();
    } else {
        try { sessionStorage.removeItem('antigravity_bridge_dedicated'); } catch (e) {}
        clearTimeout(retryTimer);
        if (ws) ws.close();
        ws = null;
        updateUI('standby');
    }
});

// Auto-reconnect if tab was dedicated before refresh / navigation
try {
    if (sessionStorage.getItem('antigravity_bridge_dedicated') === 'true') {
        isTabDedicated = true;
        connectBridge();
    }
} catch (e) {}

function connectBridge() {
    if (!isTabDedicated) return;
    updateUI('connecting');

    const port = 4545;
    ws = new WebSocket(`ws://localhost:${port}`);

    ws.onopen = () => updateUI('connected');

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        const id = data.id || null;

        if (data.type === 'replaced') {
            isTabDedicated = false;
            try { sessionStorage.removeItem('antigravity_bridge_dedicated'); } catch (e) {}
            clearTimeout(retryTimer);
            updateUI('standby');
            return;
        }

        if (data.type === 'check_session') {
            const composer = document.querySelector(provider.input) || findElementDeep(provider.input) || document.querySelector('#prompt-textarea');
            const submitBtn = document.querySelector(provider.sendBtn) || document.querySelector('#composer-submit-button') || document.querySelector('button[data-testid="send-button"]');
            const micBtn = document.querySelector('button[aria-label*="vocale" i], button[aria-label*="voice" i]');
            const existingResponses = findAssistantResponses();
            const sessionPayload = {
                provider: provider.name,
                isEmptyChat: existingResponses.length === 0,
                chatKey: window.location.origin + window.location.pathname,
                domDiagnostic: {
                    existingResponsesCount: existingResponses.length,
                    hasMain: document.querySelector('main') !== null,
                    conversationTurnsCount: document.querySelectorAll('[data-testid^="conversation-turn-"]').length,
                    composerFound: composer !== null,
                    composerTag: composer?.tagName,
                    composerTextLength: composer?.innerText?.trim().length || 0,
                    hasSubmitBtn: submitBtn !== null,
                    submitBtnDisabled: submitBtn?.disabled,
                    hasMicBtn: micBtn !== null,
                    lastResponseSnippet: existingResponses.length > 0 ? extractCleanResponse(existingResponses[existingResponses.length - 1]).slice(0, 100) : ""
                }
            };
            ws.send(JSON.stringify({
                id,
                type: 'check_session',
                payload: sessionPayload,
                ...sessionPayload
            }));
            return;
        }

        if (data.type === 'prompt') {
            const payload = data.payload || data;
            const promptText = payload.prompt || "";
            const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

            updateUI('working', attachments.length > 0 ? `${attachments.length} file(s)` : '');
            try {
                const reply = await askWebProvider(promptText, attachments);
                ws.send(JSON.stringify({
                    id,
                    type: 'prompt',
                    payload: { reply },
                    reply
                }));
            } catch (err) {
                ws.send(JSON.stringify({
                    id,
                    type: 'prompt',
                    error: err.message || "Failed to generate reply"
                }));
            }
            updateUI('connected');
        }
    };

    ws.onclose = () => {
        if (isTabDedicated) {
            updateUI('connecting');
            retryTimer = setTimeout(connectBridge, 3000);
        }
    };

    ws.onerror = () => {
        if (ws) ws.close();
    };
}

/**
 * Consolidates excess attachments into a single bundle file if count exceeds provider's per-turn file limit.
 */
function normalizeAttachmentsForProvider(attachments) {
    if (!attachments || attachments.length === 0) return [];
    const maxFiles = provider.maxFilesPerTurn || 10;
    if (attachments.length <= maxFiles) return attachments;

    const kept = attachments.slice(0, maxFiles - 1);
    const overflow = attachments.slice(maxFiles - 1);
    const combinedContent = overflow.map(att =>
        `// ============================================================================\n` +
        `// BUNDLED FILE: ${att.originalPath || att.name}\n` +
        `// ============================================================================\n\n` +
        `${att.content}\n\n`
    ).join("\n");

    kept.push({
        name: `99_COMBINED_WORKSPACE_FILES_${overflow.length}.txt`,
        originalPath: "COMBINED_OVERFLOW_BUNDLE",
        content: combinedContent,
        mimeType: "text/plain"
    });
    return kept;
}

function findElementDeep(selector, root = document) {
    if (!root) return null;
    let found = root.querySelector ? root.querySelector(selector) : null;
    if (found) return found;
    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of elements) {
        if (el.shadowRoot) {
            found = findElementDeep(selector, el.shadowRoot);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Builds browser File objects and a populated DataTransfer container.
 */
function buildDataTransfer(attachments) {
    const dt = new DataTransfer();
    for (const att of attachments) {
        const file = new File([att.content], att.name, {
            type: att.mimeType || "text/plain",
            lastModified: Date.now()
        });
        dt.items.add(file);
    }
    return dt;
}

/**
 * Multi-strategy native file uploader for Gemini, Claude, ChatGPT, AI Studio, and DeepSeek.
 * Strategy 1: Direct <input type="file"> assignment + change/input events (including Shadow DOM).
 * Strategy 2: Synthetic DragEvent ('dragenter' -> 'dragover' -> 'drop' with composed: true).
 * Strategy 3: Synthetic ClipboardEvent('paste') with files on the editor element.
 */
async function uploadAttachmentsToDOM(editor, rawAttachments) {
    const attachments = normalizeAttachmentsForProvider(rawAttachments);
    if (attachments.length === 0) return { uploaded: true, count: 0 };

    const dt = buildDataTransfer(attachments);

    const hasAttachmentChips = () => {
        if (!provider.attachmentChip) return false;
        const chips = Array.from(document.querySelectorAll(provider.attachmentChip));
        if (chips.length >= attachments.length) {
            const isUploading = chips.some(c => c.querySelector('[role="progressbar"], .animate-spin'));
            return !isUploading;
        }
        return false;
    };

    console.log(`[Bridge] Attaching ${attachments.length} file(s) to ${provider.name}...`);
    statusLabel.innerText = `🔵 Attaching ${attachments.length} file(s)...`;

    // Strategy 1: Locate or trigger <input type="file"> (supports Shadow DOM boundaries)
    let fileInput = findElementDeep(provider.fileInput || 'input[type="file"]');

    // If file input not immediately in DOM, click attachment / plus button to mount it
    if (!fileInput && provider.attachmentBtn) {
        const attachBtn = findElementDeep(provider.attachmentBtn);
        if (attachBtn) {
            try {
                attachBtn.click();
                await new Promise(r => setTimeout(r, 350));
                fileInput = findElementDeep(provider.fileInput || 'input[type="file"]');
            } catch (e) {}
        }
    }

    if (fileInput) {
        try {
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

            // Wait up to 3s for attachment preview chip to confirm
            for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 250));
                if (hasAttachmentChips()) {
                    console.log(`[Bridge] File attachment confirmed via fileInput on ${provider.name}`);
                    statusLabel.innerText = `🟢 Attached ${attachments.length} file(s)`;
                    return { uploaded: true, method: 'file-input', count: attachments.length };
                }
            }
        } catch (e) {
            console.warn('[Bridge] fileInput method failed:', e);
        }
    }

    // Strategy 2: Synthetic Drag & Drop with composed: true on editor / container
    try {
        const dropTargets = [
            findElementDeep('rich-textarea'),
            findElementDeep('.input-area'),
            findElementDeep('div[contenteditable="true"]'),
            document.querySelector('form'),
            editor
        ].filter(Boolean);

        for (const dropTarget of dropTargets) {
            const eventInit = {
                bubbles: true,
                cancelable: true,
                composed: true,
                dataTransfer: dt
            };
            dropTarget.dispatchEvent(new DragEvent('dragenter', eventInit));
            dropTarget.dispatchEvent(new DragEvent('dragover', eventInit));
            await new Promise(r => setTimeout(r, 60));
            dropTarget.dispatchEvent(new DragEvent('drop', eventInit));
            dropTarget.dispatchEvent(new DragEvent('dragend', eventInit));

            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 250));
                if (hasAttachmentChips()) {
                    console.log(`[Bridge] File attachment confirmed via drag-drop on ${provider.name}`);
                    statusLabel.innerText = `🟢 Attached ${attachments.length} file(s)`;
                    return { uploaded: true, method: 'drag-drop', count: attachments.length };
                }
            }
        }
    } catch (e) {
        console.warn('[Bridge] Drag-drop method failed:', e);
    }

    // Strategy 3: Synthetic ClipboardEvent('paste')
    try {
        editor.focus();
        const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dt
        });
        if (!pasteEvent.clipboardData || pasteEvent.clipboardData.files.length === 0) {
            Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
        }
        editor.dispatchEvent(pasteEvent);

        for (let i = 0; i < 8; i++) {
            await new Promise(r => setTimeout(r, 250));
            if (hasAttachmentChips()) {
                console.log(`[Bridge] File attachment confirmed via clipboard-paste on ${provider.name}`);
                statusLabel.innerText = `🟢 Attached ${attachments.length} file(s)`;
                return { uploaded: true, method: 'clipboard-paste', count: attachments.length };
            }
        }
    } catch (e) {
        console.warn('[Bridge] Clipboard paste method failed:', e);
    }

    if (hasAttachmentChips()) {
        statusLabel.innerText = `🟢 Attached ${attachments.length} file(s)`;
        return { uploaded: true, method: 'dom-chips-detected', count: attachments.length };
    }

    statusLabel.innerText = `🟠 Fallback: files inlined`;
    console.warn(`[Bridge] All attachment methods failed to produce attachment chips on ${provider.name}`);
    return { uploaded: false, error: 'Attachment preview chips not detected in DOM' };
}

function fillInputBox(editor, text) {
    editor.focus();

    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
                       Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
            setter.call(editor, text);
        } else {
            editor.value = text;
        }
        editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return;
    }

    // Modern ProseMirror / rich-text editors (ChatGPT, Claude, Gemini)
    // Direct ProseMirror view access if attached to DOM
    try {
        const pmView = editor.pmViewDesc?.view || editor.__vue__?.editorView;
        if (pmView && pmView.state && pmView.dispatch) {
            const { state, dispatch } = pmView;
            const tr = state.tr.replaceWith(0, state.doc.content.size, state.schema.text(text));
            dispatch(tr);
            editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            return;
        }
    } catch (e) {}

    // Vector 1: Native editing insertion via execCommand with explicit Selection Range
    let inserted = false;
    try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
        inserted = document.execCommand('insertText', false, text);
    } catch (e) {}

    // Vector 2: Synthetic ClipboardEvent('paste') with DataTransfer
    if (!inserted || !editor.innerText || editor.innerText.trim() === '') {
        try {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: dt
            });
            editor.dispatchEvent(pasteEvent);
        } catch (e) {}
    }

    // Vector 3: Safe text node paragraph construction (never unescaped raw innerHTML)
    if (!editor.innerText || editor.innerText.trim() === '') {
        editor.replaceChildren();
        const lines = text.split('\n');
        for (const line of lines) {
            const p = document.createElement('p');
            if (line.length > 0) {
                p.textContent = line;
            } else {
                p.appendChild(document.createElement('br'));
            }
            editor.appendChild(p);
        }
    }

    editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'insertText',
        data: text
    }));
    editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function findAssistantResponses() {
    // 1. Direct role / testid selector
    const byRole = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-testid="assistant-message"], .agent-turn'));
    if (byRole.length > 0) return byRole;

    // 2. ChatGPT conversation turns
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], [class*="conversation-turn"]'));
    if (turns.length > 0) {
        const assistantTurns = turns.filter(turn => {
            const hasUser = turn.querySelector('[data-message-author-role="user"]') ||
                            turn.querySelector('[data-testid="user-message"]');
            return !hasUser;
        });
        if (assistantTurns.length > 0) {
            return assistantTurns.map(turn => {
                return turn.querySelector('.markdown, [class*="markdown"], .prose, [data-message-author-role="assistant"]') || turn;
            });
        }
    }

    // 3. Fallback: all articles (excluding user)
    const articles = Array.from(document.querySelectorAll('article'));
    if (articles.length > 0) {
        const assistantArticles = articles.filter(a => !a.querySelector('[data-message-author-role="user"]'));
        if (assistantArticles.length > 0) return assistantArticles;
    }

    // 4. Main container prose / markdown fallback
    const main = document.querySelector('main');
    if (main) {
        const prose = Array.from(main.querySelectorAll('.markdown, [class*="markdown"], .prose'));
        if (prose.length > 0) return prose;
    }

    // 5. Provider default selector
    return Array.from(document.querySelectorAll(provider.response));
}

function extractCleanResponse(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);

    // Remove thinking / reasoning accordions from Gemini, Claude, DeepSeek, ChatGPT
    const thoughtSelectors = [
        '.thinking-process',
        '.ds-markdown--thought',
        'details',
        '[data-testid="thought-content"]',
        '.thought-container',
        '.model-thought',
        'collapsible-panel',
        '[data-testid="reasoning-summary"]'
    ];
    for (const sel of thoughtSelectors) {
        clone.querySelectorAll(sel).forEach(el => el.remove());
    }

    // Remove UI decorators (copy buttons, code headers, turn actions)
    const uiDecorators = [
        'button',
        '.code-header',
        '[data-testid="copy-code-button"]',
        '[data-testid="copy-turn-action-button"]',
        '[aria-label*="Copy"]',
        '[aria-label*="Copier"]',
        '.copy-button'
    ];
    for (const sel of uiDecorators) {
        clone.querySelectorAll(sel).forEach(el => el.remove());
    }

    return clone.innerText.trim();
}

async function askWebProvider(text, attachments = []) {
    let editor = document.querySelector(provider.input) || findElementDeep(provider.input) || document.querySelector('div[contenteditable="true"], textarea');
    if (!editor) return `Error: Input box not found on ${provider.name}. Please open a fresh chat session.`;

    const getResponses = () => findAssistantResponses();
    const initialResponses = getResponses();
    const initialCount = initialResponses.length;
    const initialLastText = initialCount > 0 ? extractCleanResponse(initialResponses[initialCount - 1]) : "";

    // 1. Attach files natively before filling the lightweight text prompt
    let finalPromptText = text;
    if (attachments && attachments.length > 0) {
        const uploadResult = await uploadAttachmentsToDOM(editor, attachments);
        if (!uploadResult.uploaded) {
            console.error(`[Bridge] Native file upload failed: ${uploadResult.error}`);
            statusLabel.innerText = `🔴 Upload failed: ${uploadResult.error}`;
            return `Error: Native file upload failed on ${provider.name} (${uploadResult.error}). File was not attached to prevent browser freeze caused by massive DOM injection.`;
        }
        console.log(`[Bridge] Successfully attached ${uploadResult.count} file(s) natively via ${uploadResult.method}.`);
    }

    // 2. Fill the concise text prompt into the input box
    fillInputBox(editor, finalPromptText);

    // 3. Wait up to 20s for file upload processing + send button activation (OpenAI/Gemini server upload progress)
    const maxChecks = attachments.length > 0 ? 80 : 20;
    let sendBtn = null;
    for (let i = 0; i < maxChecks; i++) {
        await new Promise(r => setTimeout(r, 250));
        sendBtn = document.querySelector(provider.sendBtn) ||
                  document.querySelector('#composer-submit-button') ||
                  document.querySelector('button[aria-label*="Send" i]') ||
                  document.querySelector('button[aria-label*="Envoyer" i]') ||
                  document.querySelector('button[data-testid="send-button"]') ||
                  document.querySelector('.send-button-container button');

        const isDisabled = !sendBtn || sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true' || sendBtn.className.includes('opacity-50');

        if (sendBtn && !isDisabled) {
            break;
        }
    }

    const isReadyToSend = sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true' && !sendBtn.className.includes('opacity-50');
    if (!isReadyToSend && attachments.length > 0) {
        return `Error: Server upload confirmation timed out on ${provider.name}. Attachment processing was not completed by the server within 20s. Dispatch aborted to protect prompt integrity.`;
    }

    if (isReadyToSend) {
        sendBtn.click();
    } else {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
    }

    return new Promise((resolve) => {
        let lastText = "";
        let stableCount = 0;
        let totalSeconds = 0;
        const START_TIMEOUT_SECONDS = attachments.length > 0 ? 120 : 60;
        const MAX_WAIT_SECONDS = 600; // 10 minutes max for heavy reasoning models

        const checkInterval = setInterval(() => {
            totalSeconds++;
            const responses = getResponses();
            const currentCount = responses.length;
            const currentLastText = currentCount > 0 ? extractCleanResponse(responses[currentCount - 1]) : "";

            const targetElement = responses.length > 0 ? responses[responses.length - 1] : null;
            const isStillStreaming = provider.stopBtn ? document.querySelector(provider.stopBtn) !== null : false;
            
            // Scope reasoning detection to active streaming AND targetElement (Director Directive B)
            const isThinking = isStillStreaming && (
                (targetElement && targetElement.querySelector('[data-testid="thought-content"], [data-testid="reasoning-summary"], .thinking-process, .ds-markdown--thought') !== null) ||
                (targetElement && /réfléchi|thought for|thinking/i.test(targetElement.innerText)) ||
                document.querySelector('.result-streaming') !== null
            );

            // Generation has started if stop button is visible, reasoning is active, or responses changed
            const hasStarted = isStillStreaming || isThinking || currentCount > initialCount || (currentCount > 0 && currentLastText !== initialLastText);

            if (!hasStarted) {
                if (totalSeconds > START_TIMEOUT_SECONDS) {
                    clearInterval(checkInterval);
                    resolve(`Error: Generation did not start on ${provider.name} after ${START_TIMEOUT_SECONDS} seconds. Check if there is a rate limit, file upload spinner, or captcha.`);
                }
                return;
            }

            const latestResponse = extractCleanResponse(targetElement);

            if (!isStillStreaming && !isThinking && latestResponse.length > 0 && latestResponse === lastText) {
                stableCount++;
                if (stableCount >= 3) {
                    clearInterval(checkInterval);
                    resolve(latestResponse);
                }
            } else {
                lastText = latestResponse;
                stableCount = 0;
            }

            if (totalSeconds >= MAX_WAIT_SECONDS) {
                clearInterval(checkInterval);
                resolve(latestResponse.length > 0 ? latestResponse : `Error: Generation timed out after ${MAX_WAIT_SECONDS} seconds.`);
            }
        }, 1000);
    });
}
