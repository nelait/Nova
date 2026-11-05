# Sign-in and single sign-on

Plan Ops Hub signs people in through your organization's identity provider,
with **OpenID Connect (OIDC)** or **SAML 2.0**. OIDC works with Okta, Microsoft
Entra ID, Google Workspace, Ping, Auth0 and other standard providers. SAML covers
providers or setups that only offer it, such as ADFS and Shibboleth, or an
existing SAML app in Okta, Entra ID or Ping. Plan Ops Hub never sees or stores
passwords.

There are three modes:

| Mode | When | Who you are |
|---|---|---|
| **Single sign-on, OIDC** | `OIDC_ISSUER` is set | The person who signed in at your identity provider. Sessions last 8 hours. |
| **Single sign-on, SAML** | `SAML_IDP_SSO_URL` is set | The same, through SAML. |
| **Development** | Neither | Whoever you pick in **Working as**. Anyone can act as anyone, so the server only listens on `127.0.0.1` (this computer) and refuses to start on a network address. |

Configure one of OIDC or SAML, not both; the server refuses to start with both.
**Prefer OIDC when your provider offers it**: it is simpler to set up and has
fewer ways to go wrong. Everything after sign-in (who may sign in, roles,
sessions, sign-out) works the same either way.

## Try it locally

```bash
npm run demo:sso     # OpenID Connect
npm run demo:saml    # SAML 2.0
```

Each starts the demo with a **mock identity provider** (port 3201 for OIDC, 3202 for SAML). Open
<http://localhost:3000>. You are sent to the provider's page, where you pick who
to sign in as. Try:

- **Priya Shah**: an admin, so she can import users, deactivate users and cancel cases.
- **Marcus Lee**: not an admin, so those controls are hidden and the API refuses them.
- **Olivia Grant**: an auditor, who can see everything, including the audit log, but change nothing.
- **Someone not yet provisioned**: signs in at the provider but is refused by Plan Ops Hub, because they aren't in the user directory.

The mock providers sign real tokens and assertions (and the OIDC one checks
PKCE), so this exercises the same code as production. Never use them outside
development.

## Set up OpenID Connect

1. **Register an application** in your provider: type *Web application*, sign-in method *OIDC*, grant type *Authorization Code*. PKCE is always used.
2. **Sign-in redirect URI:** `https://<your Plan Ops Hub address>/auth/callback`.
3. **Scopes:** `openid email profile`.
4. Note the **issuer URL**, **client ID** and **client secret**.
   - Okta: `https://<your-org>.okta.com/oauth2/default`
   - Entra ID: `https://login.microsoftonline.com/<tenant-id>/v2.0`
   - Google Workspace: `https://accounts.google.com`
5. Assign the application to the people who should use Plan Ops Hub.

Then set these environment variables and restart:

| Variable | Required | Meaning |
|---|---|---|
| `OIDC_ISSUER` | yes | Issuer URL. Must be `https` (plain `http` is allowed only for `localhost`). |
| `OIDC_CLIENT_ID` | yes | Client ID from step 4. |
| `OIDC_REDIRECT_URI` | yes | Exactly the redirect URI registered in step 2. When it is `https`, cookies are marked `Secure`. |
| `OIDC_CLIENT_SECRET` | for confidential clients | Client secret. Store it in your secret manager, never in `config/` or version control. |
| `OIDC_SCOPES` | no | Default `openid email profile`. |
| `OIDC_USER_CLAIM` | no | ID token claim that identifies the person. Default `email`. |
| `SESSION_TTL_HOURS` | no | Session length. Default 8. |
| `HOST` | no | Listening address. Default `0.0.0.0` with single sign-on. |

Run Plan Ops Hub behind a TLS-terminating proxy or load balancer so people reach
it over `https`.

## Set up SAML

1. **Create a SAML application** in your identity provider. Most providers can read Plan Ops Hub's service provider metadata: start Plan Ops Hub with the settings below and give the provider `https://<your address>/auth/saml/metadata`. Otherwise enter:
   - **Assertion Consumer Service (ACS) URL / Reply URL:** `https://<your address>/auth/saml/acs` (HTTP-POST binding)
   - **Entity ID / Audience / Identifier:** `https://<your address>/auth/saml/metadata`, or your own value in `SAML_SP_ENTITY_ID`
   - **NameID format:** email address
