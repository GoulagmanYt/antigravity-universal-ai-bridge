/**
 * WebAI Bridge - Configurable Port & Per-Session WebSocket Authentication Manager
 * Generates cryptographic 256-bit session tokens, validates WebSocket Origins (anti-CSWSH),
 * manages session handshakes, and persists local session metadata with 0600 permissions.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_WS_PORT = 8765;
export const MIN_VALID_PORT = 1024;
export const MAX_VALID_PORT = 65535;

export const ALLOWED_WS_ORIGINS = [
  /^chrome-extension:\/\/[a-z]{32}$/i,
  /^moz-extension:\/\/[a-f0-9-]+$/i,
  /^https:\/\/([a-z0-9-]+\.)?gemini\.google\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)?claude\.ai$/i,
  /^https:\/\/([a-z0-9-]+\.)?chatgpt\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)?chat\.openai\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)?chat\.deepseek\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)?aistudio\.google\.com$/i
];

/**
 * Parses and validates a port number from CLI args, environment variables, or fallback.
 * Priority: explicit override -> CLI `--port` -> `WEBAI_BRIDGE_PORT` -> `ANTIGRAVITY_BRIDGE_PORT` -> `BRIDGE_PORT` -> 8765.
 * @param {object} [options]
 * @param {number|string} [options.port]
 * @param {string[]} [options.argv]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {number}
 */
export function resolveBridgePort(options = {}) {
  const argv = options.argv || process.argv || [];
  const env = options.env || process.env || {};

  let candidate = options.port;

  if (candidate === undefined || candidate === null || candidate === '') {
    const portFlagIdx = argv.indexOf('--port');
    if (portFlagIdx !== -1 && argv[portFlagIdx + 1]) {
      candidate = argv[portFlagIdx + 1];
    } else {
      const eqArg = argv.find((arg) => typeof arg === 'string' && arg.startsWith('--port='));
      if (eqArg) {
        candidate = eqArg.split('=')[1];
      }
    }
  }

  if (candidate === undefined || candidate === null || candidate === '') {
    candidate = env.WEBAI_BRIDGE_PORT || env.ANTIGRAVITY_BRIDGE_PORT || env.BRIDGE_PORT || DEFAULT_WS_PORT;
  }

  const parsed = Number(candidate);
  if (!Number.isInteger(parsed) || parsed < MIN_VALID_PORT || parsed > MAX_VALID_PORT) {
    throw new Error(
      `Invalid WebAI Bridge port "${candidate}". Must be an integer between ${MIN_VALID_PORT} and ${MAX_VALID_PORT}.`
    );
  }

  return parsed;
}

/**
 * Generates a cryptographically strong random hex token (32 bytes = 64 hex chars by default).
 * @param {number} [byteLength=32]
 * @returns {string}
 */
export function generateSessionToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks on token verification.
 * @param {string} expected
 * @param {string} provided
 * @returns {boolean}
 */
export function safeTokenCompare(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const bufA = Buffer.from(expected, 'utf8');
  const bufB = Buffer.from(provided, 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates whether a WebSocket Origin header is permitted to connect.
 * @param {string|undefined} origin
 * @returns {boolean}
 */
export function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== 'string') {
    // Allow local Node test clients that do not send a browser Origin header
    return true;
  }
  const cleanOrigin = origin.trim();
  return ALLOWED_WS_ORIGINS.some((pattern) => pattern.test(cleanOrigin));
}

/**
 * Manages per-session authentication tokens, active connection secrets, and session file discovery.
 */
export class SessionAuthManager {
  /**
   * @param {object} [options]
   * @param {number} [options.port]
   * @param {string} [options.token]
   * @param {boolean} [options.requireToken] - If true, rejects handshakes that lack the master token.
   * @param {string} [options.sessionFilePath]
   * @param {string[]} [options.argv]
   * @param {NodeJS.ProcessEnv} [options.env]
   */
  constructor(options = {}) {
    this.port = resolveBridgePort({ port: options.port, argv: options.argv, env: options.env });
    const env = options.env || process.env || {};
    this.sessionToken =
      options.token ||
      env.WEBAI_BRIDGE_TOKEN ||
      generateSessionToken(32);
    this.requireToken =
      options.requireToken !== undefined
        ? Boolean(options.requireToken)
        : Boolean(options.token || env.WEBAI_BRIDGE_TOKEN || env.WEBAI_BRIDGE_STRICT_AUTH === '1');
    this.sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;
    this.startedAt = new Date().toISOString();
    this.sessionFilePath =
      options.sessionFilePath ||
      path.join(os.homedir(), '.webai-bridge', 'session.json');
    this.connectionSecrets = new Map();
  }

