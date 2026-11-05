# Deployment

Plan Ops Hub is a working prototype. It runs the full process end to end, but some
parts a production deployment needs are not built yet. This page lists the
settings, then what to put in place before real plan data goes through it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_CLIENT_SECRET` | none | Single sign-on with OpenID Connect. See [Sign-in](sign-in.md) for all settings. |
| `SAML_IDP_SSO_URL`, `SAML_IDP_ENTITY_ID`, `SAML_IDP_CERT`, `SAML_ACS_URL` | none | Single sign-on with SAML 2.0 instead. Without OIDC or SAML the app runs in development mode on localhost only. |
| `HOST` | `127.0.0.1` (dev), `0.0.0.0` (SSO) | Listening address |
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
npm test            # 91 tests, including every rule set's own test cases
npm start
```

## Before production

| Area | Today | Needed |
|---|---|---|
| **Sign-in** | Single sign-on through OIDC or SAML 2.0 with server-side sessions, and admin and read-only auditor roles ([Sign-in](sign-in.md)). Without it, development mode listens on localhost only. | Single logout with the identity provider; IdP-initiated SAML sign-in, if you need it; finer-grained roles. |
| **Transport security** | Plain HTTP; cookies are `Secure` when the redirect URI is `https`. | A TLS-terminating proxy or load balancer in front. |
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
