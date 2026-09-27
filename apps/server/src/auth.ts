import type { FastifyReply, FastifyRequest } from 'fastify';
import { verify } from 'argon2';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ServerConfig } from './config.js';
import type { SqliteRepository } from './database.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

export interface AuthContext {
  readonly sessionId: string;
  readonly csrfHash: string;
  readonly expiresAt: string;
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export class AuthService {
  private readonly loginWindowMs = 15 * 60 * 1_000;
  private readonly loginLockoutMs = 15 * 60 * 1_000;
  private readonly maxLoginFailures = 5;

  constructor(
    private readonly config: ServerConfig,
    private readonly repository: SqliteRepository,
  ) {}

  hash(value: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(value).digest('hex');
  }

  assertOrigin(request: FastifyRequest): void {
    const origin = request.headers.origin;
    if (typeof origin !== 'string') throw new HttpError(403, 'ORIGIN_REQUIRED');
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw new HttpError(403, 'ORIGIN_INVALID');
    }
    if (normalized !== this.config.webOrigin) throw new HttpError(403, 'ORIGIN_DENIED');
  }

  async login(
    username: string,
    password: string,
    ip: string,
  ): Promise<{ token: string; csrfToken: string; expiresAt: string }> {
    const attemptKey = this.hash(`${username.trim().toLowerCase()}\0${ip}`);
    const now = Date.now();
    const state = this.repository.loginState(attemptKey);
    if (
      state?.lockedUntil !== null &&
      state?.lockedUntil !== undefined &&
      state.lockedUntil > now
    ) {
      this.repository.audit('auth.login', 'locked');
      throw new HttpError(429, 'LOGIN_LOCKED');
    }

    const passwordValid = await verify(this.config.passwordHash, password);
    const usernameValid = username === this.config.username;
    if (!passwordValid || !usernameValid) {
      this.repository.recordLoginFailure(
        attemptKey,
        now,
        this.loginWindowMs,
        this.maxLoginFailures,
        this.loginLockoutMs,
      );
      this.repository.audit('auth.login', 'denied');
      throw new HttpError(401, 'INVALID_CREDENTIALS');
    }

    this.repository.clearLoginFailures(attemptKey);
    const token = opaqueToken();
    const csrfToken = opaqueToken();
    const expiresAt = new Date(now + this.config.sessionTtlMs).toISOString();
    this.repository.createSession(this.hash(token), this.hash(csrfToken), expiresAt);
    this.repository.audit('auth.login', 'succeeded');
    return { token, csrfToken, expiresAt };
  }

  authenticate(request: FastifyRequest): AuthContext {
    const token = request.cookies[this.config.cookieName];
    if (!token) throw new HttpError(401, 'AUTH_REQUIRED');
    const session = this.repository.findSession(this.hash(token));
    if (!session) throw new HttpError(401, 'INVALID_SESSION');
    return { sessionId: session.id, csrfHash: session.csrf_hash, expiresAt: session.expires_at };
  }

  assertCsrf(request: FastifyRequest, auth: AuthContext): void {
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string') throw new HttpError(403, 'CSRF_REQUIRED');
    this.assertCsrfToken(token, auth);
  }

  assertCsrfToken(token: string, auth: AuthContext): void {
    const actual = Buffer.from(this.hash(token));
    const expected = Buffer.from(auth.csrfHash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(403, 'CSRF_INVALID');
    }
  }

  setSessionCookie(reply: FastifyReply, token: string, csrfToken: string, expiresAt: string): void {
    reply.setCookie(this.config.cookieName, token, {
      path: '/',
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      expires: new Date(expiresAt),
    });
    reply.setCookie(`${this.config.cookieName}_csrf`, csrfToken, {
      path: '/',
      httpOnly: false,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      expires: new Date(expiresAt),
    });
  }

  clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(this.config.cookieName, {
      path: '/',
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
    });
    reply.clearCookie(`${this.config.cookieName}_csrf`, {
      path: '/',
      httpOnly: false,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
    });
  }
}
