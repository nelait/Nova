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
- **Sessions are server-side.** The browser holds a random token in an `HttpOnly`, `SameSite=Lax` cookie; the database stores only its SHA-256 hash.
- **Cross-site requests are refused:** requests that change data must be JSON, and their `Origin` must be this site.
- After sign-in you return only to a page on this site.
- With single sign-on, the `x-user-id` header is ignored.

## Signing out

**Sign out** (under your name in the sidebar) ends the Plan Ops Hub session.
You may still be signed in at your identity provider, so the next sign-in can
be immediate.

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
| *Development mode (no sign-in) only listens on localhost* | Configure single sign-on before serving on a network. |
