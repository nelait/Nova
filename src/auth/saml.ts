import { createVerify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';
import type { Collection } from '../store/db.ts';
import { AuthError } from './oidc.ts';

/**
 * SAML 2.0 sign-in (SP-initiated, HTTP-Redirect request, HTTP-POST response) for
 * identity providers that don't offer OpenID Connect, such as ADFS, Shibboleth,
 * or Okta / Entra ID / Ping apps already set up for SAML.
 *
 * XML signature checking is done by @node-saml/node-saml (the library behind
 * passport-saml): hand-written XML-DSig verification is a well-known source of
 * signature-wrapping bugs. On top of it this module requires:
 * - a signed assertion for this SP's audience, issued by the configured IdP entity ID
 *   (checked here: node-saml only checks the issuer of logout messages);
 * - a response to a request this app sent (InResponseTo, single use, 10 minutes):
 *   unsolicited (IdP-initiated) responses are refused;
 * - Destination and Recipient, when present, equal to this app's ACS URL.
 */
export interface SamlConfig {
  /** IdP single sign-on URL (HTTP-Redirect binding). */
  idpSsoUrl: string;
  /** IdP entity ID; responses from any other issuer are refused. */
  idpEntityId: string;
  /** IdP signing certificate(s), PEM or base64. Two during certificate rotation. */
  idpCerts: string[];
  /** This app's entity ID (the audience the IdP must name). */
  spEntityId: string;
  /** Absolute URL of this app's /auth/saml/acs, registered with the IdP. */
  acsUrl: string;
  /** Attribute holding the user's email; default: common email attributes, then the NameID. */
  userAttribute?: string;
  /** Also require the whole response to be signed (default: assertion signature only). */
  wantResponseSigned: boolean;
  /** IdP single logout URL; set to enable single logout. */
  idpSloUrl?: string;
  /** This app's /auth/saml/slo URL. */
  sloUrl: string;
  /** This app's signing key and certificate (PEM): logout requests must be signed. */
  spPrivateKey?: string;
  spCert?: string;
}

/** What identifies a user's session at the IdP, kept with the local session for logout. */
export interface SamlSessionRef {
  nameID: string;
  nameIDFormat: string;
  sessionIndex?: string;
  nameQualifier?: string;
  spNameQualifier?: string;
}

/** Outcome of a message posted or redirected to /auth/saml/slo. */
export type SloMessage =
  | { kind: 'response'; ok: boolean; error?: string }
  | { kind: 'request'; ref: SamlSessionRef; reply: Profile; relayState: string };

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
];
const NS_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const NS_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const REQUEST_TTL_MS = 600_000;

interface PendingSamlRequest {
  id: string;
  value: string;
  createdAt: number;
}

/** Outstanding AuthnRequest IDs, in the database so a restart doesn't break sign-ins in progress. */
class CollectionCache implements CacheProvider {
  private c: Collection<PendingSamlRequest>;
  private now: () => number;
  constructor(c: Collection<PendingSamlRequest>, now: () => number) {
    this.c = c;
    this.now = now;
  }
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const cutoff = this.now() - REQUEST_TTL_MS;
    for (const old of this.c.find((r) => r.createdAt < cutoff)) this.c.delete(old.id);
    if (this.c.get(key)) return null;
    const item = { id: key, value, createdAt: this.now() };
    this.c.insert(item);
    return { value, createdAt: item.createdAt };
  }
  async getAsync(key: string): Promise<string | null> {
    const r = this.c.get(key);
    return r && r.createdAt >= this.now() - REQUEST_TTL_MS ? r.value : null;
  }
  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const r = this.c.get(key);
    this.c.delete(key);
    return r?.value ?? null;
  }
}

const SIG_ALGS: Record<string, string> = {
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'sha512',
};

