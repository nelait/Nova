import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { HttpRequest, HttpResponse } from '../integrations/client.ts';

/**
 * A tiny OpenID Connect provider for tests and the `npm run demo:sso` walkthrough.
 * It signs real RS256 ID tokens and enforces PKCE, so the app's sign-in code runs
 * exactly as it would against Okta or Entra ID. Development use only: anyone can
 * sign in as any listed person.
 */
export interface MockPerson {
  email: string;
  name: string;
  emailVerified?: boolean;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string;
  challenge: string;
  person: MockPerson;
  sid: string;
  expires: number;
}

export class MockIdp {
  readonly issuer: string;
  readonly clientId: string;
  readonly people: MockPerson[];
  private privateKey: KeyObject;
  private jwk: object;
  private codes = new Map<string, PendingCode>();
  /** Lets tests tamper with the next ID token's claims (wrong audience, expired, ...). */
  claimOverrides: Record<string, unknown> = {};
  /** Signed-in sessions at this provider: sid -> person. */
  readonly sessions = new Map<string, MockPerson>();
  /** The app's back-channel logout URL, for "sign out everywhere" on the demo page. */
  backchannelLogoutUri?: string;

  constructor(opts: { issuer: string; clientId: string; people: MockPerson[] }) {
    this.issuer = opts.issuer;
    this.clientId = opts.clientId;
    this.people = opts.people;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-1', alg: 'RS256', use: 'sig' };
  }

  /**
   * The provider's sign-in step: checks the authorization request and returns the
   * redirect back to the app with a one-time code (as if `email` had signed in).
   */
  authorize(authorizationUrl: string, email: string): string {
    const u = new URL(authorizationUrl);
    const q = u.searchParams;
    if (q.get('client_id') !== this.clientId) throw new Error('unknown client_id');
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') throw new Error('unsupported request');
    const person = this.people.find((p) => p.email === email) ?? { email, name: email };
    const code = randomBytes(16).toString('base64url');
    const sid = randomBytes(12).toString('base64url');
    this.sessions.set(sid, person);
    this.codes.set(code, {
      sid,
      clientId: this.clientId,
      redirectUri: q.get('redirect_uri')!,
      nonce: q.get('nonce')!,
      challenge: q.get('code_challenge')!,
      person,
      expires: Date.now() + 60_000,
    });
    const back = new URL(q.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state')!);
    return back.toString();
  }

  /** Signs an ID token (exported so tests can forge bad ones). */
  idToken(claims: Record<string, unknown>, key: KeyObject = this.privateKey, kid = 'mock-1', typ = 'JWT'): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', typ, kid });
    const body = enc(claims);
    return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
  }

