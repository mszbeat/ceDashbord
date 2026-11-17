'use strict';

const crypto = require('node:crypto');
const { config, parseDurationMs } = require('../../services/config');
const { getActionLogger } = require('../../services/logger/action-logger.service');
const { error: authError } = require('./config');

const REFRESH_COOKIE_NAME = 'ce_refresh';

function loadSessionTimings() {
  let sessionExpireTime = parseDurationMs(process.env.SESSION_EXPIRE_MS, config.sessionExpireMs || 300000);
  let maxIdleTime = parseDurationMs(process.env.SESSION_IDLE_MS, config.sessionIdleMs || 120000);
  try {
    const smCfg = require('../../project-config/dev/dependencies/partSessionManagerConfig');
    if (!process.env.SESSION_EXPIRE_MS && Number.isFinite(Number(smCfg?.global?.sessionExpireTime))) {
      sessionExpireTime = Number(smCfg.global.sessionExpireTime);
    }
    if (!process.env.SESSION_IDLE_MS && Number.isFinite(Number(smCfg?.global?.maxIdleTime))) {
      maxIdleTime = Number(smCfg.global.maxIdleTime);
    }
  } catch {
    // استفاده از مقادیر پیشفرض
  }
  return {
    accessExpireMs: sessionExpireTime,
    idleExpireMs: maxIdleTime,
  };
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles) || !roles.length) return ['visitor'];
  return roles.map((r) => String(r).trim()).filter(Boolean);
}

