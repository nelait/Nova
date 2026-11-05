# Architecture

## Purpose

Plan Ops Hub sits between a plan sponsor (the employer) and the recordkeeper
(TRAC). It turns each business request into a set of tasks and routes them to
people with the right skills. For each task it gives guidance and pre-built work
product, automates what is safe to automate, and commits the final result to the
recordkeeper. **After go-live the recordkeeper is the system of record.** The hub
keeps only a working snapshot of the plan.

## Lifecycle → case types

| Lifecycle stage | Case type | Playbook | Ends with |
|---|---|---|---|
| Onboarding / plan setup | `INSTALLATION` | `config/playbooks/installation.json` | `trac.installPlan`, then plan becomes `ACTIVE` ("Installation Complete") |
| Ongoing maintenance | `MAINTENANCE_CONTACT`, `MAINTENANCE_FUNDS`, `MAINTENANCE_FEES` | `maintenance-*.json` | Update on TRAC |
| Termination / deconversion | `TERMINATION` | `termination.json` | `trac.terminatePlan`, then plan becomes `TERMINATED` |

New request types are added with a new playbook JSON file plus a `CaseType` value. No engine changes are needed.

## Components

```
 Paper (OCR text) ─┐
 Digital portal  ──┼─► [1] Intake ──► [2] Case & Work Item Engine ◄──── [5] Knowledge Base
 Manual entry    ──┘   normalize        case → tasks (DAG)                playbooks, templates,
                                         AUTO runs, others routed          client overrides
                                               │
   IdP (SCIM) ─► [3] User Directory ─► [4] Skill Router ─► user inbox
                    users, skills,          skill+level, capacity,
                    capacity                load balancing, queue
                                               │
                                     [6] Guided Actions ── user reviews / edits / approves
                                         guidance, checklist, regulatory ref,
                                         drafted email / payload / calculation, alerts
                                               │
                                     [7] Action Executor ──► Email gateway
                                         prepare() = no side effects ──► TRAC adapter (idempotent)
                                         execute() = side effects
                                               │
                                     [8] Audit trail ──► [9] Insights (review & learn)
                                                            suggestions to process owners
```

| # | Component | Code |
|---|---|---|
| 1 | Intake: all channels normalized to one shape | `src/intake/intake.ts` |
| 2 | Case & work-item engine: task DAG, state machine, SLA, completion | `src/cases/caseService.ts` |
| 3 | User directory: import/sync from the IdP, skills as `skill:<SKILL>:<level>` groups | `src/users/userDirectory.ts` |
| 4 | Skill router | `src/routing/skillRouter.ts` |
| 5 | Knowledge base: playbooks, templates, per-client overrides | `src/knowledge/knowledgeBase.ts`, `config/` |
| 6 | Guided actions | `src/guidance/guidedActions.ts` |
| 7 | Action executor / integration hub | `src/actions/executor.ts`, `src/integrations/*` |
| 8 | Audit | `audit` table, written by `CaseService.save` |
| 9 | Insights / learning loop | `src/learning/insights.ts` |

## Key design decisions

1. **Playbooks are deterministic and versioned. The guidance layer is advisory.**
   Which steps happen, especially regulatory ones, comes from a versioned playbook
   and is recorded on the case (`playbookId@version`). The guidance layer, including
   any future LLM enricher (`GuidanceEnricher`), may explain, pre-fill, draft or
   flag, but it can't add, drop or reorder steps. This keeps every case auditable.

2. **Automation level is set per step (`AUTO` / `REVIEW` / `MANUAL`), not per workflow.**
   It can be overridden per client. A failed `AUTO` step doesn't stall the case: it
   becomes an *exception* and is routed to a person, who can fix the data and
   retry, or override with a written justification. Both outcomes are audited.

3. **`prepare()` vs `execute()`.** Every action can describe what it *will* do
   (the drafted email, the TRAC payload, the fee calculation) without side effects.
   That powers both guided actions and human review. `execute()` performs the side
   effects through ports (`RecordkeeperAdapter`, `EmailGateway`).

4. **The recordkeeper is the source of truth after go-live.**
   - A maintenance or termination case first refreshes the hub's plan snapshot from TRAC.
   - Onboarding data can be corrected in the hub only before the plan is installed. After that, changes need a maintenance case.
   - Every TRAC write carries an idempotency key (`caseId:stepId`), so retries after timeouts never double-post. Emails are idempotent per task in the same way.

5. **Generic core, client customization via config.** `config/clients/<id>.json`
   can disable steps, change a step's mode, add client-specific steps, and swap
   templates (see `acme-premium.json`). Playbooks are validated (unknown
   dependencies and cycles are rejected) after overrides are applied.

6. **Learning suggests; people decide.** Insights measure each step (handle time,
   auto-failure rate, overrides, how often drafts are edited, SLA breaches, backlog
   by skill) and produce suggestions, for example "drafts approved unchanged 5/5,
   consider AUTO" or "60% of drafts edited, fix the template". Playbooks are never
   changed automatically.

## Task state machine

```
BLOCKED ──deps done──► READY ──(AUTO)──► run ──ok──► DONE
                         │                  └─fail─► READY + exception ─► routed to a person
                         ├──(REVIEW/MANUAL)─► routed ─► IN_PROGRESS ─► DONE
                         └── no eligible user ─► stays in skill queue; re-routed when
                                                 capacity frees up or users are imported
Case: OPEN ─all tasks DONE/SKIPPED─► COMPLETED      (cancel ─► CANCELLED, open tasks SKIPPED)
```

## Routing policy

Eligible users are active, hold the task's skill at or above `minSkillLevel`, and
are below capacity. Among them the router picks the lowest load ratio (open tasks ÷
capacity), then the higher skill level, then user id. With no eligible user the task
waits in the unassigned queue, and Insights reports the backlog by skill.

## Regulatory touchpoints modelled (illustrative, not legal advice)

| Step | Reference |
|---|---|
| Fee disclosure at installation and on fee change | ERISA 408(b)(2) |
| Default investment in the lineup | QDIA, ERISA 404(c)(5) |
| Fund lineup change notice (30–60 days) | ERISA 404(c)(4) |
| Blackout notice on deconversion (≥30 days) | ERISA 101(i) |
| Contact change call-back, sponsor verification | Firm fraud / KYC policy |

The termination fee model (`calculateTerminationFees`) is a placeholder: prorated
asset and per-participant fees plus a flat deconversion fee. Replace it with the
actual contract terms.

## Path to production

| Prototype | Production |
|---|---|
| `node:sqlite` document store | Postgres with real tables (the services use only the `Collection` interface) |
| `MockTracAdapter` | Real TRAC integration (API / file feed) behind `RecordkeeperAdapter`; add reconciliation |
| Outbox table | Mail service + template/document service (PDF notices) |
| In-process `advance()` | Durable workflow engine or job queue (e.g. Temporal, or a DB-backed outbox), so AUTO steps retry with backoff |
| `x-user-id` header | OIDC/SAML login; authorization by role and skill |
| Regex "OCR" parser | IDP/OCR service with per-field confidence and low-confidence review |
| Rule-based guidance | Add an LLM `GuidanceEnricher` grounded on the knowledge base (drafting, summarising sponsor emails, spotting anomalies) |
