import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import type { MockPerson } from './mockIdp.ts';

/**
 * A tiny SAML 2.0 identity provider for tests and `npm run demo:saml`. It reads
 * the app's AuthnRequest and returns a Response with an RSA-SHA256 signed
 * assertion, so the app's SAML code runs as it would against ADFS or Okta.
 * Development use only: anyone can sign in as any listed person.
 */
export interface SamlResponseOptions {
  /** Change the signed content (wrong audience, expired, ...). */
  audience?: string;
  issuer?: string;
  recipient?: string;
  destination?: string;
  /** null leaves InResponseTo out (an unsolicited, IdP-initiated response). */
  inResponseTo?: string | null;
  /** Seconds the assertion stays valid; negative = already expired. */
  validFor?: number;
  /** Sign with a different key (one the app doesn't trust). */
  signingKey?: KeyObject;
  unsigned?: boolean;
  /** Edit the XML after signing (to prove tampering is caught). */
  tamper?: (xml: string) => string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const id = () => '_' + randomBytes(16).toString('hex');

export class MockSamlIdp {
  readonly entityId: string;
  readonly ssoUrl: string;
  readonly people: MockPerson[];
  /** The IdP's signing key, in PEM, for the app's SAML_IDP_CERT. */
  readonly certPem: string;
  private privateKey: KeyObject;

  constructor(opts: { entityId: string; ssoUrl: string; people: MockPerson[] }) {
    this.entityId = opts.entityId;
    this.ssoUrl = opts.ssoUrl;
    this.people = opts.people;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.certPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** Decode the app's AuthnRequest from the redirect URL. */
  parseRequest(authorizationUrl: string): { requestId: string; acsUrl: string; spEntityId: string; relayState: string } {
    const u = new URL(authorizationUrl);
    const xml = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
    const doc = new DOMParser().parseFromString(xml, 'text/xml').documentElement!;
    const issuer = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'Issuer')[0]?.textContent ?? '';
    return { requestId: doc.getAttribute('ID') ?? '', acsUrl: doc.getAttribute('AssertionConsumerServiceURL') ?? '', spEntityId: issuer, relayState: u.searchParams.get('RelayState') ?? '' };
  }

  /** The signed-in step: a base64 SAMLResponse for `email`, answering the request in `authorizationUrl`. */
  respond(authorizationUrl: string, email: string, o: SamlResponseOptions = {}): { acsUrl: string; SAMLResponse: string; RelayState: string } {
    const req = this.parseRequest(authorizationUrl);
    const person = this.people.find((p) => p.email === email) ?? { email, name: email };
    const now = Date.now();
    const until = iso(now + (o.validFor ?? 300) * 1000);
    const inResponseTo = o.inResponseTo === undefined ? req.requestId : o.inResponseTo;
    const irt = inResponseTo === null ? '' : ` InResponseTo="${xmlEsc(inResponseTo)}"`;
    const issuer = xmlEsc(o.issuer ?? this.entityId);
    const assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${iso(now)}">` +
      `<saml:Issuer>${issuer}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${xmlEsc(person.email)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${until}" Recipient="${xmlEsc(o.recipient ?? req.acsUrl)}"/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${xmlEsc(o.audience ?? req.spEntityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${xmlEsc(person.email)}</saml:AttributeValue></saml:Attribute>` +
      `<saml:Attribute Name="displayName"><saml:AttributeValue>${xmlEsc(person.name)}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
      `</saml:Assertion>`;
    const signed = o.unsigned ? assertion : this.sign(assertion, o.signingKey ?? this.privateKey);
    let xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${xmlEsc(o.destination ?? req.acsUrl)}"${irt}>` +
      `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
    if (o.tamper) xml = o.tamper(xml);
    return { acsUrl: req.acsUrl, SAMLResponse: Buffer.from(xml).toString('base64'), RelayState: req.relayState };
  }

  private sign(assertion: string, key: KeyObject): string {
    const sig = new SignedXml({
      privateKey: key.export({ type: 'pkcs8', format: 'pem' }),
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "/*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(assertion, { location: { reference: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    return sig.getSignedXml();
  }

  /** Serves the IdP over HTTP: a "choose who to sign in as" page that posts back to the app. */
  listen(port: number): Server {
    const esc = xmlEsc;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.ssoUrl);
      if (url.pathname !== new URL(this.ssoUrl).pathname) {
        res.writeHead(404);
        return void res.end();
      }
      const as = url.searchParams.get('login_as');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const style = '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:40px auto;padding:0 16px;background:#eef1f6;color:#1d2321}a{display:block;padding:10px 14px;margin:8px 0;border:1px solid #b9c2d0;border-radius:8px;background:#fff;color:inherit;text-decoration:none}a:hover{border-color:#2b4c7e}small{color:#666}</style>';
      if (as) {
        try {
          const params = new URL(url);
          params.searchParams.delete('login_as');
          const r = this.respond(params.toString(), as);
          return void res.end(`<!doctype html><title>Signing in…</title>${style}<form method="post" action="${esc(r.acsUrl)}"><input type="hidden" name="SAMLResponse" value="${esc(r.SAMLResponse)}"><input type="hidden" name="RelayState" value="${esc(r.RelayState)}"><noscript><button>Continue</button></noscript></form><script>document.forms[0].submit()</script>`);
        } catch (e) {
          return void res.end(`Bad SAML request: ${esc(String((e as Error).message))}`);
        }
      }
      const link = (email: string) => {
        const u = new URL(url);
        u.searchParams.set('login_as', email);
        return esc(u.pathname + u.search);
      };
      res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock SAML identity provider</title>${style}
<h1>Mock SAML identity provider</h1><p><small>Development only. In production this is your company's ADFS, Okta, Entra ID or Shibboleth sign-in.</small></p>
<p>Sign in to Plan Ops Hub as:</p>${this.people.map((p) => `<a href="${link(p.email)}"><b>${esc(p.name)}</b><br><small>${esc(p.email)}</small></a>`).join('')}`);
    });
    server.listen(port, '127.0.0.1');
    return server;
  }
}
