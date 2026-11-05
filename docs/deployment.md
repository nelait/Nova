# Deployment

Plan Ops Hub is a working prototype. It runs the full process end to end, but some
parts a production deployment needs are not built yet. This page lists the
settings, then what to put in place before real plan data goes through it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/planops.db` | SQLite database file |
| `TRAC_BASE_URL` | `mock://trac` | Recordkeeper API; unset uses the built-in mock |
| `TRAC_API_KEY` | none | Recordkeeper API key (required when the URL is real) |
| `FUND_CATALOG_URL` | `mock://fund-catalog` | Fund catalog API; unset uses the built-in mock |
| `ANTHROPIC_API_KEY` | none | Enables Ask Claude and AI agent steps |
| `AI_ASSIST` | on | Set `off` to disable Claude even when a key is present |

Process definitions, rules, integrations, agents, templates and client variations
are files under `config/`. Keep them in version control and review changes like
code: they are your operating procedures.

```bash
npm install
npm test            # 65 tests, including every rule set's own test cases
npm start
```

## Before production

| Area | Today | Needed |
|---|---|---|
| **Sign-in** | No login. The acting user comes from an `x-user-id` header, so any caller can act as anyone. | Single sign-on (OIDC/SAML) and authorization by role and skill on every API route. **Do not expose the prototype to a network.** |
| **Demo endpoints** | `POST /api/trac/simulate-outage` is exposed. | Remove it, or restrict it to test environments. |
| **Database** | SQLite with JSON documents. | Postgres with real tables (services use only the storage interface), backups and retention rules. |
| **External calls** | Run inline when a step becomes ready, with a lock per case. | A durable job queue so slow systems don't hold requests open and work survives restarts; reconciliation with the recordkeeper. |
| **Email** | Written to an outbox table. | A mail service, plus PDF generation for participant notices. |
| **Paper intake** | A simple text parser. | An OCR/IDP service with confidence scores and review of low-confidence fields. |
| **Regulatory content** | References and the fee model are illustrative. | Review by your compliance team and replacement with contract terms. |

## Data and AI

- Claude is optional. With it on, the case data a feature needs is sent to the Anthropic API: for Ask Claude, the task's plan details (including contact names and emails), request and earlier step results; for AI agents, only the fields the agent's input mapping lists. Check this against your data-handling policy.
- Integration call logs record method, path, status and timing, never request or response bodies or secrets.
- Secrets come only from environment variables and are never shown in the UI.

## Upgrading process definitions

1. Change the playbook, rule set or agent and increase its `version`.
2. Add or update the rule set's test cases, then run `npm test`.
3. Deploy. New cases use the new version; open cases record the version they started under.