2. **Sign the assertion** with SHA-256 (the usual default). Signing the whole response as well is fine.
3. **Send the user's email**, as the NameID or in an attribute. Plan Ops Hub reads `email`, `mail`, the standard Microsoft `emailaddress` claim and `urn:oid:0.9.2342.19200300.100.1.3` automatically, then a NameID that is an email. To use another attribute, set `SAML_USER_ATTRIBUTE`.
4. From the provider's metadata or setup page, note the **SSO URL** (HTTP-Redirect binding), the **IdP entity ID / issuer**, and download the **signing certificate**.
   - Entra ID: *Login URL*, *Microsoft Entra Identifier*, *Certificate (Base64)*
   - Okta: *Identity Provider Single Sign-On URL*, *Identity Provider Issuer*, *X.509 Certificate*
   - ADFS: `https://<adfs>/adfs/ls/`, `http://<adfs>/adfs/services/trust`, the token-signing certificate
5. Assign the application to the people who should use Plan Ops Hub.

Then set these environment variables and restart:

| Variable | Required | Meaning |
|---|---|---|
| `SAML_IDP_SSO_URL` | yes | The provider's single sign-on URL. Must be `https` (plain `http` only for `localhost`). |
| `SAML_IDP_ENTITY_ID` | yes | The provider's entity ID. Assertions from any other issuer are refused. |
| `SAML_IDP_CERT` | yes | The provider's signing certificate, PEM or base64 (newlines may be written as `\n`). |
| `SAML_IDP_CERT_2` | no | A second certificate, for rollover: set the new one here before the provider switches, then move it to `SAML_IDP_CERT`. |
| `SAML_ACS_URL` | yes | `https://<your address>/auth/saml/acs`, exactly as registered. |
| `SAML_SP_ENTITY_ID` | no | This app's entity ID. Default: `<your address>/auth/saml/metadata`. |
| `SAML_USER_ATTRIBUTE` | no | Attribute holding the email, if not one of the usual ones. |
| `SAML_WANT_RESPONSE_SIGNED` | no | `true` to also require the whole response to be signed. Default: only the assertion must be signed. |

Only sign-ins started from Plan Ops Hub are accepted. Starting from the
provider's app dashboard (IdP-initiated sign-in) is refused, because an
unsolicited assertion can't be tied to the browser that receives it. Set the
dashboard tile to open `https://<your address>/auth/login` instead (Okta and
Entra ID call this a *bookmark* or *sign-on URL*).

## Who can sign in

Signing in at the identity provider isn't enough: the person must also be an
**active user in Plan Ops Hub**, matched by email (not case-sensitive). That's
where their skills and capacity come from. Keep the directory in step with your
provider through [SCIM import](users-and-routing.md):

- People who aren't in the directory, or whose email isn't verified, see *You don't have access yet*. The refusal is audited as `user.sign-in-refused`.
- **Deactivating a user ends their access immediately**, including sessions already open.
- Sign-ins and sign-outs are audited as `user.signed-in` and `user.signed-out`.

## Roles

Roles are identity-provider groups named `role:<name>`, imported through SCIM
like skill groups, or `"roles": [...]` in a direct import. Without a role, a
person works the tasks their skills qualify them for.

| Role | Group | Can |
|---|---|---|
| **Admin** | `role:admin` | Everything a specialist can, plus: import users, activate or deactivate users, cancel cases, test integration connections, reassign other people's tasks |
| **Auditor** | `role:auditor` | **Read-only.** See every case and its audit trail, plans, rules, integrations and their call log, agents, emails, insights, and the full **Audit log** with filters and CSV download. Run a rule set's tests. Can't start, work, approve, reassign or cancel anything, and is **never routed work**, even with skills. |
| *(none)* | | Start requests, work their own tasks and hand them back to routing, ask Claude, approve agent proposals on their tasks, view everything |

