# Rules module

Business rules live in `config/rules/*.json`, not in code. A rule set is
versioned, checked when the system starts, carries its own test cases, and runs
as a step in any process definition (playbook).

## Using a rule set as a process step

```json
{
  "id": "validate-intake",
  "name": "Validate onboarding data",
  "skill": "PLAN_SETUP",
  "mode": "AUTO",
  "action": { "type": "rules.evaluate", "params": { "ruleSet": "installation-intake" } }
}
```

| Outcome | What happens |
|---|---|
| No error-severity rule fails | Step is DONE. The full result (outputs, decisions, issues, trace) is stored on the task and later steps can use it. |
| Warnings only | Step still passes; warnings are shown with the result |
| An error-severity rule fails | `AUTO` step becomes an exception routed to a person (fix and retry, or override with justification). `REVIEW` step cannot be approved. |
| A rule can't be evaluated (e.g. a number is missing) | Counted as an error. Rules never fail silently. |

### Conditional steps

Any playbook step can have a `when` condition. It is evaluated once the step's
dependencies are done. If it is false, the step is **skipped** (recorded in the
audit trail with the condition). If it can't be evaluated, the step goes to a
person rather than being silently skipped or run.

```json
{ "id": "enrollment-meetings", "when": "steps['validate-intake'].decisions.segment.enrollmentMeetings == true", ... }
```

## Rule set format

```json
{
  "id": "installation-intake",
  "version": 1,
  "name": "New plan onboarding checks",
  "decisions": [
    { "id": "segment", "rows": [
      { "when": "plan.details.employeeCount < 100",  "then": { "name": "small", "enrollmentMeetings": false } },
      { "when": "plan.details.employeeCount < 1000", "then": { "name": "mid-market", "enrollmentMeetings": true } },
      { "then": { "name": "large", "enrollmentMeetings": true } }
    ]}
  ],
  "outputs": [
    { "name": "qdiaCount", "label": "QDIA funds in lineup", "expr": "countWhere(plan.details.funds, 'qdia', true)", "format": "number" }
  ],
  "rules": [
    { "id": "one-qdia", "when": "len(plan.details.funds) > 0", "assert": "outputs.qdiaCount == 1",
      "severity": "error", "message": "Fund lineup must have exactly one QDIA (found {{outputs.qdiaCount}})",
      "reference": "ERISA 404(c)(5)" }
  ],
  "tests": [
    { "name": "two QDIAs fail", "context": { "plan": { "details": { "funds": [{ "qdia": true }, { "qdia": true }] } } },
      "expect": { "passed": false, "failing": ["one-qdia", "..."] } }
  ]
}
```

Evaluation order: **decision tables** (first matching row wins; a row without
`when` is the default) → **outputs** (in order; each can use earlier ones via
`outputs.<name>`) → **rules** (can use both). Severities are `error` (blocks),
`warning` and `info`. Output formats are `usd`, `number`, `percent`, `date`,
`text` and `boolean`, and are used for display.

## Data a rule can read

| Name | Contents |
|---|---|
| `plan` | `id`, `status`, `tracPlanId`, `details` (sponsor, EIN, contacts, funds, fees, …) |
| `request` | The case's request data (new contact, new fund lineup, termination details, …) |
| `case` | `id`, `type`, `channel`, `clientId` |
| `steps` | Results of completed steps, by step id: `steps['validate-intake'].outputs.qdiaCount` |
| `today` | `YYYY-MM-DD` |
| `client` | Client id |
| `decisions`, `outputs` | This rule set's own results (rule sets only, not step conditions) |

## Expression language

`and or not`, `== != < <= > >=`, `in`, `+ - * / %`, `cond ? a : b`, `[lists]`,
field access with `.` or `['key']`. Text compares as text, so ISO dates compare
correctly. Reading a missing field gives a missing value instead of an error;
arithmetic on a missing value is an error (so a bad calculation is never silent).

Functions: `len isBlank isNumber isDate coalesce countWhere any find pluck
hasDuplicates sum min max abs round floor ceil lower upper trim startsWith
endsWith contains matches emailDomain daysBetween addDays quarterStart year usd`.
The **Rules** screen and `GET /api/rules/functions` list them with descriptions.

**Safety.** Expressions are parsed by a dedicated parser, never `eval`. They can
only read the data above (own fields only; `__proto__`, `constructor` and
`prototype` are refused), can only call the listed functions, can't loop, and
have length and nesting limits. Unknown names, unknown functions and wrong
argument counts are rejected when the configuration loads.

## Per-client rules

A client can swap a rule set for its own version:

```json
// config/clients/acme-premium.json
"ruleSetOverrides": { "termination-fees": "termination-fees-premium" }
```

## Testing and trying rules

- `npm test` runs every rule set's embedded test cases, so a rule change that breaks an example fails the build.
- The **Rules** screen shows each rule set (decision tables, formulas, checks), runs its tests, and evaluates it read-only against any live case.
- API: `GET /api/rules`, `GET /api/rules/:id`, `POST /api/rules/:id/test`, `POST /api/rules/:id/evaluate` with `{caseId}` or `{context}`.

## Rule sets included

| Rule set | Used by |
|---|---|
| `installation-intake` | Installation: validate onboarding data, classify plan size (drives the enrollment-meetings step) |
| `contact-change` | Contact change: validation, plus a fraud warning when the new email domain differs from the sponsor's |
| `fund-change` | Fund change: lineup checks, 30–60 day notice window |
| `fee-change` | Fee change: completeness, warning on large increases |
| `termination-request` | Termination: request checks, blackout notice timing |
| `termination-fees` | Termination: prorated fee calculation |
| `termination-fees-premium` | Premium clients: deconversion fee waived |
