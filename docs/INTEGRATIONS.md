# Integration module

External systems are configuration in `config/integrations/*.json`: where they
are, how to authenticate, timeout and retry policy, and the operations the hub may
call, including how requests are built from case data and how responses are
mapped back. Process steps call them with `"type": "integration.call"`, and the
built-in TRAC actions (install, update, terminate, refresh) go through the same
layer.

## Defining a system

```json
{
  "id": "trac",
  "name": "TRAC recordkeeper",
  "baseUrl": "${TRAC_BASE_URL:-mock://trac}",
  "auth": { "type": "apiKey", "header": "X-API-Key", "secretEnv": "TRAC_API_KEY" },
  "timeoutMs": 10000,
  "retry": { "attempts": 3, "backoffMs": 250, "onStatus": [429, 502, 503, 504] },
  "idempotencyHeader": "Idempotency-Key",
  "healthCheck": "health",
  "operations": {
    "getPlan": {
      "method": "GET",
      "path": "/plans/{{plan.tracPlanId}}",
      "response": { "participantCount": "response.participants", "planAssetsUsd": "response.assetsUsd" }
    },
    "installPlan": {
      "method": "POST",
      "path": "/plans",
      "idempotent": true,
      "body": { "sponsor": { "name": "=plan.details.sponsorName", "ein": "=plan.details.ein" }, "participants": "=plan.details.employeeCount" },
      "response": { "tracPlanId": "response.id" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `baseUrl` | `https://…` (plain `http` only for localhost) or `mock://<name>` for a built-in mock. `${VAR}` / `${VAR:-default}` read the environment. |
| `auth` | `none`, `apiKey` (header), `bearer`, `basic`, or `oauth2ClientCredentials` (token fetched, cached until expiry, refreshed after a 401). Settings name **environment variables**; secrets are never in config, never shown and never logged. |
| `timeoutMs`, `retry` | Per attempt timeout. Retries back off exponentially, on network errors, timeouts and the listed statuses. |
| `path`, `query` | `{{expression}}` placeholders, URL-encoded so data can't change the route (`../admin` becomes `..%2Fadmin`). |
| `body` | JSON template. Strings starting with `=` are expressions; everything else is sent as-is. |
| `response` | One expression, or an object of field → expression, over `response` (parsed JSON), `status` and `input`. Without it, the whole response is returned. |
| `idempotent` | Writes are retried only when marked idempotent. The hub then sends an idempotency key (`caseId:stepId`), so a retry is applied once. `GET` is always retry-safe. |

Expressions use the [rules language](RULES.md) and can read `input`, `plan`,
`request`, `case`, `steps`, `today` and `client`. Every expression is compiled when
the system starts, and a playbook that calls an unknown system or operation is
rejected at startup.

## Using a system in a process

```json
{
  "id": "fetch-fund-data",
  "name": "Look up funds in the fund catalog",
  "mode": "AUTO",
  "action": {
    "type": "integration.call",
    "params": { "system": "fund-catalog", "operation": "lookupFunds", "input": { "tickers": "=pluck(plan.details.funds, 'ticker')" } }
  }
}
```

The step's result is `{ system, operation, status, attempts, durationMs, callId, data }`.
Later steps and rules read it as `steps['fetch-fund-data'].data…`. The installation
playbook chains three step types:

```
fetch-fund-data (integration) ─► check-fund-availability (rules) ─► review-fund-lineup (person)
```

If a call fails after its retries, the step becomes an exception routed to a
person, who can **Retry** once the system is back, or override with a written
justification. A `REVIEW`-mode integration step shows the person exactly which
system, operation and input will be used before they approve it.

## Switching from mock to a real system

TRAC and the fund catalog point at built-in mocks by default (`mock://trac`,
`mock://fund-catalog`), so the demo and tests need no setup. The mocks are REST
handlers with their own field names, so the request and response mappings are
exercised exactly as they would be against the real system. To go live:

```bash
TRAC_BASE_URL=https://trac.example.com/api TRAC_API_KEY=… npm start
```

Nothing else changes. A real URL without its secret fails with
`secret TRAC_API_KEY is not set` rather than calling unauthenticated.

## Admin and observability

- **Integrations screen:** systems, live or mock, auth type, whether each required secret is set (never the value), timeout and retry, operations and which steps use them, a **Test connection** button (runs the `healthCheck` operation), and the call log.
- **Call log** (`GET /api/integrations/calls`): time, system.operation, method, path, status, attempts, duration, case, task and actor. Request and response bodies are **not** stored because they can contain personal data. Query strings are not logged.
- **Recordkeeper screen** reads TRAC through `listPlans`, the same path the engine uses.

## Adding a new system

1. Add `config/integrations/<id>.json` with its operations.
2. Set its environment variables.
3. Call it from a playbook step with `integration.call`, and check its data with a rule set if needed.
4. Optional: for demos and tests, register an in-process mock with `integrations.registerMock('<id>', handler)` and point `baseUrl` at `${X_URL:-mock://<id>}`.

## Path to production

External calls currently run inline when a step becomes ready, guarded by a lock
per case. For production, move them to a durable job queue so a slow or
unavailable system doesn't hold a request open, and add reconciliation against
the recordkeeper.