**Read-only wins.** Someone with both `role:auditor` and `role:admin` is
read-only, so adding a group can't quietly give an audit account write access.

To try it, sign in as **Olivia Grant** in `npm run demo:sso`, or pick her in
**Working as** in development mode.

What work a person gets is still decided by their skills and levels, as before.
The server enforces every rule; the UI hides controls a person can't use. The
demo-only *Simulate TRAC outage* button doesn't exist with single sign-on.

## How it's protected

- **Authorization code flow with PKCE**, `state` bound to the browser by a short-lived cookie, and a `nonce` in the ID token, so a stolen or replayed sign-in link can't log someone in.
- **ID tokens are fully verified:** signature against the provider's published keys (RS256/384/512, PS256, ES256/384; `none` and unknown keys are rejected), issuer, audience, expiry and nonce. Key rotation is picked up automatically.
- **SAML assertions are verified by [node-saml](https://github.com/node-saml/node-saml)**, the library behind passport-saml, rather than hand-written XML signature code, which is a classic source of signature-wrapping bugs. The assertion must be signed by the configured certificate (SHA-256), issued by the configured IdP entity ID, addressed to this app (audience, Recipient and Destination), unexpired, and in response to a request this browser made in the last 10 minutes. Each response is accepted once. Tests cover tampered, unsigned, re-signed, wrapped, replayed, misaddressed and unsolicited assertions.
- **Single logout** messages from the provider are verified as strictly as sign-ins; see [What protects logout](#what-protects-logout).
- **Sessions are server-side.** The browser holds a random token in an `HttpOnly`, `SameSite=Lax` cookie; the database stores only its SHA-256 hash.
- **Cross-site requests are refused:** requests that change data must be JSON, and their `Origin` must be this site.
- After sign-in you return only to a page on this site.
- With single sign-on, the `x-user-id` header is ignored.

## Signing out and single logout

**Sign out** (under your name in the sidebar) always ends the Plan Ops Hub
session first, so this browser is signed out even if the identity provider can't
be reached. With single logout set up, it works in both directions:

| | OpenID Connect | SAML |
|---|---|---|
| **Signing out here also signs you out at the provider** | On by default when the provider publishes an `end_session_endpoint` (Okta, Entra ID, Auth0, Ping and most others; Google doesn't). The browser goes to the provider with the ID token as `id_token_hint`, then back to `/auth/signed-out`. | On when `SAML_IDP_SLO_URL` is set. Plan Ops Hub sends a LogoutRequest signed with its own key; the provider's LogoutResponse comes back to `/auth/saml/slo`. |
| **Signing out at the provider ends sessions here** | **Back-channel logout:** the provider calls `/auth/oidc/backchannel-logout` server to server when a session ends, including when an administrator revokes it. Works even if the browser is closed. | **Front-channel logout:** the provider sends a signed LogoutRequest through the browser to `/auth/saml/slo`. Plan Ops Hub ends the matching sessions and replies with a signed LogoutResponse. |

Sessions are matched precisely: an OIDC logout token's `sid` ends that one
session (a `sub` alone ends all of that person's sessions), and a SAML
LogoutRequest's `SessionIndex` ends that one session (without one, all of that
person's SAML sessions). Each is audited as `user.signed-out` with `via`
`idp-backchannel` or `idp-slo`.

### Set up OIDC logout

1. In your provider's application settings, add `https://<your address>/auth/signed-out` as a **sign-out redirect URI** (Okta: *Sign-out redirect URIs*; Entra ID: *Front-channel logout URL* is not needed, but the URI must be a registered redirect URI).
2. Set the **back-channel logout URI** to `https://<your address>/auth/oidc/backchannel-logout`, with *session required* (sid) on if offered. Okta and Auth0 support back-channel logout; Entra ID doesn't, so with Entra ID sessions here end at their normal expiry after sign-out elsewhere.

| Variable | Default | Meaning |
|---|---|---|
| `OIDC_POST_LOGOUT_REDIRECT_URI` | `<your address>/auth/signed-out` | Where the provider sends the browser after signing out. |
| `SSO_LOGOUT` | `idp` | `local` to sign out of Plan Ops Hub only. |

### Set up SAML single logout

1. Create a signing key and certificate for Plan Ops Hub, for example
   `openssl req -x509 -newkey rsa:2048 -sha256 -days 730 -nodes -keyout sp.key -out sp.crt -subj "/CN=Plan Ops Hub"`.
   Keep `sp.key` in your secret manager.
2. Set the variables below and restart. The metadata at `/auth/saml/metadata` now includes the **SingleLogoutService** URL `https://<your address>/auth/saml/slo` and the signing certificate; re-import it at the provider, or enter both by hand.
3. Turn on single logout for the application at the provider.

| Variable | Required for single logout | Meaning |
|---|---|---|
| `SAML_IDP_SLO_URL` | yes | The provider's single logout URL (HTTP-Redirect binding). Setting it turns single logout on. |
| `SAML_SP_PRIVATE_KEY` | yes | Plan Ops Hub's signing key, PEM. Logout requests must be signed. Also signs sign-in requests. |
| `SAML_SP_CERT` | yes | The matching certificate, PEM, published in the metadata. |

### What protects logout

- **Back-channel logout tokens** must be signed by the provider for this application, issued in the last 5 minutes, carry the back-channel logout event and a `jti`, and contain no `nonce` (so an ID token can't be passed off as one). Each `jti` is accepted once.
- **SAML LogoutRequests** must be signed by the provider's certificate, on both bindings. node-saml accepts unsigned ones on the redirect binding, so Plan Ops Hub checks that signature itself, over the parameters exactly as received, refusing repeated parameters. They must also come from the configured provider, be addressed to this application, be issued in the last 10 minutes, and are accepted once.
- A **LogoutResponse** that can't be verified doesn't undo anything: you are already signed out here, and the page says the provider didn't confirm.

Without single logout (SAML without `SAML_IDP_SLO_URL`, a provider without an
end-session endpoint, or `SSO_LOGOUT=local`), you may still be signed in at your
identity provider after signing out here, so the next sign-in can be immediate.

## Troubleshooting

| You see | Check |
|---|---|
| *Single sign-on is configured but OIDC_CLIENT_ID… is not set* at startup | All three required variables are set. |
| The provider says the redirect URI doesn't match | `OIDC_REDIRECT_URI` matches the registered URI exactly, including `https` and path. |
| *You don't have access yet* | The person is in Plan Ops Hub, active, with the same email as at the provider. |
| *This sign-in was started in a different browser…* | The sign-in took more than 10 minutes, or cookies are blocked. Start again. |
| *ID token audience does not match* | `OIDC_CLIENT_ID` is the ID of this application, not another one. |
| *SAML response was rejected: Invalid signature* | `SAML_IDP_CERT` is the provider's current signing certificate. During rollover, set both certificates. |
| *SAML assertion audience mismatch* | The entity ID registered at the provider equals `SAML_SP_ENTITY_ID` (default `<your address>/auth/saml/metadata`). |
| *…issued by …, not the configured identity provider* | `SAML_IDP_ENTITY_ID` matches the provider's issuer exactly. |
| *InResponseTo is missing* or *…not valid* after clicking the app tile | IdP-initiated sign-in isn't supported. Point the tile at `/auth/login`. |
| *The SAML assertion has no email attribute* | Send the email as the NameID or an attribute, or set `SAML_USER_ATTRIBUTE`. |
| After signing out, the provider says the redirect URI isn't allowed | Register `https://<your address>/auth/signed-out` as a sign-out redirect URI, or set `OIDC_POST_LOGOUT_REDIRECT_URI` to one you have registered. |
| *…didn't confirm that it signed you out too* | The provider's LogoutResponse couldn't be verified (often a changed certificate). Plan Ops Hub's session has ended regardless. |
| *Logout requests from the identity provider must be signed* | Turn on signing of logout messages at the provider. |
| *Single logout (SAML_IDP_SLO_URL) needs SAML_SP_PRIVATE_KEY and SAML_SP_CERT* | Create the key and certificate (see above). |
| *Development mode (no sign-in) only listens on localhost* | Configure single sign-on before serving on a network. |
