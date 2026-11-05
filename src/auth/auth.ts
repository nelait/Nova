import { createHash } from 'node:crypto';
import type { User } from '../domain/types.ts';
import type { Collection } from '../store/db.ts';
import type { UserDirectory } from '../users/userDirectory.ts';
import { AuthError, OidcClient, randomToken } from './oidc.ts';
import type { SamlClient, SamlSessionRef } from './saml.ts';

/** Server-side session. The id is a hash of the cookie token, so a database leak doesn't expose live sessions. */
export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  /**
   * The provider's session, for single logout. OIDC: the ID token (sent back as
   * id_token_hint), sub and sid. SAML: NameID and SessionIndex. Server-side only.
   */
  oidc?: { idToken: string; sub?: string; sid?: string };
  saml?: SamlSessionRef;
}

/**
 * An IdP-initiated SAML sign-in waiting for the person to confirm it. Keyed by
 * the hash of a token held in a cookie set on this browser only.
 */
export interface PendingIdpSignIn {
  id: string;
  userId: string;
  saml: SamlSessionRef;
  returnTo: string;
  expiresAt: string;
}

/** Outcome of a SAML response at the ACS. */
export type SamlSignInResult =
  | { kind: 'session'; token: string; returnTo: string; user: User }
  /** Unsolicited: show "Continue as …?"; `token` goes in a cookie for /auth/saml/continue. */
  | { kind: 'confirm'; token: string; returnTo: string; user: User; currentUser?: User }
  /** Unsolicited, and this browser is already signed in as that person. */
  | { kind: 'already'; returnTo: string };

/** A back-channel logout token's jti, kept to refuse replays. */
export interface SeenToken {
  id: string;
  at: string;
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
  private seenTokens: Collection<SeenToken>;
  private idpSignIns: Collection<PendingIdpSignIn>;
  private users: UserDirectory;
  private audit: (actor: string, entityId: string, event: string, detail?: unknown) => void;
  private now: () => Date;
  private ttlMs: number;

