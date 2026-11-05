# FAQ and troubleshooting

## Adoption

**Do we have to replace our recordkeeper?**
No. The recordkeeper stays the system of record. The hub orchestrates the work
around it and commits results through a configured integration.

**Can we change a process without a developer?**
Process steps, rules, email templates, client variations and AI agents are all
configuration files under `config/`. Business analysts can change them; review
changes like code and run `npm test`, which runs every rule set's own test cases.

**Does it work without AI?**
Yes. Claude is optional. Without it, Ask Claude is hidden and AI agent steps ask
the person to enter the result by hand.

**Can AI change our records or skip a step?**
No. AI never decides which steps run. Its output is a proposal a person approves,
agents can only use read-only lookups, and the hub blocks any email that drops a
required fact.

**How do clients with special service terms fit in?**
Each client can have a variant of any process (extra steps, different automation,
its own templates or rule sets) without forking the standard process. See
[Process definitions](playbooks.md#per-client-variations).

**Can we keep one client's plans away from staff who don't serve that client?**
Yes. Give people `client:<clientId>` groups for the clients they serve; they
then see and are routed only those clients' work. Supervisors and admins see all
clients. See [Client access](sign-in.md#client-access).

**One plan is confidential, or someone has a conflict of interest with a sponsor. Can we restrict just that plan?**
Yes. An admin sets the plan's allow list (only these people) or deny list
(never these people) on the case screen; open tasks move away from anyone who
loses access. See [Plan access](sign-in.md#plan-access).

**How do people sign in?**
Through your identity provider, with OpenID Connect (Okta, Entra ID, Google
Workspace, Ping, Auth0) or SAML 2.0 (ADFS, Shibboleth, or SAML apps in those
providers). Plan Ops Hub never handles passwords, and people must
also be active users in its directory. See [Sign-in](sign-in.md).

**Can our internal audit or compliance reviewers look without changing anything?**
Yes. Give them the `role:auditor` group. (Other roles split up administration:
`supervisor`, `user-admin` and `integration-admin`; you can define your own in
`config/roles.json`. See [Roles and permissions](sign-in.md#roles-and-permissions).) Auditors see every case, its audit
trail, emails and integration calls, and can filter and download the full audit
log as CSV. They can't change anything and are never assigned work. See
[Roles and permissions](sign-in.md#roles-and-permissions).

## Troubleshooting

**"You don't have access yet" after signing in.**
The person signed in at the identity provider but isn't an active Plan Ops Hub
user with that email. Import them through SCIM or reactivate them.

**The server won't start and names a playbook, rule set, integration or agent.**
Configuration is checked at startup. The message names the file, the step or rule,
and the problem, for example `Unknown name "nope"` or `uses unknown rule set`.

**A task says "exception".**
An automatic step failed. The message says why: a failed rule, an unreachable
system after retries, or an AI agent error. Fix the cause and click **Retry**, or
**Override** with a reason.

**A task is in the unassigned queue.**
No active user holds the skill at the required level with spare capacity. Add or
cross-train someone (SCIM import), raise a capacity, or reassign work. Routing runs
again automatically.

**An email can't be sent: "missing required facts".**
The edited email dropped a value the template inserted, such as a fee or date.
Put the value back. It may be reformatted (`$2,500` for `2500`) but not removed.

**"secret TRAC_API_KEY is not set".**
A real recordkeeper URL is configured without its key. Set the environment
variable, or unset `TRAC_BASE_URL` to use the mock.

**Ask Claude or an agent says AI is not configured.**
Set `ANTHROPIC_API_KEY` and restart.
