import { createSign, createVerify, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
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
  /** Pretend the assertion was issued this many seconds ago. */
  issuedAgoSeconds?: number;
}

/** The app as this IdP knows it, for IdP-initiated sign-in (the app tile in a portal). */
export interface MockServiceProvider {
  acsUrl: string;
  entityId: string;
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
  /** The IdP's single logout URL, for the app's SAML_IDP_SLO_URL. */
  readonly sloUrl: string;
  /** The app's signing key (its SAML_SP_CERT), to check the app's LogoutRequests. */
  spCertPem?: string;
  /** The app, for IdP-initiated sign-in from the demo portal page. */
  sp?: MockServiceProvider;
  /** Sessions this IdP issued: SessionIndex -> person, plus where to send logout. */
  readonly sessions = new Map<string, { person: MockPerson; spSloUrl: string }>();
  private privateKey: KeyObject;

  constructor(opts: { entityId: string; ssoUrl: string; sloUrl?: string; people: MockPerson[] }) {
    this.entityId = opts.entityId;
    this.ssoUrl = opts.ssoUrl;
    this.sloUrl = opts.sloUrl ?? opts.ssoUrl.replace(/\/sso$/, '/slo');
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
  respond(authorizationUrl: string, email: string, o: SamlResponseOptions = {}): { acsUrl: string; SAMLResponse: string; RelayState: string; sessionIndex: string } {
    return this.build(this.parseRequest(authorizationUrl), email, o);
  }

  /** IdP-initiated: an unsolicited response (no InResponseTo), as when someone clicks the app's tile. */
  unsolicited(sp: MockServiceProvider, email: string, o: SamlResponseOptions & { relayState?: string } = {}) {
    return this.build({ requestId: '', acsUrl: sp.acsUrl, spEntityId: sp.entityId, relayState: o.relayState ?? '' }, email, { inResponseTo: null, ...o });
  }

  private build(req: { requestId: string; acsUrl: string; spEntityId: string; relayState: string }, email: string, o: SamlResponseOptions) {
    const person = this.people.find((p) => p.email === email) ?? { email, name: email };
    const now = Date.now() - (o.issuedAgoSeconds ?? 0) * 1000;
    const until = iso(now + (o.validFor ?? 300) * 1000);
    const inResponseTo = o.inResponseTo === undefined ? req.requestId : o.inResponseTo;
    const irt = inResponseTo === null ? '' : ` InResponseTo="${xmlEsc(inResponseTo)}"`;
    const issuer = xmlEsc(o.issuer ?? this.entityId);
    const sessionIndex = id();
    this.sessions.set(sessionIndex, { person, spSloUrl: req.acsUrl.replace(/\/acs$/, '/slo') });
    const assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${iso(now)}">` +
      `<saml:Issuer>${issuer}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${xmlEsc(person.email)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${until}" Recipient="${xmlEsc(o.recipient ?? req.acsUrl)}"/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${xmlEsc(o.audience ?? req.spEntityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${sessionIndex}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${xmlEsc(person.email)}</saml:AttributeValue></saml:Attribute>` +
      `<saml:Attribute Name="displayName"><saml:AttributeValue>${xmlEsc(person.name)}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
      `</saml:Assertion>`;
    const signed = o.unsigned ? assertion : this.sign(assertion, o.signingKey ?? this.privateKey);
    let xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${xmlEsc(o.destination ?? req.acsUrl)}"${irt}>` +
      `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
    if (o.tamper) xml = o.tamper(xml);
    return { acsUrl: req.acsUrl, SAMLResponse: Buffer.from(xml).toString('base64'), RelayState: req.relayState, sessionIndex };
  }

  /** HTTP-Redirect binding: deflate, base64, and sign "param=…&RelayState=…&SigAlg=…". */
  private redirectUrl(to: string, param: 'SAMLRequest' | 'SAMLResponse', xml: string, relayState: string | undefined, key: KeyObject | null): string {
    let q = `${param}=${encodeURIComponent(deflateRawSync(Buffer.from(xml)).toString('base64'))}`;
    if (relayState) q += `&RelayState=${encodeURIComponent(relayState)}`;
    if (key) {
      q += `&SigAlg=${encodeURIComponent('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256')}`;
      q += `&Signature=${encodeURIComponent(createSign('sha256').update(q).sign(key, 'base64'))}`;
    }
    return `${to}${to.includes('?') ? '&' : '?'}${q}`;
  }

  /**
   * SP-initiated logout: checks the app's signed LogoutRequest, ends that session,
   * and returns the LogoutResponse redirect back to the app.
   */
  handleLogoutRequest(url: string): { redirect: string; nameID: string; sessionIndex?: string } {
    const u = new URL(url);
    const raw = u.search.slice(1).split('&');
    const get = (k: string) => raw.find((p) => p.startsWith(k + '='))?.slice(k.length + 1);
    if (!this.spCertPem) throw new Error('spCertPem is not set');
    const signedPart = ['SAMLRequest', 'RelayState', 'SigAlg'].filter((k) => get(k) !== undefined).map((k) => `${k}=${get(k)}`).join('&');
    if (!get('Signature') || !createVerify('sha256').update(signedPart).verify(this.spCertPem, Buffer.from(decodeURIComponent(get('Signature')!), 'base64'))) {
      throw new Error('LogoutRequest is not signed by the service provider');
    }
    const xml = inflateRawSync(Buffer.from(decodeURIComponent(get('SAMLRequest')!), 'base64')).toString('utf8');
    const doc = new DOMParser().parseFromString(xml, 'text/xml').documentElement!;
    const nameID = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'NameID')[0]?.textContent ?? '';
    const sessionIndex = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:protocol', 'SessionIndex')[0]?.textContent ?? undefined;
    const spSloUrl = sessionIndex ? this.sessions.get(sessionIndex)?.spSloUrl : undefined;
    if (sessionIndex) this.sessions.delete(sessionIndex);
    const issuer = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'Issuer')[0]?.textContent ?? '';
    const to = spSloUrl ?? issuer.replace(/\/metadata$/, '/slo');
    const now = Date.now();
    const response =
      `<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${xmlEsc(to)}" InResponseTo="${xmlEsc(doc.getAttribute('ID') ?? '')}">` +
      `<saml:Issuer>${xmlEsc(this.entityId)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:LogoutResponse>`;
    return { redirect: this.redirectUrl(to, 'SAMLResponse', response, get('RelayState') ? decodeURIComponent(get('RelayState')!) : undefined, this.privateKey), nameID, sessionIndex };
  }

  /** IdP-initiated logout: a LogoutRequest redirect to the app (the user signed out elsewhere). */
  logoutRequest(
    spSloUrl: string,
    who: { nameID: string; sessionIndex?: string },
    o: { unsigned?: boolean; signingKey?: KeyObject; issuer?: string; issuedAgoSeconds?: number; requestId?: string; destination?: string } = {},
  ): string {
    const xml =
      `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${o.requestId ?? id()}" Version="2.0" IssueInstant="${iso(Date.now() - (o.issuedAgoSeconds ?? 0) * 1000)}" Destination="${xmlEsc(o.destination ?? spSloUrl)}">` +
      `<saml:Issuer>${xmlEsc(o.issuer ?? this.entityId)}</saml:Issuer>` +
      `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${xmlEsc(who.nameID)}</saml:NameID>` +
      (who.sessionIndex ? `<samlp:SessionIndex>${xmlEsc(who.sessionIndex)}</samlp:SessionIndex>` : '') +
      `</samlp:LogoutRequest>`;
    return this.redirectUrl(spSloUrl, 'SAMLRequest', xml, 'idp-logout', o.unsigned ? null : (o.signingKey ?? this.privateKey));
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
      if (url.pathname === new URL(this.sloUrl).pathname && url.searchParams.has('SAMLResponse')) {
        // The app's LogoutResponse to an IdP-initiated logout: it has ended its session.
        res.writeHead(302, { location: '/sessions' });
        return void res.end();
      }
      if (url.pathname === new URL(this.sloUrl).pathname) {
        try {
          res.writeHead(302, { location: this.handleLogoutRequest(url.toString()).redirect });
        } catch (e) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          return void res.end(`Bad LogoutRequest: ${(e as Error).message}`);
        }
        return void res.end();
      }
      if (url.pathname === '/sessions' || url.pathname === '/end-session') {
        const si = url.searchParams.get('session');
        const s = si ? this.sessions.get(si) : undefined;
        if (s && si) {
          // Front-channel IdP-initiated logout: send the browser to the app with a LogoutRequest.
          this.sessions.delete(si);
          res.writeHead(302, { location: this.logoutRequest(s.spSloUrl, { nameID: s.person.email, sessionIndex: si }) });
          return void res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock SAML IdP sessions</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:40px auto;padding:0 16px;background:#eef1f6;color:#1d2321}a{color:#2b4c7e}li{margin:8px 0}</style>
<h1>Signed-in sessions</h1><p>Signing out here sends a LogoutRequest to Plan Ops Hub, as when the person signs out of another application.</p>
<ul>${[...this.sessions].map(([k, v]) => `<li><b>${xmlEsc(v.person.name)}</b> ${xmlEsc(v.person.email)} · <a href="/end-session?session=${encodeURIComponent(k)}">Sign out everywhere</a></li>`).join('') || '<li>None</li>'}</ul>`);
      }
      if (url.pathname !== new URL(this.ssoUrl).pathname) {
        res.writeHead(404);
        return void res.end();
      }
      const as = url.searchParams.get('login_as');
      const launch = url.searchParams.get('launch_as');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const style = '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:40px auto;padding:0 16px;background:#eef1f6;color:#1d2321}a{display:block;padding:10px 14px;margin:8px 0;border:1px solid #b9c2d0;border-radius:8px;background:#fff;color:inherit;text-decoration:none}a:hover{border-color:#2b4c7e}small{color:#666}</style>';
      const autopost = (r: { acsUrl: string; SAMLResponse: string; RelayState: string }) =>
        `<!doctype html><title>Signing in…</title>${style}<form method="post" action="${esc(r.acsUrl)}"><input type="hidden" name="SAMLResponse" value="${esc(r.SAMLResponse)}">${r.RelayState ? `<input type="hidden" name="RelayState" value="${esc(r.RelayState)}">` : ''}<noscript><button>Continue</button></noscript></form><script>document.forms[0].submit()</script>`;
      if (launch && this.sp) return void res.end(autopost(this.unsolicited(this.sp, launch, { relayState: '/' })));
      if (url.searchParams.has('portal') && this.sp) {
        const tile = (email: string) => `${esc(url.pathname)}?portal&amp;launch_as=${encodeURIComponent(email)}`;
        return void res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock SAML portal</title>${style}
<h1>My apps</h1><p><small>Development only. This stands in for an app portal such as Okta's dashboard or Microsoft My Apps: opening the app from here is IdP-initiated sign-in.</small></p>
<p>Open <b>Plan Ops Hub</b> as:</p>${this.people.map((p) => `<a href="${tile(p.email)}"><b>${esc(p.name)}</b><br><small>${esc(p.email)}</small></a>`).join('')}`);
      }
      if (as) {
        try {
          const params = new URL(url);
          params.searchParams.delete('login_as');
          return void res.end(autopost(this.respond(params.toString(), as)));
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
