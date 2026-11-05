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
}

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

export class SamlClient {
  readonly config: SamlConfig;
  private saml: SAML;

  constructor(config: SamlConfig, requests: Collection<PendingSamlRequest>, now: () => number = Date.now) {
    this.config = config;
    this.saml = new SAML({
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

  /** SP metadata XML for the IdP administrator. */
  metadata(): string {
    return this.saml.generateServiceProviderMetadata(null, null);
  }

  /** Validate a posted SAMLResponse and return the user's email. */
  async verify(samlResponse: string): Promise<{ email: string; profile: Profile }> {
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
    return { email, profile };
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
  return {
    idpSsoUrl: env.SAML_IDP_SSO_URL,
    idpEntityId: env.SAML_IDP_ENTITY_ID!,
    idpCerts: [env.SAML_IDP_CERT!, env.SAML_IDP_CERT_2].filter((c): c is string => !!c).map((c) => c.replace(/\\n/g, '\n').trim()),
    spEntityId: env.SAML_SP_ENTITY_ID ?? `${acs.origin}/auth/saml/metadata`,
    acsUrl: env.SAML_ACS_URL!,
    userAttribute: env.SAML_USER_ATTRIBUTE || undefined,
    wantResponseSigned: env.SAML_WANT_RESPONSE_SIGNED === 'true',
  };
}

export type { PendingSamlRequest };