  /**
   * Writes the current session metadata (port, token, pid, timestamp) to disk with 0600 permissions.
   * @returns {string} Path to the written session file
   */
  persistSessionFile() {
    const dir = path.dirname(this.sessionFilePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = {
      sessionId: this.sessionId,
      port: this.port,
      token: this.sessionToken,
      requireToken: this.requireToken,
      pid: process.pid,
      startedAt: this.startedAt
    };
    fs.writeFileSync(this.sessionFilePath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    return this.sessionFilePath;
  }

  /**
   * Removes the session file on graceful shutdown.
   */
  cleanupSessionFile() {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        fs.unlinkSync(this.sessionFilePath);
      }
    } catch (_) {
      // Ignore cleanup errors
    }
  }

  /**
   * Extracts a token from a WebSocket upgrade request URL (`/?token=...`) or header.
   * @param {object} req - HTTP Upgrade request
   * @returns {string}
   */
  extractRequestToken(req) {
    if (!req) return '';
    const headerToken = req.headers && (req.headers['x-webai-bridge-token'] || req.headers['authorization']);
    if (typeof headerToken === 'string' && headerToken.trim()) {
      return headerToken.replace(/^Bearer\s+/i, '').trim();
    }
    if (typeof req.url === 'string') {
      try {
        const parsed = new URL(req.url, `http://127.0.0.1:${this.port}`);
        return (parsed.searchParams.get('token') || '').trim();
      } catch (_) {
        return '';
      }
    }
    return '';
  }

  /**
   * Verifies an incoming HTTP Upgrade / WebSocket handshake request.
   * @param {object} req
   * @returns {{ ok: boolean, code?: string, reason?: string, tokenVerified: boolean }}
   */
  verifyUpgradeRequest(req) {
    const origin = req && req.headers ? req.headers.origin : undefined;
    if (!isAllowedOrigin(origin)) {
      return {
        ok: false,
        code: 'ERR_WS_FORBIDDEN_ORIGIN',
        reason: `Origin "${origin}" is not permitted to connect to WebAI Bridge`,
        tokenVerified: false
      };
    }

    const candidateToken = this.extractRequestToken(req);
    const tokenVerified = candidateToken.length > 0 && safeTokenCompare(this.sessionToken, candidateToken);

    if (this.requireToken && !tokenVerified) {
      return {
        ok: false,
        code: 'ERR_WS_INVALID_TOKEN',
        reason: 'Missing or invalid WebSocket session authentication token',
        tokenVerified: false
      };
    }

    return {
      ok: true,
      tokenVerified
    };
  }

  /**
   * Issues a per-connection ephemeral secret upon receiving `AUTH_HELLO` from a content script.
   * @param {object} ws - WebSocket connection instance
   * @param {object} helloMsg - Parsed AUTH_HELLO message
   * @returns {{ ok: boolean, sessionSecret?: string, code?: string, reason?: string }}
   */
  authenticateConnection(ws, helloMsg = {}) {
    const providedToken = typeof helloMsg.authToken === 'string' ? helloMsg.authToken.trim() : '';

    if (this.requireToken && !safeTokenCompare(this.sessionToken, providedToken)) {
      const alreadyVerified = Boolean(ws && ws._tokenVerifiedOnUpgrade);
      if (!alreadyVerified) {
        return {
          ok: false,
          code: 'ERR_WS_AUTH_FAILED',
          reason: 'Invalid session token in AUTH_HELLO handshake'
        };
      }
    }

    const sessionSecret = generateSessionToken(24);
    this.connectionSecrets.set(ws, {
      sessionSecret,
      provider: helloMsg.provider || 'unknown',
      authenticatedAt: Date.now()
    });
    return {
      ok: true,
      sessionSecret
    };
  }

  /**
   * Validates that an incoming message from a WebSocket connection carries the assigned session secret
   * (or valid master sessionToken).
   * @param {object} ws
   * @param {object} msg
   * @returns {boolean}
   */
  validateMessageAuth(ws, msg = {}) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'AUTH_HELLO') return true;

    const record = this.connectionSecrets.get(ws);
    if (record && typeof msg.sessionSecret === 'string') {
      if (safeTokenCompare(record.sessionSecret, msg.sessionSecret)) {
        return true;
      }
    }

    if (typeof msg.authToken === 'string' && safeTokenCompare(this.sessionToken, msg.authToken)) {
      return true;
    }

    return !this.requireToken;
  }

  /**
   * Removes connection state when a WebSocket closes.
   * @param {object} ws
   */
  revokeConnection(ws) {
    this.connectionSecrets.delete(ws);
  }
}
