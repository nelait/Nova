# Concepts

Plan Ops Hub sits between plan sponsors and the recordkeeper. It turns each
request into a case and the case into tasks, routes the tasks to people with the
right skills, automates what is safe to automate, and commits the result to the
recordkeeper, which stays the system of record.

## Plans, cases and tasks

- A **plan** is one employer's retirement plan (401(k), 403(b), 457(b)): sponsor, EIN, contacts, fund lineup and fees. Before installation the hub holds its onboarding data; after installation the recordkeeper is the source of truth and the hub refreshes its copy at the start of every new case.
- A **case** is one business request against one plan. There are five types:

  | Case type | Started when | Ends with |
  |---|---|---|
  | `INSTALLATION` | A new sponsor onboards | The plan is created on the recordkeeper ("installation complete") |
  | `MAINTENANCE_CONTACT` | A plan contact changes | Contact updated on the recordkeeper |
  | `MAINTENANCE_FUNDS` | The fund lineup changes | New lineup on the recordkeeper, participants notified |
  | `MAINTENANCE_FEES` | The fee schedule changes | New fees on the recordkeeper, disclosure sent |
  | `TERMINATION` | The sponsor leaves or deconverts | Plan terminated on the recordkeeper |

- A **task** is one step of a case. Tasks wait (`BLOCKED`) until the steps they depend on are done, then become `READY`, are worked, and end `DONE` or `SKIPPED`.

## Channels

Requests arrive by **digital** submission, **manual** entry by staff, or **paper**
(scanned text). Every channel becomes the same structured request, so nothing
after intake depends on how a request arrived.

## Process definitions (playbooks)

Each case type follows a versioned **playbook** in `config/playbooks/`. A playbook
is a list of steps with dependencies. Every case records the playbook version it
ran under, so you can always tell which process applied. See
[Process definitions](playbooks.md).

## Four kinds of step

| Kind | Step type | What it does |
|---|---|---|
| **Integration** | `integration.call`, plus built-in recordkeeper actions | Reads from or writes to an external system. See [Integrations](INTEGRATIONS.md). |
| **Rules** | `rules.evaluate` | Validations, calculations and decision tables, written as configuration. See [Rules](RULES.md). |
| **AI agent** | `ai.agent` | Claude proposes a result; a person approves or edits it. See [AI agents](AGENTS.md). |
| **Person** | any step in `REVIEW` or `MANUAL` mode | Checklists, call-backs, approvals, emails prepared for review. |

Steps pass data forward: any later step, rule or condition can read an earlier
result as `steps['<step-id>']`.

## Automation modes

Each step has a mode, and clients can override it:

- **AUTO**: runs by itself. If it fails, it becomes an *exception* and goes to a person rather than stalling the case.
- **REVIEW**: the system prepares the work (an email draft, a calculation, a recordkeeper update, an AI proposal) and a person approves it.
- **MANUAL**: a person does the work outside the system and confirms it against a checklist.

## Exceptions

When an automatic step fails (bad data, a system outage, a failed rule), the task
goes to a person with the reason. They can fix the data and **Retry**, or
**Override** with a written justification. Both are audited.

## Routing

Each step names a skill and an optional minimum level. Work goes to an eligible
person with the most spare capacity; ties rotate so work is shared evenly. If no
eligible person is free, the task waits in a queue. See
[Users and routing](users-and-routing.md).

## Guided actions

Every task shows its guidance, checklist, regulatory reference, alerts, and the
prepared work. With Claude enabled, **Ask Claude** adds a case-specific briefing,
risks found in the data, and a rewritten email draft. That help is advisory: it
cannot change which steps run or who receives an email.

## Safeguards built in

- Every outgoing email must keep the facts its template inserted (amounts, dates, names, tickers), whoever edited it.
- Writes to external systems carry an idempotency key, so a retried step never applies twice.
- Every action is in the audit trail, with who did it and why.

## Insights

Insights measure each step: handle time, failures, overrides, how often drafts are
edited, and SLA breaches. They suggest improvements, such as making a step
automatic or fixing a template, for a process owner to decide on.
