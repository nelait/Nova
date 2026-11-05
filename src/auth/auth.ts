import { createHash } from 'node:crypto';
import type { User } from '../domain/types.ts';
import type { Collection } from '../store/db.ts';
import type { UserDirectory } from '../users/userDirectory.ts';
import { AuthError, OidcClient, randomToken } from './oidc.ts';
import type { SamlClient } from './saml.ts';

/** Server-side session. The id is a hash of the cookie token, so a database leak doesn't expose live sessions. */
export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** A sign-in in progress, keyed by the OAuth `state`. Lives for 10 minutes. */
export interface LoginRequest {
  id: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: string;
}

export type AuthMode = 'oidc' | 'saml' | 'dev';

const hash = (token: string) => createHash('sha256').update(token).digest('base64url');

/** Only same-site paths: "/x" but not "//evil.example" or "/\\evil". */
export function safeReturnTo(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') && !/[\r\n]/.test(s) ? s : '/';
}

export class AuthService {
  readonly mode: AuthMode;
  readonly oidc?: OidcClient;
  readonly saml?: SamlClient;
  private sessions: Collection<Session>;
  private requests: Collection<LoginRequest>;
  private users: UserDirectory;
  private audit: (actor: string, entityId: string, event: string, detail?: unknown) => void;
  private now: () => Date;
  private ttlMs: number;

  constructor(opts: {
    oidc?: OidcClient;
    saml?: SamlClient;
    sessions: Collection<Session>;
    requests: Collection<LoginRequest>;
    users: UserDirectory;
    audit: (actor: string, entityId: string, event: string, detail?: unknown) => void;
    now: () => Date;
    sessionHours?: number;
  }) {
    if (opts.oidc && opts.saml) throw new Error('Configure either OpenID Connect (OIDC_*) or SAML (SAML_*), not both');
    this.mode = opts.oidc ? 'oidc' : opts.saml ? 'saml' : 'dev';
    this.oidc = opts.oidc;
    this.saml = opts.saml;
    this.sessions = opts.sessions;
    this.requests = opts.requests;
    this.users = opts.users;
    this.audit = opts.audit;
    this.now = opts.now;
    this.ttlMs = (opts.sessionHours ?? 8) * 3_600_000;
  }

  get secureCookies(): boolean {
    return !!(this.oidc?.config.redirectUri ?? this.saml?.config.acsUrl)?.startsWith('https://');
  }

  get sessionSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  /** Begin sign-in: returns the provider URL and the state to bind to this browser. */
  async startLogin(returnTo: unknown): Promise<{ url: string; state: string }> {
    if (!this.oidc && !this.saml) throw new AuthError('Single sign-on is not configured', 404);
    this.purge();
    const state = randomToken();
    const nonce = this.oidc ? randomToken() : '';
    const verifier = this.oidc ? randomToken(48) : '';
    this.requests.insert({ id: state, nonce, verifier, returnTo: safeReturnTo(returnTo), expiresAt: new Date(this.now().getTime() + 600_000).toISOString() });
    // SAML: the state travels as RelayState and comes back with the response.
    const url = this.oidc ? await this.oidc.authorizationUrl(state, nonce, verifier) : await this.saml!.authorizationUrl(state);
    return { url, state };
  }

  /** Checks the returned state against this browser's cookie and uses it up. */
  private takeRequest(state: unknown, browserState: string | undefined): LoginRequest {
    if (typeof state !== 'string' || !state) throw new AuthError('Sign-in response is missing its state', 400);
    if (!browserState || browserState !== state) throw new AuthError('This sign-in was started in a different browser or has already been used. Start again.', 400);
    const req = this.requests.get(state);
    if (!req) throw new AuthError('This sign-in has expired or was already used. Start again.', 400);
    this.requests.delete(state); // single use
    if (req.expiresAt < this.now().toISOString()) throw new AuthError('This sign-in has expired. Start again.', 400);
    return req;
  }

  /** Map the identity the provider vouched for to an active directory user and open a session. */
  private openSession(value: string, by: 'email' | 'id', via: AuthMode, returnTo: string): { token: string; returnTo: string; user: User } {
    const user = by === 'email' ? this.users.byEmail(value) : this.users.list().find((u) => u.id === value);
    if (!user || !user.active) {
      this.audit('auth', value, 'user.sign-in-refused', { reason: user ? 'inactive' : 'not provisioned', via });
      throw new AuthError(`${value} is not set up in Plan Ops Hub, or the account is deactivated. Ask an administrator to add you.`, 403);
    }
    const token = randomToken();
    const createdAt = this.now();
    this.sessions.insert({ id: hash(token), userId: user.id, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString() });
    this.audit(user.id, user.id, 'user.signed-in', { via });
    return { token, returnTo, user };
  }

  /** Finish SAML sign-in from the posted SAMLResponse and RelayState. */
  async finishSamlLogin(samlResponse: unknown, relayState: unknown, browserState: string | undefined): Promise<{ token: string; returnTo: string; user: User }> {
    if (!this.saml) throw new AuthError('SAML sign-in is not configured', 404);
    if (typeof samlResponse !== 'string' || !samlResponse) throw new AuthError('Sign-in response is missing its SAMLResponse', 400);
    const req = this.takeRequest(relayState, browserState);
    const { email } = await this.saml.verify(samlResponse);
    return this.openSession(email, 'email', 'saml', req.returnTo);
  }

  /**
   * Finish sign-in. `browserState` is the state cookie set by startLogin: it must
   * match, so a callback link from someone else's sign-in can't log this browser in.
   */
  async finishLogin(code: unknown, state: unknown, browserState: string | undefined): Promise<{ token: string; returnTo: string; user: User }> {
    if (!this.oidc) throw new AuthError('OpenID Connect sign-in is not configured', 404);
    if (typeof code !== 'string' || !code) throw new AuthError('Sign-in response is missing its code', 400);
    const req = this.takeRequest(state, browserState);

    const claims = await this.oidc.exchange(code, req.verifier, req.nonce);
    const claim = this.oidc.config.userClaim;
    const value = claims[claim];
    if (typeof value !== 'string' || !value) throw new AuthError(`The identity provider did not send the "${claim}" claim`, 403);
    if (claim === 'email' && claims.email_verified === false) throw new AuthError('Your email address is not verified with the identity provider', 403);
    return this.openSession(value, claim === 'email' ? 'email' : 'id', 'oidc', req.returnTo);
  }

  /** The signed-in user for a session cookie, or undefined. Deactivated users lose access at once. */
  userFor(token: string | undefined): User | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(hash(token));
    if (!s) return undefined;
    if (s.expiresAt < this.now().toISOString()) {
      this.sessions.delete(s.id);
      return undefined;
    }
    const u = this.users.get(s.userId);
    return u?.active ? u : undefined;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const s = this.sessions.get(hash(token));
    if (s) {
      this.sessions.delete(s.id);
      this.audit(s.userId, s.userId, 'user.signed-out');
    }
  }

  private purge(): void {
    const now = this.now().toISOString();
    for (const r of this.requests.find((r) => r.expiresAt < now)) this.requests.delete(r.id);
    for (const s of this.sessions.find((s) => s.expiresAt < now)) this.sessions.delete(s.id);
  }
}
