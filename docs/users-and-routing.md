# Users and routing

## Users and skills

Each user has skills with a level from 1 to 3 (1 trainee, 2 proficient, 3 expert)
and a capacity: the most open tasks they should hold at once.

| Skill | Typical work |
|---|---|
| `PLAN_SETUP` | Onboarding data, welcome emails, recordkeeper installs |
| `MAINTENANCE` | Contact, fund and fee changes |
| `COMPLIANCE` | Sponsor verification, call-backs, fee disclosures, termination authorization |
| `INVESTMENTS` | Fund lineups, fund mapping |
| `TERMINATIONS` | Termination fees, blackout notices, deconversion |

You can add skills freely: a skill is any name a playbook step uses.

## Loading users from your identity provider

Users come from your identity provider through a SCIM 2.0 import. Skills are
groups named `skill:<SKILL>:<level>`, so skill administration stays in the
identity provider:

```http
POST /api/users/import/scim
{
  "source": "okta",
  "fullSync": true,
  "Resources": [
    { "id": "901", "userName": "kai@example.com", "displayName": "Kai Brown",
      "groups": [{ "display": "skill:INVESTMENTS:2" }, { "display": "skill:TERMINATIONS:2" }] }
  ]
}
```

With `fullSync`, users from that source who are missing from the batch are
deactivated. Importing re-runs routing, so waiting tasks go to newly qualified
people straight away. The **Team & skills** screen does the same import from a
pasted payload. For local testing, `config/users.json` seeds a sample team.

The group `role:admin` grants the admin role (importing and deactivating users,
cancelling cases, reassigning other people's tasks). Importing users needs the
admin role. The group `role:auditor` gives read-only access; auditors are skipped
by routing and can't be given tasks, even if they hold skills. People sign in with the same email their user record has; see
[Sign-in](sign-in.md). Deactivated users are signed out at once.

## How work is routed

1. **Eligible:** active, not an auditor, holds the step's skill at or above its minimum level, and below capacity.
2. **Least loaded:** the lowest ratio of open tasks to capacity.
3. **Ties rotate:** among equally loaded people, whoever was assigned work least recently goes next. Seniority does not win ties, so work is shared evenly.
4. **Deterministic:** the final tie-break is the user id.

If nobody is eligible, the task waits in the unassigned queue and is routed as soon
as someone frees up or a qualified user is added. **Insights** shows the backlog by
skill.

Skill level controls who **may** take a task, not who gets it. Use `minSkillLevel`
for work a trainee should never do. In the sample configuration, every
`COMPLIANCE` step requires level 2, and a test enforces that policy.

## Reassigning

Anyone can send a task back through routing (**Reassign**), which excludes the
current owner, or to a named person, who must hold the skill at the required
level. Every assignment and reassignment is in the audit trail with the reason.
