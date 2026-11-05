# Getting started

This guide takes you from a fresh checkout to a completed plan installation in
about fifteen minutes.

## 1. Install and run the demo

You need Node.js 22.18 or newer.

```bash
git clone https://github.com/nelait/Nova.git plan-ops
cd plan-ops
npm install
npm run demo        # http://localhost:3000
```

`npm run demo` starts an in-memory instance with 15 sample cases for fictional
plan sponsors: completed installations, plan changes, a termination in progress,
a suspicious contact change, and cases stuck on bad data. Nothing is written to
disk. To start with an empty, persistent database instead, run `npm start`.

## 2. Look around as different people

The **Working as** picker in the sidebar switches between the sample team. Each
person sees only the work routed to them:

| Person | Skills | What you'll find in their inbox |
|---|---|---|
| Priya Shah | Plan setup L3, Maintenance L2 (admin) | Welcome emails, recordkeeper installs |
| Marcus Lee | Plan setup L1, Maintenance L3 | An application with an invalid EIN |
| Elena Garcia | Compliance L3 (supervisor) | Sponsor verification, fee disclosures; can cancel cases and reassign work |
| Rafael Torres | Compliance L2 | Contact-change call-backs, disclosures |
| Sam Okafor | Investments L3 | An AI-proposed fund mapping, a closed fund |
| Dana Kim | Terminations L3 (integration admin) | Termination fees, a blackout notice; can test integrations |
| Olivia Grant | None (auditor) | Nothing: read-only access to every case and the **Audit log** |

## 3. Work a task

1. Switch to Elena or Rafael, open **My work**, and pick the 408(b)(2) fee disclosure.
2. Read the guidance and the regulatory reference, and tick the checklist.
3. Optionally click **Ask Claude** for a case-specific briefing and a rewritten draft. Without an API key the demo shows labeled sample responses.
4. Click **Approve & execute**. The email goes to the outbox, the next step unblocks, and the audit trail records it all.

## 4. Submit your first request

Open **New request**, keep the sample installation, and click **Submit**. Then
open **Cases** and watch it move:

- Automatic steps run immediately: validation rules, contact setup, a fund lookup in the fund catalog, and an availability check.
- Human steps go to the right people by skill, with a due time.
- When the last step installs the plan on the recordkeeper, the case completes and the plan appears under **Recordkeeper**.

Switch the channel to **Paper** to see a paper form's scanned text turned into the same structured request.

## 5. Connect real systems

| To do this | Set | Read |
|---|---|---|
| Use your recordkeeper instead of the mock | `TRAC_BASE_URL`, `TRAC_API_KEY` | [Integrations](INTEGRATIONS.md) |
| Use your fund catalog | `FUND_CATALOG_URL` | [Integrations](INTEGRATIONS.md) |
| Turn on Claude for drafting and AI agent steps | `ANTHROPIC_API_KEY` | [AI agents](AGENTS.md) |
| Load your team | SCIM import from your identity provider | [Users and routing](users-and-routing.md) |

Then adapt the processes to your service model: [Process definitions](playbooks.md),
[Rules](RULES.md), and per-client variations.

## 6. Before you go live

Set up [single sign-on](sign-in.md) with your identity provider, then read
[Deployment](deployment.md). Without single sign-on the app runs in development
mode and only accepts connections from the same computer. To try sign-in
locally first, run `npm run demo:sso` (OpenID Connect) or `npm run demo:saml`.
