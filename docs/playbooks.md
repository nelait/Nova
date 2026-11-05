# Process definitions

Each case type follows a playbook in `config/playbooks/`. A playbook is versioned
JSON: a list of steps, the dependencies between them, and how each is carried
out. Playbooks are checked when the system starts, and a broken one stops
startup with a message that names the step.

## A playbook

```json
{
  "id": "maintenance-funds",
  "version": 2,
  "caseType": "MAINTENANCE_FUNDS",
  "name": "Change fund lineup",
  "description": "Add, remove or map investment options in the plan's lineup.",
  "steps": [
    { "id": "validate-request", "name": "Validate fund change request", "skill": "MAINTENANCE", "mode": "AUTO",
      "action": { "type": "rules.evaluate", "params": { "ruleSet": "fund-change" } }, "slaHours": 4,
      "guidance": "The new lineup must be complete, keep exactly one QDIA, and give an effective date." },
    { "id": "propose-fund-mapping", "name": "Review AI-proposed fund mapping", "skill": "INVESTMENTS", "mode": "REVIEW",
      "action": { "type": "ai.agent", "params": { "agent": "fund-mapping" } },
      "dependsOn": ["validate-request"], "slaHours": 48, "guidance": "…" }
  ]
}
```

Increase `version` whenever you change a playbook. Each case records the version it
started under.

## Step fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the playbook. Later steps refer to its result as `steps['<id>']`. |
| `name` | yes | What people see in their inbox. |
| `skill` | yes | Skill needed to work the step, e.g. `COMPLIANCE`. |
| `minSkillLevel` | no | Minimum level (1 to 3) to be eligible. Default 1. |
| `mode` | yes | `AUTO`, `REVIEW` or `MANUAL`. See [Concepts](concepts.md#automation-modes). |
| `action` | yes | What the step does (table below). |
| `dependsOn` | no | Step ids that must be done or skipped first. |
| `when` | no | Condition ([rules language](RULES.md)). False means the step is skipped and audited. |
| `slaHours` | no | Due time, counted from when the step becomes ready. |
| `guidance` | yes | Shown to the person working the step, and given to Claude. |
| `checklist` | no | Items the person must tick before approving. |
| `regulatoryRef` | no | Regulation or policy the step satisfies. |

## Actions

| `action.type` | Params | Does |
|---|---|---|
| `rules.evaluate` | `ruleSet` | Runs a [rule set](RULES.md). Error-level failures stop the step. |
| `integration.call` | `system`, `operation`, `input` | Calls a configured [integration](INTEGRATIONS.md) and stores its data. |
| `ai.agent` | `agent` | Runs an [AI agent](AGENTS.md). The step must be `REVIEW` mode. |
| `email.send` | `template`, `to`, `cc`, `ccPrevious`, `useRequestFees` | Drafts an email from `config/templates/` to plan contacts by role (`PLAN_ADMINISTRATOR`, `PAYROLL`, `TRUSTEE`, `HR`). |
| `contacts.upsert` | `source`: `plan` or `request` | Creates plan contacts, or applies a requested contact change on the recordkeeper. |
| `funds.apply` | `source`: `plan` or `request` | Approves the lineup, or applies a new lineup on the recordkeeper. |
| `fees.apply` | none | Applies the requested fee schedule on the recordkeeper. |
| `trac.installPlan` | none | Creates the plan on the recordkeeper. |
| `trac.terminatePlan` | none | Terminates the plan on the recordkeeper. |
| `none` | none | A person does the work and confirms it. |

## Conditional steps

```json
{ "id": "enrollment-meetings", "dependsOn": ["welcome-email"],
  "when": "steps['validate-intake'].decisions.segment.enrollmentMeetings == true", … }
```

The condition is evaluated once the dependencies are done. A skipped step counts
as done for the steps after it. If the condition can't be evaluated, the step goes
to a person instead of being skipped silently.

## Email templates

Templates live in `config/templates/<name>.txt`. The first line is the subject,
and `{{path}}` inserts values such as `{{plan.details.sponsorName}}` or
`{{steps.calculate-fees.outputs.totalUsd}}`. Every value a template inserts becomes
a required fact: an edited email, whether edited by a person or by Claude, can't be
sent without it.

## Per-client variations

Clients can follow a variant of the standard process without code changes.
Create `config/clients/<clientId>.json`:

```json
{
  "clientId": "acme-premium",
  "displayName": "Premium service model",
  "playbookOverrides": {
    "INSTALLATION": {
      "modeOverrides": { "welcome-email": "AUTO" },
      "disableSteps": [],
      "addSteps": [{ "id": "kickoff-call", "name": "Hold kickoff call with sponsor", "skill": "PLAN_SETUP", "mode": "MANUAL",
                     "action": { "type": "none" }, "dependsOn": ["welcome-email"], "guidance": "…" }]
    }
  },
  "templateOverrides": { "welcome": "welcome-acme" },
  "ruleSetOverrides": { "termination-fees": "termination-fees-premium" }
}
```

Every client's variant is checked at startup too. One policy check runs in the
test suite: every `COMPLIANCE` step, in every client variant, must require level 2+.

## Checks at startup

- Step ids are unique, dependencies exist, and there are no cycles.
- Conditions and step inputs compile.
- Referenced rule sets, integration operations and agents exist.
- AI agent steps are in `REVIEW` mode.
