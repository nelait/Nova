// Demo dataset: drives real cases through the engine over a simulated ~4-week
// timeline, so every screen (inbox, cases, exceptions, recordkeeper, outbox,
// insights) has realistic content. All companies and people are fictional.
import type { App } from '../src/app.ts';
import type { AssistOutput, ModelCall } from '../src/ai/claudeAssist.ts';
import type { AgentModel } from '../src/ai/agents.ts';
import { skeleton } from '../src/ai/jsonSchema.ts';
import type { Fund, PlanDetails, Task } from '../src/domain/types.ts';

/** Clock that replays history in simulated time, then switches to real time. */
export class DemoClock {
  private t: number;
  private live = false;
  constructor(start: Date) {
    this.t = start.getTime();
  }
  now(): Date {
    return this.live ? new Date() : new Date(this.t);
  }
  advance(hours: number): void {
    this.t += hours * 3_600_000;
  }
  goLive(): void {
    this.live = true;
  }
}

export const SAMPLE_LABEL = 'sample data (not a live Claude call)';

/**
 * Canned stand-in for Claude used when no API key is set. It builds plausible,
 * case-specific output from the prompt so the panel can be shown, and is labeled
 * as sample data everywhere it appears.
 */
export const sampleModel: ModelCall = async ({ user }) => {
  const block = (tag: string) => JSON.parse(user.split(`<${tag}>\n`)[1].split(`\n</${tag}>`)[0]);
  const task = block('task');
  const data = block('case_data');
  const prepared = block('prepared_work');
  const p = data.plan;
  const req = data.request ?? {};
  const today = new Date(task.today);
  const daysTo = (d?: string) => (d ? Math.round((new Date(d).getTime() - today.getTime()) / 86_400_000) : NaN);

  const risks: AssistOutput['risks'] = [];
  const checks: string[] = [];
  let briefing = `${p.sponsorName} runs a ${p.planType} plan with ${p.employeeCount.toLocaleString()} employees${p.planAssetsUsd ? ` and about $${(p.planAssetsUsd / 1e6).toFixed(1)}M in assets` : ''}. `;

  const eff = daysTo(p.effectiveDate);
  if (data.plan.status === 'ONBOARDING' && eff < 60) risks.push({ severity: 'medium', message: `Go-live is ${eff} days away (${p.effectiveDate}); anything that must reach the sponsor before the contract should go out this week.` });
  const payroll = p.contacts?.find((c: { role: string }) => c.role === 'PAYROLL');
  if (payroll?.email?.startsWith('payroll@')) risks.push({ severity: 'low', message: `Payroll contact is a shared mailbox (${payroll.email}); ask for a named person for file-format questions.` });

  switch (task.caseType) {
    case 'TERMINATION': {
      const b = daysTo(req.blackoutStart);
      briefing += `They are moving to ${req.successorProvider} effective ${req.effectiveDate} (${req.reason?.toLowerCase()}).`;
      if (!Number.isNaN(b) && b < 30) risks.push({ severity: 'high', message: `Blackout starts ${req.blackoutStart}, only ${b} days from today. The 30-day participant notice can no longer be met unless the blackout moves.` });
      checks.push('Confirm the successor provider has accepted the transfer date in writing', 'Check whether the contract waives the deconversion fee for plans over 5 years');
      break;
    }
    case 'MAINTENANCE_FUNDS': {
      const removed = (p.funds as Fund[]).filter((f) => !(req.funds as Fund[]).some((n) => n.ticker === f.ticker)).map((f) => f.ticker);
      briefing += `The change removes ${removed.join(', ') || 'no funds'} effective ${req.effectiveDate}, ${daysTo(req.effectiveDate)} days out.`;
      if (removed.length) checks.push(`Confirm where balances in ${removed.join(', ')} map to, and that the mapping is in the participant notice`);
      break;
    }
    case 'MAINTENANCE_CONTACT':
      briefing += `The request replaces the ${String(req.contact?.role).replace('_', ' ').toLowerCase()} with ${req.contact?.name}.`;
      if (req.contact?.email && !String(req.contact.email).endsWith(String(p.contacts?.[0]?.email ?? '').split('@')[1] ?? '')) {
        risks.push({ severity: 'high', message: `New contact email (${req.contact.email}) is on a different domain from the sponsor's other contacts. Treat as a possible fraud attempt until the call-back is done.` });
      }
      checks.push('Call back the current plan administrator on the number in the service agreement');
      break;
    default:
      briefing += `This step: ${task.step.toLowerCase()}.`;
      if (task.exception) {
        risks.push({ severity: 'high', message: 'Onboarding data failed validation; fix with the sponsor before anything goes out.' });
        checks.push('Ask the sponsor for their IRS EIN confirmation letter (CP 575) to settle the EIN');
      }
      if (prepared.kind === 'email' && /408/.test(task.regulatoryRef ?? '')) checks.push(`Confirm ${p.fees.recordkeepingBps} bps and $${p.fees.perParticipantUsd}/participant match the signed fee schedule`);
  }

  let emailDraft: AssistOutput['emailDraft'] = null;
  if (prepared.kind === 'email') {
    const extra =
      task.caseType === 'TERMINATION'
        ? 'We know a provider change is a lot of work for your team, and we will coordinate directly with your new provider on the asset transfer.'
        : data.plan.status === 'ONBOARDING'
          ? `We are on track for your ${p.effectiveDate} start, and this message is part of getting everything in place before then.`
          : 'Thank you for keeping us up to date. The details are below.';
    emailDraft = {
      subject: prepared.subject,
      body: prepared.body.replace(/^((?:Dear|Hi) [^,\n]+,)/, `$1\n\n${extra}`),
      changes: 'Added a short opening that puts the email in the context of this sponsor\'s timeline.',
    };
  }
  return {
    output: { briefing, risks, checks: checks.slice(0, 5), emailDraft },
    model: SAMPLE_LABEL,
    servedBy: SAMPLE_LABEL,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
};

/**
 * Canned stand-in for an AI agent when no API key is set. For the fund-mapping
 * agent it uses its lookup tool (a real call through the integration layer to
 * the mock fund catalog) and maps by asset class. Labeled as sample data.
 */
export const sampleAgentModel: AgentModel = async ({ user, tools, outputSchema }) => {
  const data = JSON.parse(user.split('<case_data>\n')[1].split('\n</case_data>')[0]) as { removedFunds?: Fund[]; newLineup?: Fund[] };
  const label = { model: SAMPLE_LABEL, servedBy: SAMPLE_LABEL, usage: { inputTokens: 0, outputTokens: 0 } };
  if (!data.removedFunds || !data.newLineup || !tools[0]) return { ...label, output: skeleton(outputSchema), toolCalls: [] };
  const tickers = [...data.removedFunds, ...data.newLineup].map((f) => f.ticker);
  const looked = (await tools[0].run({ tickers })) as { funds: { ticker: string; name?: string }[] };
  const name = (t: string) => looked.funds.find((f) => f.ticker === t)?.name ?? t;
  const kind = (n: string) => (/international/i.test(n) ? 'international stocks' : /bond|income/i.test(n) ? 'bonds' : /500|stock|growth/i.test(n) ? 'U.S. stocks' : /target|freedom/i.test(n) ? 'target-date' : 'other');
  const mappings: { fromTicker: string; toTicker: string; rationale: string }[] = [];
  const unmatchedFunds: { ticker: string; reason: string }[] = [];
  for (const f of data.removedFunds) {
    const k = kind(name(f.ticker));
    const target = data.newLineup.find((n) => kind(name(n.ticker)) === k);
    if (target) mappings.push({ fromTicker: f.ticker, toTicker: target.ticker, rationale: `Both ${name(f.ticker)} and ${name(target.ticker)} are index funds investing in ${k}, so risk and return should be similar.` });
    else unmatchedFunds.push({ ticker: f.ticker, reason: `No fund in the new lineup invests in ${k}.` });
  }
  return {
    ...label,
    output: { mappings, unmatchedFunds, confidence: unmatchedFunds.length ? 'low' : 'high', reviewerNotes: 'Confirm the replacement tracks a comparable index and check its expense ratio before approving.' },
    toolCalls: [{ tool: tools[0].name, input: { tickers }, ok: true }],
  };
};

const VANGUARD = {
  sp500: { ticker: 'VFIAX', name: 'Vanguard 500 Index Admiral' },
  bond: { ticker: 'VBTLX', name: 'Vanguard Total Bond Market Index Admiral' },
  intl: { ticker: 'VTIAX', name: 'Vanguard Total International Stock Index Admiral' },
  td2060: { ticker: 'VTTSX', name: 'Vanguard Target Retirement 2060', qdia: true },
};
const FIDELITY = {
  sp500: { ticker: 'FXAIX', name: 'Fidelity 500 Index' },
  bond: { ticker: 'FXNAX', name: 'Fidelity U.S. Bond Index' },
  intl: { ticker: 'FSPSX', name: 'Fidelity International Index' },
  freedom2055: { ticker: 'FDEWX', name: 'Fidelity Freedom 2055', qdia: true },
};

function plan(p: Partial<PlanDetails> & Pick<PlanDetails, 'sponsorName' | 'ein' | 'employeeCount'>, domain: string, admin: string): PlanDetails {
  return {
    planType: '401K',
    effectiveDate: '2027-01-01',
    planAssetsUsd: p.employeeCount * 52_000,
    contacts: [
      { role: 'PLAN_ADMINISTRATOR', name: admin, email: `${admin.split(' ')[0].toLowerCase()}@${domain}` },
      { role: 'PAYROLL', name: 'Payroll Team', email: `payroll@${domain}` },
      { role: 'TRUSTEE', name: 'Board Treasurer', email: `treasurer@${domain}` },
    ],
    funds: [VANGUARD.sp500, VANGUARD.bond, VANGUARD.intl, VANGUARD.td2060],
    fees: { recordkeepingBps: 8, perParticipantUsd: 40, terminationBaseUsd: 2500 },
    ...p,
  };
}

/** Seeds the app. Returns once the clock is live (real time). */
export async function seedDemo(app: App, clock: DemoClock): Promise<{ cases: number }> {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tick = (min: number, max: number) => clock.advance(min + rand() * (max - min));

  const open = (caseId: string) => app.cases.tasksFor(caseId).filter((t) => (t.status === 'READY' || t.status === 'IN_PROGRESS') && t.assigneeId);
  const draftOf = (t: Task) => {
    const p = app.guidance.forTask(app.cases.contextFor(t, t.assigneeId!)).prepared;
    return p?.kind === 'email' ? p : undefined;
  };

  /** Works one task the way a person would: start, think, maybe use Claude, finish. */
  async function work(t: Task, style: { ai?: boolean; edit?: boolean } = {}) {
    const u = t.assigneeId!;
    app.cases.startTask(t.id, u);
    tick(0.2, 1.5);
    const d = draftOf(t);
    let edits: { subject: string; body: string } | undefined;
    let draftSource: 'ai' | 'template' | undefined;
    if (d && style.ai) {
      const a = await app.ai.assist(t.id, u);
      edits = { subject: a.emailDraft!.subject, body: a.emailDraft!.body };
      draftSource = 'ai';
    } else if (d) {
      edits = { subject: d.subject, body: style.edit ? d.body.replace('Kind regards,', 'If anything here looks off, just reply to this email.\n\nKind regards,') : d.body };
      draftSource = 'template';
    }
    await app.cases.completeTask(t.id, u, { notes: 'Checked against sponsor paperwork', edits, draftSource });
    tick(0.5, 5);
  }

  /** Works every open task in a case, optionally stopping before some steps. */
  async function run(caseId: string, opts: { stopAt?: string[]; ai?: string[]; edit?: string[] } = {}) {
    for (let i = 0; i < 30; i++) {
      const next = open(caseId).filter((t) => !opts.stopAt?.includes(t.stepId));
      if (!next.length) return;
      for (const t of next) await work(t, { ai: opts.ai?.includes(t.stepId), edit: opts.edit?.includes(t.stepId) });
    }
  }

  const intake = async (body: Parameters<App['cases']['submitIntake']>[0], by = 'portal') => {
    const r = await app.cases.submitIntake(body, by);
    tick(1, 4);
    return r.case;
  };

  // ---- Completed installations (history that feeds Insights)
  const installed: Record<string, string> = {};
  const completed: [PlanDetails, string, { ai?: string[]; edit?: string[] }][] = [
    [plan({ sponsorName: 'Northwind Analytics Inc.', ein: '45-1234567', employeeCount: 320, effectiveDate: '2026-12-01' }, 'northwind.example', 'Jane Doe'), 'default', { edit: ['welcome-email'] }],
    [plan({ sponsorName: 'Cedar Ridge Health Partners', ein: '82-4455120', employeeCount: 1240, planType: '403B', effectiveDate: '2026-12-01', funds: [FIDELITY.sp500, FIDELITY.bond, FIDELITY.intl, FIDELITY.freedom2055] }, 'cedarridge.example', 'Marisol Vega'), 'default', { ai: ['welcome-email'] }],
    [plan({ sponsorName: 'Tidewater Logistics Co.', ein: '61-7781203', employeeCount: 540, effectiveDate: '2026-11-15' }, 'tidewater.example', 'Owen Park'), 'default', { edit: ['welcome-email'] }],
    [plan({ sponsorName: 'Orchard Lane Schools', ein: '30-9916284', employeeCount: 410, planType: '403B', effectiveDate: '2026-12-01' }, 'orchardlane.example', 'Grace Liu'), 'default', { ai: ['welcome-email'] }],
    [plan({ sponsorName: 'Quill & Ink Publishing', ein: '27-5530918', employeeCount: 85, effectiveDate: '2026-12-01' }, 'quillink.example', 'Theo Marsh'), 'acme-premium', { edit: ['welcome-email'] }],
    [plan({ sponsorName: 'Solstice Solar Installers', ein: '88-2017745', employeeCount: 160, effectiveDate: '2026-12-15' }, 'solstice.example', 'Ana Ruiz'), 'default', { ai: ['welcome-email'], edit: [] }],
  ];
  for (const [details, clientId, style] of completed) {
    const c = await intake({ caseType: 'INSTALLATION', channel: 'DIGITAL', clientId, data: { details } });
    await run(c.id, style);
    installed[details.sponsorName] = c.planId;
    tick(6, 20);
  }

  // A paper-form installation, also completed.
  const paper = await intake(
    {
      caseType: 'INSTALLATION',
      channel: 'PAPER',
      documentText: [
        'Sponsor Name: Bluebird Bakery LLC',
        'EIN: 98-7654321',
        'Employees: 1,200',
        'Plan Type: 401(k)',
        'Effective Date: 2026-12-01',
        'Plan Assets: $41,500,000',
        'Plan Administrator: Rosa Bianchi <rosa@bluebird.example>',
        'Payroll: Payroll Team <payroll@bluebird.example>',
        'Trustee: Sam Hart <sam.hart@bluebird.example>',
        'Fund: FXAIX | Fidelity 500 Index',
        'Fund: FXNAX | Fidelity U.S. Bond Index',
        'Fund: FDEWX | Fidelity Freedom 2055 | QDIA',
      ].join('\n'),
    },
    'mailroom',
  );
  await run(paper.id, { edit: ['welcome-email'] });
  installed['Bluebird Bakery LLC'] = paper.planId;

  // ---- Maintenance history
  const fees = await intake({ caseType: 'MAINTENANCE_FEES', channel: 'MANUAL', planId: installed['Northwind Analytics Inc.'], data: { fees: { recordkeepingBps: 6, perParticipantUsd: 36, terminationBaseUsd: 2500 } } }, 'u_marcus');
  await run(fees.id);
  const contact = await intake({ caseType: 'MAINTENANCE_CONTACT', channel: 'DIGITAL', planId: installed['Bluebird Bakery LLC'], data: { contact: { role: 'PAYROLL', name: 'Luca Romano', email: 'luca.romano@bluebird.example' } } });
  await run(contact.id);

  // ---- Work in progress (what people see in their inboxes today)
  if (clock.now().getTime() > Date.now()) throw new Error('Demo history ran past the current time; start the clock earlier');
  clock.goLive();

  // Termination: Tidewater is leaving. Fees awaiting Dana; blackout notice is tight.
  const term = await intake({
    caseType: 'TERMINATION',
    channel: 'DIGITAL',
    planId: installed['Tidewater Logistics Co.'],
    data: { reason: 'Parent company consolidating plans', successorProvider: 'Keystone Retirement Services', effectiveDate: '2027-01-31', blackoutStart: '2026-12-01', blackoutEnd: '2027-02-14' },
  });
  await run(term.id, { stopAt: ['calculate-fees', 'blackout-notice'] });

  // Fund change at Cedar Ridge: investment review waiting on Sam.
  await intake({
    caseType: 'MAINTENANCE_FUNDS',
    channel: 'DIGITAL',
    planId: installed['Cedar Ridge Health Partners'],
    data: { effectiveDate: '2027-01-15', funds: [FIDELITY.sp500, FIDELITY.bond, { ticker: 'FTIHX', name: 'Fidelity Total International Index' }, FIDELITY.freedom2055] },
  });

  // Suspicious contact change at Orchard Lane: verification waiting on Elena.
  await intake({
    caseType: 'MAINTENANCE_CONTACT',
    channel: 'DIGITAL',
    planId: installed['Orchard Lane Schools'],
    data: { contact: { role: 'PLAN_ADMINISTRATOR', name: 'G. Liu', email: 'grace.liu.benefits@freemail.example' } },
  });

  // New installation mid-flight: fee disclosure waiting on Elena, welcome email waiting on Priya.
  const summit = await intake({
    caseType: 'INSTALLATION',
    channel: 'DIGITAL',
    data: { details: plan({ sponsorName: 'Summit Peak Outfitters', ein: '74-3302918', employeeCount: 210, effectiveDate: '2026-12-15' }, 'summitpeak.example', 'Rachel Whitfield') },
  });
  await run(summit.id, { stopAt: ['fee-disclosure', 'welcome-email'] });

  // Installation with bad data: validation exception routed to Priya.
  await intake({
    caseType: 'INSTALLATION',
    channel: 'MANUAL',
    data: {
      details: plan(
        { sponsorName: 'Lumen Dental Group', ein: '4590-1182', employeeCount: 64, funds: [VANGUARD.sp500, VANGUARD.bond, VANGUARD.td2060, { ticker: 'VTTHX', name: 'Vanguard Target Retirement 2035', qdia: true }] },
        'lumendental.example',
        'Iris Chen',
      ),
    },
  }, 'u_marcus');

  // Installation whose lineup includes a fund the catalog reports as closed:
  // the integration step succeeds, the availability rules stop it for Sam.
  await intake({
    caseType: 'INSTALLATION',
    channel: 'DIGITAL',
    data: {
      details: plan(
        { sponsorName: 'Pinecrest Veterinary Clinics', ein: '56-2093318', employeeCount: 140, funds: [VANGUARD.sp500, VANGUARD.bond, { ticker: 'XCLSX', name: 'Example Closed Growth Fund' }, VANGUARD.td2060] },
        'pinecrestvet.example',
        'Noah Brandt',
      ),
    },
  });

  // Per-plan access (set by Priya, an admin): a sponsor that asked for a named
  // service team, and a conflict of interest.
  app.cases.setPlanAccess(installed['Cedar Ridge Health Partners'], { allow: ['u_priya', 'u_elena', 'u_sam', 'u_dana'], note: 'Sponsor contract requires a named service team (fictional example).' }, 'u_priya');
  app.cases.setPlanAccess(installed['Tidewater Logistics Co.'], { deny: ['u_marcus'], note: "Conflict of interest: a close relative works in the sponsor's HR team (fictional example)." }, 'u_priya');

  // Pre-generate Claude panels for a few open tasks so they show immediately.
  for (const t of app.repos.tasks.find((t) => (t.status === 'READY' || t.status === 'IN_PROGRESS') && !!t.assigneeId)) {
    if (['fee-disclosure', 'calculate-fees', 'verify-authority', 'validate-intake', 'review-lineup'].includes(t.stepId)) await app.ai.assist(t.id, t.assigneeId!);
  }
  return { cases: app.repos.cases.all().length };
}
