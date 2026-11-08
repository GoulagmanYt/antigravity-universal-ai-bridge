/**
 * WebAI Bridge - Popup Controller
 * Manages WebSocket port configuration, per-session authentication token storage,
 * and live status inspection of the active Web AI tab.
 */
(function () {
  'use strict';

  const DEFAULT_PORT = 8765;

  function validatePort(value) {
    const num = Number(value);
    return Number.isInteger(num) && num >= 1024 && num <= 65535 ? num : null;
  }

  function initPopup() {
    if (typeof document === 'undefined') return;

    const portInput = document.getElementById('portInput');
    const tokenInput = document.getElementById('tokenInput');
    const saveBtn = document.getElementById('saveBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const providerValue = document.getElementById('providerValue');
    const uploadStateValue = document.getElementById('uploadStateValue');
    const jobValue = document.getElementById('jobValue');
    const feedbackMsg = document.getElementById('feedbackMsg');
    const debugToggle = document.getElementById('debugToggle');
    const copyLogsBtn = document.getElementById('copyLogsBtn');
    const clearLogsBtn = document.getElementById('clearLogsBtn');

    function setFeedback(text, isError) {
      if (!feedbackMsg) return;
      feedbackMsg.textContent = text;
      feedbackMsg.style.color = isError ? '#ef4444' : '#38bdf8';
    }

    function updateStatusUI(status) {
      if (!status || !status.ok) {
        statusDot.className = 'dot disconnected';
        statusText.textContent = 'Unsupported Tab';
        providerValue.textContent = 'None';
        uploadStateValue.textContent = 'IDLE';
        jobValue.textContent = 'None';
        return;
      }

      providerValue.textContent = status.providerName || status.provider || 'Detected';
      uploadStateValue.textContent = status.uploadState || 'IDLE';
      jobValue.textContent = status.activeRequestId || 'Idle';

      if (status.connected) {
        statusDot.className = status.busy ? 'dot busy' : 'dot connected';
        statusText.textContent = status.busy ? 'Streaming...' : `Connected (:${status.port})`;
      } else {
        statusDot.className = 'dot disconnected';
        statusText.textContent = `Offline (:${status.port || DEFAULT_PORT})`;
      }
    }

    function queryActiveTabStatus() {
      if (typeof chrome === 'undefined' || !chrome.tabs) return;
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (!activeTab || !activeTab.id) {
          updateStatusUI(null);
          return;
        }
        try {
          chrome.tabs.sendMessage(activeTab.id, { type: 'WEBAI_GET_TAB_STATUS' }, (response) => {
            if (chrome.runtime && chrome.runtime.lastError) {
              updateStatusUI(null);
              return;
            }
            updateStatusUI(response);
          });
        } catch (_) {
          updateStatusUI(null);
        }
      });
    }

    // Load saved settings
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['bridgePort', 'bridgeAuthToken', 'debugMode'], (items) => {
        if (portInput) {
          portInput.value = validatePort(items && items.bridgePort) || DEFAULT_PORT;
        }
        if (tokenInput && items && typeof items.bridgeAuthToken === 'string') {
          tokenInput.value = items.bridgeAuthToken;
        }
        if (debugToggle && items) {
          debugToggle.checked = Boolean(items.debugMode);
        }
      });
    }

    if (debugToggle) {
      debugToggle.addEventListener('change', () => {
        const enabled = Boolean(debugToggle.checked);
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ debugMode: enabled }, () => {
            setFeedback(enabled ? 'Debug mode enabled (detailed logs)' : 'Debug mode disabled', false);
            if (chrome.tabs) {
              chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const activeTab = tabs && tabs[0];
                if (activeTab && activeTab.id) {
                  chrome.tabs.sendMessage(activeTab.id, {
                    type: 'WEBAI_SET_DEBUG_MODE',
                    debugMode: enabled
                  });
                }
              });
            }
          });
        }
      });
    }

    if (copyLogsBtn) {
      copyLogsBtn.addEventListener('click', () => {
        if (typeof chrome === 'undefined' || !chrome.tabs) {
          setFeedback('Extension API not available', true);
          return;
        }
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const activeTab = tabs && tabs[0];
          if (!activeTab || !activeTab.id) {
            setFeedback('No active tab found', true);
            return;
          }
          chrome.tabs.sendMessage(activeTab.id, { type: 'WEBAI_GET_DEBUG_LOGS' }, (res) => {
            if (chrome.runtime && chrome.runtime.lastError) {
              setFeedback('Unsupported tab', true);
              return;
            }
            const logs = (res && Array.isArray(res.logs)) ? res.logs : [];
            if (logs.length === 0) {
              setFeedback('No logs in buffer', false);
              return;
            }
            const text = logs.map((l) => `[${l.iso || new Date(l.timestamp).toISOString()}] [${l.category}] [${(l.level || 'info').toUpperCase()}] ${l.message} ${l.details ? JSON.stringify(l.details) : ''}`).join('\n');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(() => {
                setFeedback(`${logs.length} logs copied!`, false);
              }).catch(() => {
                setFeedback('Clipboard error', true);
              });
            } else {
              setFeedback(`${logs.length} logs available`, false);
            }
          });
        });
      });
    }

    if (clearLogsBtn) {
      clearLogsBtn.addEventListener('click', () => {
        if (typeof chrome === 'undefined' || !chrome.tabs) return;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const activeTab = tabs && tabs[0];
          if (!activeTab || !activeTab.id) return;
          chrome.tabs.sendMessage(activeTab.id, { type: 'WEBAI_CLEAR_DEBUG_LOGS' }, () => {
            setFeedback('Log buffer cleared', false);
          });
        });
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const validPort = validatePort(portInput ? portInput.value : DEFAULT_PORT);
        if (!validPort) {
          setFeedback('Port must be between 1024 and 65535', true);
          return;
        }
        const authToken = tokenInput ? tokenInput.value.trim() : '';

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set(
            {
              bridgePort: validPort,
              bridgeAuthToken: authToken
            },
            () => {
              setFeedback(`Saved port ${validPort} & reconnecting...`, false);
              if (chrome.tabs) {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                  const activeTab = tabs && tabs[0];
                  if (activeTab && activeTab.id) {
                    chrome.tabs.sendMessage(
                      activeTab.id,
                      {
                        type: 'WEBAI_RECONFIGURE_BRIDGE',
                        port: validPort,
                        authToken
                      },
                      () => {
                        setTimeout(queryActiveTabStatus, 350);
                      }
                    );
                  }
                });
              }
            }
          );
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        setFeedback('Status refreshed', false);
        queryActiveTabStatus();
      });
    }

    queryActiveTabStatus();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initPopup, { once: true });
    } else {
      initPopup();
    }
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { DEFAULT_PORT, validatePort };
  }
})();