  /** A back-channel logout token for a session (sid) and/or user (sub). */
  logoutToken(o: { sid?: string; sub?: string; extra?: Record<string, unknown>; key?: KeyObject } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: this.clientId,
      iat: now,
      exp: now + 120,
      jti: randomBytes(12).toString('hex'),
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      ...(o.sid ? { sid: o.sid } : {}),
      ...(o.sub ? { sub: o.sub } : {}),
      ...o.extra,
    };
    return this.idToken(claims, o.key, 'mock-1', 'logout+jwt');
  }

  /** The provider's end-session step: forgets the session and returns where to send the browser. */
  endSession(endSessionUrl: string): string {
    const q = new URL(endSessionUrl).searchParams;
    if (q.get('client_id') !== this.clientId) throw new Error('unknown client_id');
    const hint = q.get('id_token_hint');
    if (hint) {
      const claims = JSON.parse(Buffer.from(hint.split('.')[1], 'base64url').toString('utf8')) as { sid?: string };
      if (claims.sid) this.sessions.delete(claims.sid);
    }
    return q.get('post_logout_redirect_uri') ?? '/';
  }

  /** Transport for the app's OIDC client: discovery, JWKS and token endpoints. */
  transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const path = new URL(req.url).pathname;
    const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
    if (path.endsWith('/.well-known/openid-configuration')) {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        end_session_endpoint: `${this.issuer}/logout`,
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
      });
    }
    if (path.endsWith('/jwks')) return json(200, { keys: [this.jwk] });
    if (path.endsWith('/token') && req.method === 'POST') {
      const form = new URLSearchParams(req.body ?? '');
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      if (!pending || pending.expires < Date.now()) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== pending.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      if (form.get('client_id') !== pending.clientId || form.get('redirect_uri') !== pending.redirectUri) return json(400, { error: 'invalid_client' });
      const now = Math.floor(Date.now() / 1000);
      const id_token = this.idToken({
        iss: this.issuer,
        aud: this.clientId,
        sub: `mock|${pending.person.email}`,
        sid: pending.sid,
        email: pending.person.email,
        email_verified: pending.person.emailVerified ?? true,
        name: pending.person.name,
        nonce: pending.nonce,
        iat: now,
        exp: now + 300,
        ...this.claimOverrides,
      });
      return json(200, { id_token, access_token: 'unused', token_type: 'Bearer', expires_in: 300 });
    }
    return json(404, { error: 'not_found' });
  };

  /** Serves the provider over HTTP with a "choose who to sign in as" page. */
  listen(port: number): Server {
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      if (url.pathname === '/logout') {
        try {
          res.writeHead(302, { location: this.endSession(url.toString()) });
        } catch (e) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          return void res.end(String((e as Error).message));
        }
        return void res.end();
      }
      if (url.pathname === '/end-session' && url.searchParams.get('sid') && this.backchannelLogoutUri) {
        // "Sign out everywhere": what an admin revoking a session, or the user signing
        // out of another app, looks like to Plan Ops Hub.
        const sid = url.searchParams.get('sid')!;
        const person = this.sessions.get(sid);
        this.sessions.delete(sid);
        await fetch(this.backchannelLogoutUri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: this.logoutToken({ sid, sub: person ? `mock|${person.email}` : undefined }) }).toString(),
        }).catch(() => undefined);
        res.writeHead(302, { location: '/sessions' });
        return void res.end();
      }
      if (url.pathname === '/sessions') {
        const esc2 = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock identity provider sessions</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:40px auto;padding:0 16px;background:#f4f1ea;color:#1d2321}a{color:#1f5f4f}li{margin:8px 0}</style>
<h1>Signed-in sessions</h1><p>Signing a session out here notifies Plan Ops Hub by back-channel logout, as when an administrator revokes a session.</p>
<ul>${[...this.sessions].map(([sid, p]) => `<li><b>${esc2(p.name)}</b> ${esc2(p.email)} · <a href="/end-session?sid=${encodeURIComponent(sid)}">Sign out everywhere</a></li>`).join('') || '<li>None</li>'}</ul>`);
      }
      if (url.pathname === '/authorize') {
        const as = url.searchParams.get('login_as');
        if (as) {
          try {
            const params = new URL(url);
            params.searchParams.delete('login_as');
            res.writeHead(302, { location: this.authorize(params.toString(), as) });
          } catch (e) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            return void res.end(String((e as Error).message));
          }
          return void res.end();
        }
        const link = (email: string) => {
          const u = new URL(url);
          u.searchParams.set('login_as', email);
          return esc(u.pathname + u.search);
        };
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock identity provider</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:40px auto;padding:0 16px;background:#f4f1ea;color:#1d2321}a{display:block;padding:10px 14px;margin:8px 0;border:1px solid #c9c2b3;border-radius:8px;background:#fff;color:inherit;text-decoration:none}a:hover{border-color:#1f5f4f}small{color:#666}</style>
<h1>Mock identity provider</h1><p><small>Development only. In production this page is your company's Okta, Entra ID or Google sign-in.</small></p>
<p>Sign in to Plan Ops Hub as:</p>${this.people.map((p) => `<a href="${link(p.email)}"><b>${esc(p.name)}</b><br><small>${esc(p.email)}</small></a>`).join('')}`);
      }
      const r = await this.transport({ method: req.method ?? 'GET', url: url.toString(), headers: {}, body: await new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); }) });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
    });
    server.listen(port, '127.0.0.1');
    return server;
  }
}
