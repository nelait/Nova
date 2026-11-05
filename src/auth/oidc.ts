import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { Transport } from '../integrations/client.ts';
import { fetchTransport } from '../integrations/client.ts';

/**
 * OpenID Connect sign-in (authorization code flow with PKCE), for Okta, Microsoft
 * Entra ID, Google Workspace, Ping, Auth0 and other standard providers.
 * Implemented with Node's crypto only. ID tokens are fully checked: signature
 * (RS256/PS256/ES256 from the provider's JWKS), issuer, audience, expiry and nonce.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Absolute URL of this app's /auth/callback, registered with the provider. */
  redirectUri: string;
  scopes: string[];
  /** ID token claim used to find the user in the directory (default: email). */
  userClaim: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

const b64url = (b: Buffer) => b.toString('base64url');
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

const ALGS: Record<string, { hash: string; opts: (key: KeyObject) => object }> = {
  RS256: { hash: 'sha256', opts: (key) => ({ key }) },
  RS384: { hash: 'sha384', opts: (key) => ({ key }) },
  RS512: { hash: 'sha512', opts: (key) => ({ key }) },
  PS256: { hash: 'sha256', opts: (key) => ({ key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }) },
  ES256: { hash: 'sha256', opts: (key) => ({ key, dsaEncoding: 'ieee-p1363' }) },
  ES384: { hash: 'sha384', opts: (key) => ({ key, dsaEncoding: 'ieee-p1363' }) },
};

export class OidcClient {
  readonly config: OidcConfig;
  private transport: Transport;
  private now: () => number;
  private discovery?: Discovery;
  private keys = new Map<string, { alg?: string; key: KeyObject }>();
  private keysFetchedAt = 0;

  constructor(config: OidcConfig, transport: Transport = fetchTransport, now: () => number = Date.now) {
    this.config = config;
    this.transport = transport;
    this.now = now;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.transport({ method: 'GET', url, headers: { accept: 'application/json' } });
    if (res.status !== 200) throw new AuthError(`Identity provider returned ${res.status} for ${url}`, 502);
    return JSON.parse(res.body);
  }

  async metadata(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const d = (await this.getJson(`${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)) as Discovery;
    if (d.issuer !== this.config.issuer) throw new AuthError(`Discovery issuer ${d.issuer} does not match configured issuer ${this.config.issuer}`, 502);
    this.discovery = d;
    return d;
  }

  /** URL to send the browser to. The caller keeps state, nonce and verifier server-side. */
  async authorizationUrl(state: string, nonce: string, codeVerifier: string): Promise<string> {
    const d = await this.metadata();
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
      state,
      nonce,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
    }).toString();
    return u.toString();
  }

  async logoutUrl(postLogoutRedirect: string): Promise<string | undefined> {
    const d = await this.metadata();
    if (!d.end_session_endpoint) return undefined;
    const u = new URL(d.end_session_endpoint);
    u.searchParams.set('client_id', this.config.clientId);
    u.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
    return u.toString();
  }

  /** Exchange the code and return the verified ID token claims. */
  async exchange(code: string, codeVerifier: string, nonce: string): Promise<Record<string, unknown>> {
    const d = await this.metadata();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, client_id: this.config.clientId, code_verifier: codeVerifier });
    if (this.config.clientSecret) form.set('client_secret', this.config.clientSecret);
    const res = await this.transport({ method: 'POST', url: d.token_endpoint, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
    if (res.status !== 200) throw new AuthError(`Sign-in failed at the identity provider (token endpoint returned ${res.status})`, 502);
    const tokens = JSON.parse(res.body) as { id_token?: string };
    if (!tokens.id_token) throw new AuthError('Identity provider returned no ID token', 502);
    return this.verifyIdToken(tokens.id_token, nonce);
  }

  async verifyIdToken(jwt: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new AuthError('Malformed ID token');
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new AuthError('Malformed ID token');
    }
    const alg = ALGS[header.alg ?? ''];
    if (!alg) throw new AuthError(`ID token algorithm "${header.alg}" is not allowed`);
    const key = await this.key(header.kid, header.alg!);
    const ok = cryptoVerify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), alg.opts(key) as never, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new AuthError('ID token signature is invalid');

    const d = await this.metadata();
    const nowSec = Math.floor(this.now() / 1000);
    const skew = 60;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== d.issuer) throw new AuthError('ID token issuer does not match');
    if (!aud.includes(this.config.clientId)) throw new AuthError('ID token audience does not match');
    if (aud.length > 1 && claims.azp !== undefined && claims.azp !== this.config.clientId) throw new AuthError('ID token authorized party does not match');
    if (typeof claims.exp !== 'number' || claims.exp + skew < nowSec) throw new AuthError('ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat - skew > nowSec) throw new AuthError('ID token is issued in the future');
    if (typeof claims.nbf === 'number' && claims.nbf - skew > nowSec) throw new AuthError('ID token is not valid yet');
    if (claims.nonce !== nonce) throw new AuthError('ID token nonce does not match');
    return claims;
  }

  private async key(kid: string | undefined, alg: string): Promise<KeyObject> {
    const find = () => (kid ? this.keys.get(kid) : this.keys.size === 1 ? [...this.keys.values()][0] : undefined);
    let k = find();
    // Unknown key: refetch once (the provider may have rotated keys), at most every 30 s.
    if (!k && this.now() - this.keysFetchedAt > 30_000) {
      await this.loadKeys();
      k = find();
    }
    if (!k) throw new AuthError('ID token is signed with an unknown key');
    if (k.alg && k.alg !== alg) throw new AuthError('ID token algorithm does not match its key');
    return k.key;
  }

  private async loadKeys(): Promise<void> {
    const d = await this.metadata();
    const jwks = (await this.getJson(d.jwks_uri)) as { keys?: (JsonWebKey & { kid?: string; use?: string; alg?: string })[] };
    this.keys.clear();
    for (const jwk of jwks.keys ?? []) {
      if (jwk.use && jwk.use !== 'sig') continue;
      try {
        this.keys.set(jwk.kid ?? 'default', { alg: jwk.alg, key: createPublicKey({ key: jwk, format: 'jwk' }) });
      } catch {
        // Skip key types we can't use.
      }
    }
    this.keysFetchedAt = this.now();
  }
}

/** Read OIDC settings from the environment. Returns undefined when sign-in isn't configured. */
export function oidcConfigFromEnv(env: Record<string, string | undefined>): OidcConfig | undefined {
  if (!env.OIDC_ISSUER) return undefined;
  const missing = ['OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Single sign-on is configured (OIDC_ISSUER) but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set`);
  if (!/^https:\/\//.test(env.OIDC_ISSUER) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env.OIDC_ISSUER)) throw new Error('OIDC_ISSUER must use https');
  return {
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: env.OIDC_REDIRECT_URI!,
    scopes: (env.OIDC_SCOPES ?? 'openid email profile').split(/[\s,]+/).filter(Boolean),
    userClaim: env.OIDC_USER_CLAIM ?? 'email',
  };
}
