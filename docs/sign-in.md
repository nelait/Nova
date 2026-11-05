# Sign-in and single sign-on

Plan Ops Hub signs people in through your organization's identity provider
using OpenID Connect (OIDC). It works with Okta, Microsoft Entra ID, Google
Workspace, Ping, Auth0 and any other standard OIDC provider. Plan Ops Hub never
sees or stores passwords.

There are two modes:

| Mode | When | Who you are |
|---|---|---|
| **Single sign-on** | `OIDC_ISSUER` is set | The person who signed in at your identity provider. Sessions last 8 hours. |
| **Development** | No `OIDC_*` settings | Whoever you pick in **Working as**. Anyone can act as anyone, so the server only listens on `127.0.0.1` (this computer) and refuses to start on a network address. |

## Try it locally

```bash
npm run demo:sso
```

This starts the demo with a **mock identity provider** on port 3201. Open
<http://localhost:3000>. You are sent to the provider's page, where you pick who
to sign in as. Try:

- **Priya Shah**: an admin, so she can import users, deactivate users and cancel cases.
- **Marcus Lee**: not an admin, so those controls are hidden and the API refuses them.
- **Olivia Grant**: an auditor, who can see everything, including the audit log, but change nothing.
- **Someone not yet provisioned**: signs in at the provider but is refused by Plan Ops Hub, because they aren't in the user directory.

The mock provider signs real tokens and checks PKCE, so this exercises the same
code as production. Never use it outside development.

## Set up your identity provider

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
| *Development mode (no sign-in) only listens on localhost* | Configure single sign-on before serving on a network. |