  constructor(opts: {
    oidc?: OidcClient;
    saml?: SamlClient;
    sessions: Collection<Session>;
    requests: Collection<LoginRequest>;
    seenTokens: Collection<SeenToken>;
    idpSignIns: Collection<PendingIdpSignIn>;
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
    this.seenTokens = opts.seenTokens;
    this.idpSignIns = opts.idpSignIns;
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
  /** The active directory user the provider vouched for, or a refusal (audited). */
  private activeUser(value: string, by: 'email' | 'id', via: AuthMode): User {
    const user = by === 'email' ? this.users.byEmail(value) : this.users.list().find((u) => u.id === value);
    if (!user || !user.active) {
      this.audit('auth', value, 'user.sign-in-refused', { reason: user ? 'inactive' : 'not provisioned', via });
      throw new AuthError(`${value} is not set up in Plan Ops Hub, or the account is deactivated. Ask an administrator to add you.`, 403);
    }
    return user;
  }

  private openSession(value: string, by: 'email' | 'id', via: AuthMode, returnTo: string, idp: Pick<Session, 'oidc' | 'saml'>, detail: Record<string, unknown> = {}): { token: string; returnTo: string; user: User } {
    const user = this.activeUser(value, by, via);
    const token = randomToken();
    const createdAt = this.now();
    this.sessions.insert({ id: hash(token), userId: user.id, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(), ...idp });
    this.audit(user.id, user.id, 'user.signed-in', { via, ...detail });
    return { token, returnTo, user };
  }

  /** Finish SAML sign-in from the posted SAMLResponse and RelayState. */
  /**
   * A SAML response at the ACS.
   *
   * SP-initiated (the RelayState is a sign-in this browser started): the response
   * must answer that request, and the session opens.
   *
   * IdP-initiated (unsolicited; only with SAML_ALLOW_IDP_INITIATED): nothing ties the
   * response to this browser, so someone could post their own valid assertion into
   * another person's browser and have them work in the wrong account (login CSRF).
   * So no session opens yet: the person confirms "Continue as …?", and only this
   * browser (holding the cookie set with that page) can confirm.
   */
  async finishSamlLogin(samlResponse: unknown, relayState: unknown, browserState: string | undefined, currentSession?: string): Promise<SamlSignInResult> {
    if (!this.saml) throw new AuthError('SAML sign-in is not configured', 404);
    if (typeof samlResponse !== 'string' || !samlResponse) throw new AuthError('Sign-in response is missing its SAMLResponse', 400);
    const pending = typeof relayState === 'string' && relayState ? this.requests.get(relayState) : undefined;
    // A sign-in this browser didn't start is refused before the response is looked at.
    if (pending && browserState !== pending.id) throw new AuthError('This sign-in was started in a different browser or has already been used. Start again.', 400);
    const req = pending ? this.takeRequest(relayState, browserState) : undefined;
    const { email, ref, solicited } = await this.saml.verify(samlResponse);
    if (solicited) {
      // Answers some request: it must be the one this browser started.
      if (!req) throw new AuthError('This sign-in was started in a different browser or has already been used. Start again.', 400);
      return { kind: 'session', ...this.openSession(email, 'email', 'saml', req.returnTo, { saml: ref }) };
    }
    // Unsolicited (also if one is posted into a sign-in this browser started).
    const user = this.activeUser(email, 'email', 'saml');
    const returnTo = req?.returnTo ?? safeReturnTo(relayState);
    const current = this.userFor(currentSession);
    if (current?.id === user.id) return { kind: 'already', returnTo };
    const now = this.now();
    for (const old of this.idpSignIns.find((p) => p.expiresAt < now.toISOString())) this.idpSignIns.delete(old.id);
    const token = randomToken();
    this.idpSignIns.insert({ id: hash(token), userId: user.id, saml: ref, returnTo, expiresAt: new Date(now.getTime() + 120_000).toISOString() });
    return { kind: 'confirm', token, returnTo, user, currentUser: current };
  }

  /** The person confirmed an IdP-initiated sign-in on this browser: open the session. */
  confirmIdpSignIn(token: string | undefined): { token: string; returnTo: string; user: User } {
    const p = token ? this.idpSignIns.get(hash(token)) : undefined;
    if (!p) throw new AuthError('This sign-in has expired or was already used. Open Plan Ops Hub from your identity provider again.', 400);
    this.idpSignIns.delete(p.id); // single use
    if (p.expiresAt < this.now().toISOString()) throw new AuthError('This sign-in has expired. Open Plan Ops Hub from your identity provider again.', 400);
    return this.openSession(p.userId, 'id', 'saml', p.returnTo, { saml: p.saml }, { idpInitiated: true });
  }

  /** The person declined an IdP-initiated sign-in. */
  cancelIdpSignIn(token: string | undefined): void {
    if (token) this.idpSignIns.delete(hash(token));
  }

  /**
   * Finish sign-in. `browserState` is the state cookie set by startLogin: it must
   * match, so a callback link from someone else's sign-in can't log this browser in.
   */
  async finishLogin(code: unknown, state: unknown, browserState: string | undefined): Promise<{ token: string; returnTo: string; user: User }> {
    if (!this.oidc) throw new AuthError('OpenID Connect sign-in is not configured', 404);
    if (typeof code !== 'string' || !code) throw new AuthError('Sign-in response is missing its code', 400);
    const req = this.takeRequest(state, browserState);

    const { claims, idToken } = await this.oidc.exchange(code, req.verifier, req.nonce);
    const claim = this.oidc.config.userClaim;
    const value = claims[claim];
    if (typeof value !== 'string' || !value) throw new AuthError(`The identity provider did not send the "${claim}" claim`, 403);
    if (claim === 'email' && claims.email_verified === false) throw new AuthError('Your email address is not verified with the identity provider', 403);
    const oidc = { idToken, sub: typeof claims.sub === 'string' ? claims.sub : undefined, sid: typeof claims.sid === 'string' ? claims.sid : undefined };
    return this.openSession(value, claim === 'email' ? 'email' : 'id', 'oidc', req.returnTo, { oidc });
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

  /** Whether signing out here also signs out at the identity provider. */
  async providerLogout(): Promise<boolean> {
    if (this.oidc) return this.oidc.providerLogoutAvailable().catch(() => false);
    return !!this.saml?.singleLogout;
  }

  /**
   * Sign out. The local session always ends first, so this browser is signed out
   * even if the provider is unreachable. Returns where to send the browser: the
   * provider's logout (single logout), or the signed-out page.
   */
  async logout(token: string | undefined): Promise<string> {
    const s = token ? this.sessions.get(hash(token)) : undefined;
    if (!s) return '/auth/signed-out';
    this.sessions.delete(s.id);
    let to: string | undefined;
    try {
      if (this.oidc && s.oidc) to = await this.oidc.logoutUrl(s.oidc.idToken);
      if (this.saml && s.saml) to = await this.saml.logoutUrl(s.saml);
    } catch {
      to = undefined; // provider metadata unreachable: local sign-out still stands
    }
    this.audit(s.userId, s.userId, 'user.signed-out', { via: 'user', provider: !!to });
    return to ?? '/auth/signed-out';
  }

  /** End every local session the provider says has ended. */
  private endSessions(match: (s: Session) => boolean, via: string): number {
    const ended = this.sessions.find(match);
    for (const s of ended) {
      this.sessions.delete(s.id);
      this.audit('auth', s.userId, 'user.signed-out', { via });
    }
    return ended.length;
  }

  /**
   * OIDC back-channel logout: the provider tells us, server to server, that a
   * session ended (the user signed out elsewhere, or an admin revoked it).
   */
  async backchannelLogout(logoutToken: unknown): Promise<number> {
    if (!this.oidc) throw new AuthError('OpenID Connect sign-in is not configured', 404);
    if (typeof logoutToken !== 'string' || !logoutToken) throw new AuthError('Missing logout_token', 400);
    const t = await this.oidc.verifyLogoutToken(logoutToken);
    const cutoff = new Date(this.now().getTime() - 3_600_000).toISOString();
    for (const old of this.seenTokens.find((x) => x.at < cutoff)) this.seenTokens.delete(old.id);
    if (this.seenTokens.get(t.jti)) throw new AuthError('This logout token was already used', 400);
    this.seenTokens.insert({ id: t.jti, at: this.now().toISOString() });
    // A sid ends that one session; a sub alone ends all of that user's sessions.
    return this.endSessions((s) => !!s.oidc && (t.sid ? s.oidc.sid === t.sid && (!t.sub || s.oidc.sub === t.sub) : s.oidc.sub === t.sub), 'idp-backchannel');
  }

  /**
   * SAML front-channel single logout at /auth/saml/slo. A LogoutRequest from the
   * provider ends the matching sessions and returns the LogoutResponse redirect;
   * a LogoutResponse (to our own request) returns the signed-out page.
   */
  async samlSlo(method: 'GET' | 'POST', params: URLSearchParams, rawQuery: string): Promise<{ redirect: string; confirmed: boolean }> {
    if (!this.saml) throw new AuthError('SAML sign-in is not configured', 404);
    const msg = await this.saml.handleSlo(method, params, rawQuery);
    if (msg.kind === 'response') return { redirect: '/auth/signed-out', confirmed: msg.ok };
    const { ref } = msg;
    this.endSessions((s) => !!s.saml && s.saml.nameID === ref.nameID && (!ref.sessionIndex || s.saml.sessionIndex === ref.sessionIndex), 'idp-slo');
    return { redirect: await this.saml.logoutResponseUrl(msg.reply, msg.relayState), confirmed: true };
  }

  private purge(): void {
    const now = this.now().toISOString();
    for (const r of this.requests.find((r) => r.expiresAt < now)) this.requests.delete(r.id);
    for (const s of this.sessions.find((s) => s.expiresAt < now)) this.sessions.delete(s.id);
  }
}
