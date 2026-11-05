# API reference

JSON over HTTP. Requests that change data must send `content-type: application/json`
from this site's own origin.

**Who is calling.** With [single sign-on](sign-in.md) (OIDC or SAML), the session cookie set at
sign-in identifies the user; without one the API returns 401
`{ "error": "Sign in required", "signIn": "/auth/login" }`. In development mode
(localhost only) the acting user is the `x-user-id` header.

**Permissions.** Routes that change data need the [permission](sign-in.md#permissions)
shown in **bold**; without it they return 403 naming it. Read-only routes need
none, except the audit log. Auditors can use every `GET` route they have
permission for and the rule `test` and `evaluate` routes.

Errors return `{ "error": "...", "issues": [...] }` with status 401 (not signed
in), 403 (not allowed), 404 (not found), 422 (validation), 502 (external system),
503 (AI unavailable) or 500.

## Sign-in

| Method | Path | Notes |
|---|---|---|
| GET | `/auth/login?returnTo=/path` | Redirects to the identity provider |
| GET | `/auth/callback` | OIDC: the provider returns here; sets the session cookie |
| POST | `/auth/saml/acs` | SAML: the provider posts the response here; sets the session cookie |
| GET | `/auth/saml/metadata` | SAML: this app's service provider metadata |
| POST | `/auth/logout` | Ends the session; returns `{ redirect }`: the provider's logout (single logout) or `/auth/signed-out` |
| POST | `/auth/oidc/backchannel-logout` | OIDC back-channel logout, called by the provider: form field `logout_token` |
| GET / POST | `/auth/saml/slo` | SAML single logout: LogoutRequests from the provider, LogoutResponses to ours |
| GET | `/api/me` | `{ mode: "oidc" \| "saml" \| "dev", user: { id, name, email, roles, permissions, readOnly, skills } }` |
| GET | `/api/roles` | Permissions, roles and default roles from `config/roles.json` |

## Requests and cases

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/intake` | Start a case. `{ caseType, channel, clientId?, planId?, data?, documentText? }`. `channel` is `DIGITAL`, `MANUAL` or `PAPER`; paper takes `documentText`. Maintenance and termination need `planId`. · **cases.start** |
| GET | `/api/cases` | All cases with progress |
| GET | `/api/cases/:id` | A case with its plan, tasks and audit trail |
| POST | `/api/cases/:id/cancel` | `{ reason }` · **cases.cancel** |
| GET | `/api/plans`, `/api/plans/:id` | Plans |
| PATCH | `/api/plans/:id` | Correct onboarding data. Only before the plan is on the recordkeeper. · **plans.edit** |

Example: start an installation.

```http
POST /api/intake
{ "caseType": "INSTALLATION", "channel": "DIGITAL", "clientId": "default",
  "data": { "details": { "sponsorName": "Northwind Analytics Inc.", "ein": "45-1234567", "employeeCount": 320,
    "planType": "401K", "effectiveDate": "2027-01-01",
    "contacts": [{ "role": "PLAN_ADMINISTRATOR", "name": "Jane Doe", "email": "jane@northwind.example" }],
    "funds": [{ "ticker": "FXAIX", "name": "Fidelity 500 Index" }, { "ticker": "FDEWX", "name": "Fidelity Freedom 2055", "qdia": true }],
    "fees": { "recordkeepingBps": 8, "perParticipantUsd": 40, "terminationBaseUsd": 2500 } } } }
```

## Work

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/inbox/:userId` | Open tasks for a user, most urgent first |
| GET | `/api/queue/unassigned` | Ready tasks nobody is eligible for |
| GET | `/api/tasks/:id/guidance` | Guidance, checklist, alerts and the prepared work |
| POST | `/api/tasks/:id/start` | Start working a task · **tasks.work** |
| POST | `/api/tasks/:id/complete` | Approve, confirm, retry or override. `{ notes?, edits?, override?, draftSource? }`. `edits` is `{ subject, body }` for emails or `{ output }` for AI agent steps. · **tasks.work**; `override` also needs **tasks.override** |
| POST | `/api/tasks/:id/reassign` | `{ toUserId? }`. Omit to route again. Your own task with **tasks.work**, anyone's with **tasks.reassign**. |
| POST | `/api/tasks/:id/agent/run` | Ask the AI agent for a new proposal · **tasks.work** |
| GET / POST | `/api/tasks/:id/ai-assist` | Stored Claude assist / ask Claude (`{ refresh? }`); POST needs **tasks.work** |

## Configuration (read-only)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/playbooks`, `/api/clients` | Process definitions and client variations |
| GET | `/api/rules`, `/api/rules/:id`, `/api/rules/functions` | Rule sets and the expression functions |
| POST | `/api/rules/:id/test` | Run a rule set's test cases |
| POST | `/api/rules/:id/evaluate` | `{ caseId }` or `{ context }`. Read-only. |
| GET | `/api/integrations`, `/api/integrations/calls` | Systems (secret status, never values) and the call log |
| POST | `/api/integrations/:id/test` | Run a system's health check · **integrations.test** |
| GET | `/api/agents`, `/api/ai/status` | AI agents, and whether Claude is enabled |

## Team

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users` | Users with skills and open-task counts |
| POST | `/api/users/import/scim` | SCIM 2.0 import. See [Users and routing](users-and-routing.md). · **users.manage** |
| POST | `/api/users/import` | Plain JSON import · **users.manage** |
| POST | `/api/users/:id/active` | `{ active }` · **users.manage** |

## Monitoring

| Method | Path | Notes |
|---|---|---|
| GET | `/api/insights` | Step metrics and suggestions |
| GET | `/api/audit` | Audit events, newest first. Filters: `actor`, `event` (prefix, e.g. `task.`), `entityId`, `from`, `to` (ISO dates; `to` exclusive), `limit` (default 200, max 10,000). `format=csv` downloads a CSV. · **audit.read** |
| GET | `/api/outbox` | Sent emails |
| GET | `/api/trac/plans` | Recordkeeper plans, read through the integration |