function parseRolesJson(value) {
  if (Array.isArray(value)) return normalizeRoles(value);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeRoles(parsed);
    } catch {
      // ignore
    }
  }
  return ['visitor'];
}

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    id BIGSERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    family_id TEXT NOT NULL,
    username TEXT NOT NULL,
    roles JSONB NOT NULL DEFAULT '["visitor"]'::jsonb,
    remember_me BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL,
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    replaced_by_hash TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_username ON auth_refresh_tokens(username)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_family ON auth_refresh_tokens(family_id)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_expires ON auth_refresh_tokens(expires_at)`,
];

class RefreshTokenService {
  constructor(options = {}) {
    this._explicitDb = options.db;
    this.useMemoryOnly = Boolean(options.useMemoryOnly);
    this._fixedTtlMs = options.ttlMs !== undefined ? Number(options.ttlMs) : null;
    this._fixedRememberTtlMs = options.rememberTtlMs !== undefined ? Number(options.rememberTtlMs) : null;
    this._mem = new Map();
    this._ensurePromise = null;
    this._ensuredDb = null;
  }

  get ttlMs() {
    if (this._fixedTtlMs !== null) return this._fixedTtlMs;
    return parseDurationMs(
      process.env.REFRESH_TOKEN_TTL_MS || process.env.REFRESH_TOKEN_TTL,
      config.refreshTokenTtlMs || 24 * 60 * 60 * 1000,
    );
  }

  get rememberTtlMs() {
    if (this._fixedRememberTtlMs !== null) return this._fixedRememberTtlMs;
    return parseDurationMs(
      process.env.REFRESH_TOKEN_REMEMBER_TTL_MS || process.env.REFRESH_TOKEN_REMEMBER_TTL,
      config.refreshTokenRememberTtlMs || 14 * 24 * 60 * 60 * 1000,
    );
  }

  #resolveDb() {
    if (this.useMemoryOnly) return null;
    if (this._explicitDb !== undefined) return this._explicitDb;
    try {
      const { getServices } = require('../../services/container');
      const services = getServices();
      return services?.db || null;
    } catch {
      return null;
    }
  }

  async #ensureTable(db) {
    if (!db) return;
    if (this._ensuredDb === db && this._ensurePromise) {
      return this._ensurePromise;
    }
    this._ensuredDb = db;
    this._ensurePromise = (async () => {
      try {
        for (const stmt of DDL_STATEMENTS) {
          await db.query(stmt);
        }
      } catch (err) {
        this._ensurePromise = null;
        this._ensuredDb = null;
        throw err;
      }
    })();
    return this._ensurePromise;
  }

  getTimings() {
    return loadSessionTimings();
  }

  async issue({ username, roles, rememberMe = false, ip = null, userAgent = null, familyId = null }) {
    if (!username) throw authError.usernameRequired;
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const family = familyId || crypto.randomUUID();
    const normalizedRoles = normalizeRoles(roles);
    const isRemember = Boolean(rememberMe);
    const ttlMs = isRemember ? this.rememberTtlMs : this.ttlMs;
    const expiresAt = new Date(Date.now() + ttlMs);
    const safeUa = userAgent ? String(userAgent).slice(0, 500) : null;
    const safeIp = ip ? String(ip).slice(0, 100) : null;

    const db = this.#resolveDb();
    if (!db) {
      this._mem.set(tokenHash, {
        tokenHash,
        familyId: family,
        username,
        roles: normalizedRoles,
        rememberMe: isRemember,
        expiresAt,
        rotatedAt: null,
        revokedAt: null,
        replacedByHash: null,
        ip: safeIp,
        userAgent: safeUa,
        createdAt: new Date(),
        lastUsedAt: null,
      });
      return {
        rawToken,
        tokenHash,
        familyId: family,
        username,
        roles: normalizedRoles,
        rememberMe: isRemember,
        expiresAt,
        ttlMs,
      };
    }

    await this.#ensureTable(db);
    await db.query(
      `INSERT INTO auth_refresh_tokens (
        token_hash, family_id, username, roles, remember_me, expires_at, ip, user_agent
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [tokenHash, family, username, JSON.stringify(normalizedRoles), isRemember, expiresAt.toISOString(), safeIp, safeUa],
    );

    if (Math.random() < 0.05) {
      db.query(`DELETE FROM auth_refresh_tokens WHERE expires_at < now() - interval '1 day'`).catch(() => {});
    }

    return {
      rawToken,
      tokenHash,
      familyId: family,
      username,
      roles: normalizedRoles,
      rememberMe: isRemember,
      expiresAt,
      ttlMs,
    };
  }

  async peek(rawToken) {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 16) {
      return { valid: false, reason: 'missing' };
    }
    const tokenHash = hashToken(rawToken);
    const db = this.#resolveDb();
    if (!db) {
      const entry = this._mem.get(tokenHash);
      if (!entry) return { valid: false, reason: 'not_found' };
      if (entry.revokedAt) return { valid: false, reason: 'revoked' };
      if (entry.rotatedAt) return { valid: false, reason: 'rotated' };
      if (entry.expiresAt.getTime() <= Date.now()) return { valid: false, reason: 'expired' };
      return {
        valid: true,
        username: entry.username,
        roles: entry.roles,
        rememberMe: entry.rememberMe,
        expiresAt: entry.expiresAt,
        familyId: entry.familyId,
      };
    }

    await this.#ensureTable(db);
    const res = await db.query(
      `SELECT username, roles, remember_me, expires_at, rotated_at, revoked_at, family_id
         FROM auth_refresh_tokens
        WHERE token_hash = $1
        LIMIT 1`,
      [tokenHash],
    );
    const row = res.rows?.[0];
    if (!row) return { valid: false, reason: 'not_found' };
    if (row.revoked_at) return { valid: false, reason: 'revoked' };
    if (row.rotated_at) return { valid: false, reason: 'rotated' };
    const expiresAt = new Date(row.expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    return {
      valid: true,
      username: row.username,
      roles: parseRolesJson(row.roles),
      rememberMe: Boolean(row.remember_me),
      expiresAt,
      familyId: row.family_id,
    };
  }

  async rotate(rawToken, options = {}) {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 16) {
      throw authError.invalidRefreshToken;
    }
    const tokenHash = hashToken(rawToken);
    const nextRawToken = generateRawToken();
    const nextHash = hashToken(nextRawToken);
    const safeUa = options.userAgent ? String(options.userAgent).slice(0, 500) : null;
    const safeIp = options.ip ? String(options.ip).slice(0, 100) : null;

    const db = this.#resolveDb();
    if (!db) {
      const entry = this._mem.get(tokenHash);
      if (!entry) throw authError.invalidRefreshToken;
      if (entry.rotatedAt) {
        for (const item of this._mem.values()) {
          if (item.familyId === entry.familyId && !item.revokedAt) {
            item.revokedAt = new Date();
          }
        }
        getActionLogger().warn({
          category: 'auth',
          action: 'auth.refresh.reuse_detected',
          actor: entry.username,
          statusCode: 401,
          errorCode: 'refreshTokenRevoked',
          message: 'Rotated refresh token reuse detected; token family revoked',
          meta: { familyId: entry.familyId },
        });
        throw authError.refreshTokenRevoked;
      }
      if (entry.revokedAt) throw authError.refreshTokenRevoked;
      if (entry.expiresAt.getTime() <= Date.now()) throw authError.refreshTokenExpired;

      const now = new Date();
      entry.rotatedAt = now;
      entry.lastUsedAt = now;
      entry.replacedByHash = nextHash;

      const roles = options.roles ? normalizeRoles(options.roles) : entry.roles;
      const ttlMs = entry.rememberMe ? this.rememberTtlMs : this.ttlMs;
      const nextExpiresAt = new Date(Date.now() + ttlMs);
      this._mem.set(nextHash, {
        tokenHash: nextHash,
        familyId: entry.familyId,
        username: entry.username,
        roles,
        rememberMe: entry.rememberMe,
        expiresAt: nextExpiresAt,
        rotatedAt: null,
        revokedAt: null,
        replacedByHash: null,
        ip: safeIp,
        userAgent: safeUa,
        createdAt: now,
        lastUsedAt: null,
      });
      return {
        rawToken: nextRawToken,
        tokenHash: nextHash,
        familyId: entry.familyId,
        username: entry.username,
        roles,
        rememberMe: entry.rememberMe,
        expiresAt: nextExpiresAt,
        ttlMs,
      };
    }

    await this.#ensureTable(db);
    const consumedRes = await db.query(
      `UPDATE auth_refresh_tokens
          SET rotated_at = now(), last_used_at = now(), replaced_by_hash = $2
        WHERE token_hash = $1
          AND rotated_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING family_id, username, roles, remember_me`,
      [tokenHash, nextHash],
    );

    const consumed = consumedRes.rows?.[0];
    if (!consumed) {
      const inspectRes = await db.query(
        `SELECT family_id, rotated_at, revoked_at, expires_at
           FROM auth_refresh_tokens
          WHERE token_hash = $1
          LIMIT 1`,
        [tokenHash],
      );
      const existing = inspectRes.rows?.[0];
      if (!existing) throw authError.invalidRefreshToken;
      if (existing.rotated_at) {
        await db.query(
          `UPDATE auth_refresh_tokens
              SET revoked_at = COALESCE(revoked_at, now())
            WHERE family_id = $1`,
          [existing.family_id],
        );
        getActionLogger().warn({
          category: 'auth',
          action: 'auth.refresh.reuse_detected',
          statusCode: 401,
          errorCode: 'refreshTokenRevoked',
          message: 'Rotated refresh token reuse detected; DB token family revoked',
          meta: { familyId: existing.family_id },
        });
        throw authError.refreshTokenRevoked;
      }
      if (existing.revoked_at) throw authError.refreshTokenRevoked;
      throw authError.refreshTokenExpired;
    }

    const roles = options.roles ? normalizeRoles(options.roles) : parseRolesJson(consumed.roles);
    const rememberMe = Boolean(consumed.remember_me);
    const ttlMs = rememberMe ? this.rememberTtlMs : this.ttlMs;
    const nextExpiresAt = new Date(Date.now() + ttlMs);

    await db.query(
      `INSERT INTO auth_refresh_tokens (
        token_hash, family_id, username, roles, remember_me, expires_at, ip, user_agent
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        nextHash,
        consumed.family_id,
        consumed.username,
        JSON.stringify(roles),
        rememberMe,
        nextExpiresAt.toISOString(),
        safeIp,
        safeUa,
      ],
    );

    return {
      rawToken: nextRawToken,
      tokenHash: nextHash,
      familyId: consumed.family_id,
      username: consumed.username,
      roles,
      rememberMe,
      expiresAt: nextExpiresAt,
      ttlMs,
    };
  }

  async revoke(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return;
    const tokenHash = hashToken(rawToken);
    const db = this.#resolveDb();
    if (!db) {
      const entry = this._mem.get(tokenHash);
      if (!entry) return;
      const now = new Date();
      for (const item of this._mem.values()) {
        if (item.familyId === entry.familyId && !item.revokedAt) {
          item.revokedAt = now;
        }
      }
      return;
    }
    await this.#ensureTable(db);
    const res = await db.query(
      `SELECT family_id FROM auth_refresh_tokens WHERE token_hash = $1 LIMIT 1`,
      [tokenHash],
    );
    const familyId = res.rows?.[0]?.family_id;
    if (familyId) {
      await db.query(
        `UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1`,
        [familyId],
      );
    } else {
      await db.query(
        `UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE token_hash = $1`,
        [tokenHash],
      );
    }
  }

  async revokeUser(username) {
    if (!username) return;
    getActionLogger().info({
      category: 'auth',
      action: 'auth.refresh.revoked_user',
      meta: { targetUsername: username },
    });
    const db = this.#resolveDb();
    if (!db) {
      const now = new Date();
      for (const item of this._mem.values()) {
        if (item.username === username && !item.revokedAt) {
          item.revokedAt = now;
        }
      }
      return;
    }
    await this.#ensureTable(db);
    await db.query(
      `UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE username = $1 AND revoked_at IS NULL`,
      [username],
    );
  }
}

module.exports = {
  RefreshTokenService,
  REFRESH_COOKIE_NAME,
  hashToken,
  loadSessionTimings,
};
