# API reference

JSON over HTTP. Send `content-type: application/json`. The acting user is the
`x-user-id` header; in production this must come from a signed-in session (see
[Deployment](deployment.md)). Errors return `{ "error": "...", "issues": [...] }`
with status 404 (not found), 422 (validation), 502 (external system), 503 (AI
unavailable) or 500.

## Requests and cases

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/intake` | Start a case. `{ caseType, channel, clientId?, planId?, data?, documentText? }`. `channel` is `DIGITAL`, `MANUAL` or `PAPER`; paper takes `documentText`. Maintenance and termination need `planId`. |
| GET | `/api/cases` | All cases with progress |
| GET | `/api/cases/:id` | A case with its plan, tasks and audit trail |
| POST | `/api/cases/:id/cancel` | `{ reason }` |
| GET | `/api/plans`, `/api/plans/:id` | Plans |
| PATCH | `/api/plans/:id` | Correct onboarding data. Only before the plan is on the recordkeeper. |

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
| POST | `/api/tasks/:id/start` | Start working a task |
| POST | `/api/tasks/:id/complete` | Approve, confirm, retry or override. `{ notes?, edits?, override?, draftSource? }`. `edits` is `{ subject, body }` for emails or `{ output }` for AI agent steps. |
| POST | `/api/tasks/:id/reassign` | `{ toUserId? }`. Omit to route again. |
| POST | `/api/tasks/:id/agent/run` | Ask the AI agent for a new proposal |
| GET / POST | `/api/tasks/:id/ai-assist` | Stored Claude assist / ask Claude (`{ refresh? }`) |

## Configuration (read-only)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/playbooks`, `/api/clients` | Process definitions and client variations |
| GET | `/api/rules`, `/api/rules/:id`, `/api/rules/functions` | Rule sets and the expression functions |
| POST | `/api/rules/:id/test` | Run a rule set's test cases |
| POST | `/api/rules/:id/evaluate` | `{ caseId }` or `{ context }`. Read-only. |
| GET | `/api/integrations`, `/api/integrations/calls` | Systems (secret status, never values) and the call log |
| POST | `/api/integrations/:id/test` | Run a system's health check |
| GET | `/api/agents`, `/api/ai/status` | AI agents, and whether Claude is enabled |

## Team

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users` | Users with skills and open-task counts |
| POST | `/api/users/import/scim` | SCIM 2.0 import. See [Users and routing](users-and-routing.md). |
| POST | `/api/users/import` | Plain JSON import |
| POST | `/api/users/:id/active` | `{ active }` |

## Monitoring

| Method | Path | Notes |
|---|---|---|
| GET | `/api/insights` | Step metrics and suggestions |
| GET | `/api/audit?limit=200` | Most recent audit events |
| GET | `/api/outbox` | Sent emails |
| GET | `/api/trac/plans` | Recordkeeper plans, read through the integration |