const toPem = (c: string) =>
  c.includes('-----BEGIN') ? c : `-----BEGIN CERTIFICATE-----\n${c.replace(/\s+/g, '').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

export class SamlClient {
  readonly config: SamlConfig;
  private saml: SAML;
  private seen: Collection<PendingSamlRequest>;
  private now: () => number;

  constructor(config: SamlConfig, store: { requests: Collection<PendingSamlRequest>; seenLogouts: Collection<PendingSamlRequest> }, now: () => number = Date.now) {
    this.config = config;
    this.seen = store.seenLogouts;
    this.now = now;
    const requests = store.requests;
    this.saml = new SAML({
      logoutUrl: config.idpSloUrl ?? config.idpSsoUrl,
      logoutCallbackUrl: config.sloUrl,
      ...(config.spPrivateKey ? { privateKey: config.spPrivateKey, publicCert: config.spCert } : {}),
      entryPoint: config.idpSsoUrl,
      issuer: config.spEntityId,
      audience: config.spEntityId,
      callbackUrl: config.acsUrl,
      idpCert: config.idpCerts,
      idpIssuer: config.idpEntityId,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: config.wantResponseSigned,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL_MS,
      cacheProvider: new CollectionCache(requests, now),
      acceptedClockSkewMs: 60_000,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      // Let the IdP choose how to authenticate (MFA, passkeys...); requesting
      // "password" makes Entra ID refuse users who signed in with MFA.
      disableRequestedAuthnContext: true,
      signatureAlgorithm: 'sha256',
    });
  }

  /** URL to send the browser to; `relayState` comes back with the response. */
  authorizationUrl(relayState: string): Promise<string> {
    return this.saml.getAuthorizeUrlAsync(relayState, undefined, {});
  }

  /** SP metadata XML for the IdP administrator (with the SP signing certificate and SLO URL when set). */
  metadata(): string {
    return this.saml.generateServiceProviderMetadata(null, this.config.spCert ?? null);
  }

  get singleLogout(): boolean {
    return !!this.config.idpSloUrl;
  }

  /** SP-initiated logout: a signed LogoutRequest to the IdP, as a redirect URL. */
  async logoutUrl(ref: SamlSessionRef, relayState = ''): Promise<string | undefined> {
    if (!this.singleLogout) return undefined;
    return this.saml.getLogoutUrlAsync(ref as unknown as Profile, relayState, {});
  }

  /** The LogoutResponse to send back after ending the sessions an IdP LogoutRequest named. */
  logoutResponseUrl(request: Profile, relayState: string): Promise<string> {
    return this.saml.getLogoutResponseUrlAsync(request, relayState, {}, true);
  }

  /**
   * A LogoutRequest or LogoutResponse sent to /auth/saml/slo by the IdP, through the
   * browser (front-channel), as a redirect (GET) or a form post.
   *
   * LogoutRequests can end anyone's sessions, so they must be signed by the IdP:
   * node-saml accepts unsigned ones on the redirect binding, so that signature is
   * checked here first. Each request is accepted once and only within 10 minutes
   * of being issued, so a captured one can't be replayed later.
   */
  async handleSlo(method: 'GET' | 'POST', params: URLSearchParams, rawQuery: string): Promise<SloMessage> {
    const isRequest = params.has('SAMLRequest');
    const relayState = params.get('RelayState') ?? '';
    if (!isRequest) {
      if (!params.get('SAMLResponse')) throw new AuthError('Expected a SAML LogoutRequest or LogoutResponse', 400);
      try {
        if (method === 'GET') await this.saml.validateRedirectAsync(Object.fromEntries(params), rawQuery);
        else await this.saml.validatePostResponseAsync({ SAMLResponse: params.get('SAMLResponse')! });
        return { kind: 'response', ok: true };
      } catch (e) {
        return { kind: 'response', ok: false, error: (e as Error).message };
      }
    }
    let xml: string;
    let profile: Profile | null;
    try {
      if (method === 'GET') {
        this.checkRedirectSignature(rawQuery);
        xml = inflateRawSync(Buffer.from(params.get('SAMLRequest')!, 'base64')).toString('utf8');
        ({ profile } = await this.saml.validateRedirectAsync(Object.fromEntries(params), rawQuery));
      } else {
        xml = Buffer.from(params.get('SAMLRequest')!, 'base64').toString('utf8');
        ({ profile } = await this.saml.validatePostRequestAsync({ SAMLRequest: params.get('SAMLRequest')! }));
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(`The identity provider's logout request was rejected: ${(e as Error).message}`, 400);
    }
    if (!profile?.ID || !profile.nameID) throw new AuthError('Logout request has no ID or NameID', 400);
    if (profile.issuer !== this.config.idpEntityId) throw new AuthError(`Logout request was issued by ${profile.issuer}, not the configured identity provider`, 400);
    const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
    const destination = root?.getAttribute('Destination');
    if (destination && destination !== this.config.sloUrl) throw new AuthError(`Logout request was sent to ${destination}, not this application`, 400);
    const issued = Date.parse(root?.getAttribute('IssueInstant') ?? '');
    if (!Number.isFinite(issued) || Math.abs(this.now() - issued) > REQUEST_TTL_MS) throw new AuthError('Logout request is too old, or its IssueInstant is missing', 400);
    const cutoff = this.now() - 2 * REQUEST_TTL_MS;
    for (const old of this.seen.find((r) => r.createdAt < cutoff)) this.seen.delete(old.id);
    if (this.seen.get(profile.ID)) throw new AuthError('This logout request was already processed', 400);
    this.seen.insert({ id: profile.ID, value: profile.nameID, createdAt: this.now() });
    return {
      kind: 'request',
      ref: { nameID: profile.nameID, nameIDFormat: profile.nameIDFormat, sessionIndex: profile.sessionIndex },
      reply: profile,
      relayState,
    };
  }

  /**
   * HTTP-Redirect binding signature (SAML bindings 3.4.4.1): over the URL-encoded
   * "SAMLRequest=…&RelayState=…&SigAlg=…" exactly as received. Required, and each
   * parameter may appear once.
   */
  private checkRedirectSignature(rawQuery: string): void {
    const raw: Record<string, string> = {};
    for (const part of rawQuery.split('&')) {
      const i = part.indexOf('=');
      const k = decodeURIComponent(i < 0 ? part : part.slice(0, i));
      if (k in raw) throw new AuthError(`Logout request repeats the ${k} parameter`, 400);
      raw[k] = i < 0 ? '' : part.slice(i + 1);
    }
    if (!raw.Signature || !raw.SigAlg) throw new AuthError('Logout requests from the identity provider must be signed', 400);
    const hash = SIG_ALGS[decodeURIComponent(raw.SigAlg)];
    if (!hash) throw new AuthError(`Logout request signature algorithm ${decodeURIComponent(raw.SigAlg)} is not allowed`, 400);
    const signed = `SAMLRequest=${raw.SAMLRequest}${'RelayState' in raw ? `&RelayState=${raw.RelayState}` : ''}&SigAlg=${raw.SigAlg}`;
    const signature = Buffer.from(decodeURIComponent(raw.Signature), 'base64');
    const ok = this.config.idpCerts.some((cert) => {
      try {
        return createVerify(hash).update(signed).verify(toPem(cert), signature);
      } catch {
        return false;
      }
    });
    if (!ok) throw new AuthError('Logout request signature is invalid', 400);
  }

  /** Validate a posted SAMLResponse and return the user's email. */
  async verify(samlResponse: string): Promise<{ email: string; profile: Profile; ref: SamlSessionRef }> {
    let profile: Profile | null;
    try {
      ({ profile } = await this.saml.validatePostResponseAsync({ SAMLResponse: samlResponse }));
    } catch (e) {
      throw new AuthError(`The identity provider's SAML response was rejected: ${(e as Error).message}`, 400);
    }
    if (!profile) throw new AuthError('The identity provider sent a sign-out message, not a sign-in', 400);
    this.checkRecipients(samlResponse, profile);
    const email = this.emailFrom(profile);
    if (!email) throw new AuthError(`The SAML assertion has no ${this.config.userAttribute ? `"${this.config.userAttribute}" attribute` : 'email attribute or email NameID'}`, 403);
    const ref: SamlSessionRef = { nameID: profile.nameID, nameIDFormat: profile.nameIDFormat, sessionIndex: profile.sessionIndex };
    if (profile.nameQualifier) ref.nameQualifier = profile.nameQualifier;
    if (profile.spNameQualifier) ref.spNameQualifier = profile.spNameQualifier;
    return { email, profile, ref };
  }

  /**
   * Checks node-saml leaves to the caller: the signed assertion's Issuer must be the
   * configured IdP (node-saml checks idpIssuer only on logout messages), and
   * Destination / Recipient, when present, must name this app.
   */
  private checkRecipients(samlResponse: string, profile: Profile): void {
    if (profile.issuer !== this.config.idpEntityId) throw new AuthError(`SAML assertion was issued by ${profile.issuer}, not the configured identity provider`, 400);
    const parser = new DOMParser();
    const response = parser.parseFromString(Buffer.from(samlResponse, 'base64').toString('utf8'), 'text/xml').documentElement;
    const destination = response?.namespaceURI === NS_PROTOCOL ? response.getAttribute('Destination') : null;
    if (destination && destination !== this.config.acsUrl) throw new AuthError(`SAML response was sent to ${destination}, not this application`, 400);
    // Only trust the assertion node-saml verified, not whatever else the document contains.
    const assertionXml = profile.getAssertionXml?.();
    if (!assertionXml) throw new AuthError('SAML assertion is missing', 400);
    const assertion = parser.parseFromString(assertionXml, 'text/xml');
    const confirmations = assertion.getElementsByTagNameNS(NS_ASSERTION, 'SubjectConfirmationData');
    for (let i = 0; i < confirmations.length; i++) {
      const recipient = confirmations[i].getAttribute('Recipient');
      if (recipient && recipient !== this.config.acsUrl) throw new AuthError(`SAML assertion is for ${recipient}, not this application`, 400);
    }
  }

  private emailFrom(profile: Profile): string | undefined {
    const value = (k: string) => {
      const v = profile[k];
      const s = Array.isArray(v) ? v[0] : v;
      return typeof s === 'string' && s.trim() ? s.trim() : undefined;
    };
    if (this.config.userAttribute) return value(this.config.userAttribute);
    for (const k of EMAIL_ATTRIBUTES) {
      const v = value(k);
      if (v?.includes('@')) return v;
    }
    return profile.nameID?.includes('@') ? profile.nameID : undefined;
  }
}

const isLocal = (u: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u);

/** Read SAML settings from the environment. Returns undefined when SAML isn't configured. */
export function samlConfigFromEnv(env: Record<string, string | undefined>): SamlConfig | undefined {
  if (!env.SAML_IDP_SSO_URL) return undefined;
  const missing = ['SAML_IDP_ENTITY_ID', 'SAML_IDP_CERT', 'SAML_ACS_URL'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`SAML is configured (SAML_IDP_SSO_URL) but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set`);
  for (const k of ['SAML_IDP_SSO_URL', 'SAML_ACS_URL']) {
    if (!env[k]!.startsWith('https://') && !isLocal(env[k]!)) throw new Error(`${k} must use https`);
  }
  if (!/\/auth\/saml\/acs$/.test(new URL(env.SAML_ACS_URL!).pathname)) throw new Error('SAML_ACS_URL must end with /auth/saml/acs');
  const acs = new URL(env.SAML_ACS_URL!);
  if (env.SAML_IDP_SLO_URL) {
    const need = ['SAML_SP_PRIVATE_KEY', 'SAML_SP_CERT'].filter((k) => !env[k]);
    if (need.length) throw new Error(`Single logout (SAML_IDP_SLO_URL) needs ${need.join(' and ')}: logout requests must be signed`);
    if (!env.SAML_IDP_SLO_URL.startsWith('https://') && !isLocal(env.SAML_IDP_SLO_URL)) throw new Error('SAML_IDP_SLO_URL must use https');
  }
  const pem = (v: string | undefined) => v?.replace(/\\n/g, '\n').trim() || undefined;
  return {
    idpSsoUrl: env.SAML_IDP_SSO_URL,
    idpEntityId: env.SAML_IDP_ENTITY_ID!,
    idpCerts: [env.SAML_IDP_CERT!, env.SAML_IDP_CERT_2].filter((c): c is string => !!c).map((c) => c.replace(/\\n/g, '\n').trim()),
    spEntityId: env.SAML_SP_ENTITY_ID ?? `${acs.origin}/auth/saml/metadata`,
    acsUrl: env.SAML_ACS_URL!,
    userAttribute: env.SAML_USER_ATTRIBUTE || undefined,
    wantResponseSigned: env.SAML_WANT_RESPONSE_SIGNED === 'true',
    idpSloUrl: env.SAML_IDP_SLO_URL || undefined,
    sloUrl: `${acs.origin}${acs.pathname.replace(/\/acs$/, '/slo')}`,
    spPrivateKey: pem(env.SAML_SP_PRIVATE_KEY),
    spCert: pem(env.SAML_SP_CERT),
  };
}

export type { PendingSamlRequest };
