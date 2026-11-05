import type { CaseType, Channel, Contact, ContactRole, Fund, PlanDetails } from '../domain/types.ts';
import { ValidationError } from '../store/db.ts';

export interface IntakeSubmission {
  caseType: CaseType;
  channel: Channel;
  clientId?: string;
  planId?: string; // required for maintenance / termination
  /** Structured payload (digital portal or manual entry). */
  data?: Record<string, unknown>;
  /** Raw text extracted from a paper form (OCR / IDP output). */
  documentText?: string;
}

export interface NormalizedIntake {
  caseType: CaseType;
  channel: Channel;
  clientId: string;
  planId?: string;
  planDetails?: PlanDetails; // installation only
  request: Record<string, unknown>;
}

const DEFAULT_FEES = { recordkeepingBps: 8, perParticipantUsd: 40, terminationBaseUsd: 2500 };

/**
 * Every channel (paper, digital, manual) is normalized into the same shape here,
 * so nothing downstream cares how the request arrived. Intake only enforces the
 * minimum needed to open a case; full business validation is the first playbook
 * step, so bad data still becomes a visible, routable work item.
 */
export function normalizeIntake(sub: IntakeSubmission): NormalizedIntake {
  const clientId = sub.clientId || 'default';
  let data = sub.data ?? {};
  if (sub.channel === 'PAPER') {
    if (!sub.documentText) throw new ValidationError('Paper intake requires documentText (OCR output)');
    data = sub.caseType === 'INSTALLATION' ? { details: parsePaperInstallation(sub.documentText) } : parseKeyValues(sub.documentText);
  }

  if (sub.caseType === 'INSTALLATION') {
    const d = (data.details ?? data) as Partial<PlanDetails>;
    if (!d.sponsorName) throw new ValidationError('Installation intake requires at least sponsorName');
    const planDetails: PlanDetails = {
      sponsorName: String(d.sponsorName),
      ein: String(d.ein ?? ''),
      employeeCount: Number(d.employeeCount ?? 0),
      planType: (d.planType ?? '401K') as PlanDetails['planType'],
      effectiveDate: String(d.effectiveDate ?? ''),
      planAssetsUsd: d.planAssetsUsd === undefined ? undefined : Number(d.planAssetsUsd),
      contacts: (d.contacts ?? []) as Contact[],
      funds: (d.funds ?? []) as Fund[],
      fees: { ...DEFAULT_FEES, ...(d.fees ?? {}) },
    };
    return { caseType: sub.caseType, channel: sub.channel, clientId, planDetails, request: {} };
  }

  if (!sub.planId) throw new ValidationError(`${sub.caseType} intake requires planId`);
  return { caseType: sub.caseType, channel: sub.channel, clientId, planId: sub.planId, request: { ...data } };
}

/** "Key: value" lines -> object. Stand-in for a real IDP/OCR extraction service. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.+)\s*$/);
    if (m) out[camel(m[1])] = m[2];
  }
  return out;
}

const ROLE_LABELS: Record<string, ContactRole> = {
  'plan administrator': 'PLAN_ADMINISTRATOR',
  payroll: 'PAYROLL',
  trustee: 'TRUSTEE',
  hr: 'HR',
};

/**
 * Parses the text of a paper onboarding form, e.g.
 *   Sponsor Name: Acme Corp
 *   Plan Administrator: Jane Doe <jane@acme.com>
 *   Fund: VFIAX | Vanguard 500 Index Admiral
 *   Fund: VTTSX | Vanguard Target Retirement 2060 | QDIA
 */
export function parsePaperInstallation(text: string): Partial<PlanDetails> {
  const details: Partial<PlanDetails> = { contacts: [], funds: [] };
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.+)\s*$/);
    if (!m) continue;
    const label = m[1].toLowerCase();
    const value = m[2].trim();
    if (ROLE_LABELS[label]) {
      const cm = value.match(/^(.*?)\s*<([^>]+)>/);
      details.contacts!.push({ role: ROLE_LABELS[label], name: cm ? cm[1] : value, email: cm ? cm[2] : '' });
    } else if (label === 'fund') {
      const [ticker, name, flag] = value.split('|').map((s) => s.trim());
      details.funds!.push({ ticker, name: name ?? ticker, qdia: flag?.toUpperCase() === 'QDIA' });
    } else if (label === 'sponsor name') details.sponsorName = value;
    else if (label === 'ein') details.ein = value;
    else if (label === 'employees' || label === 'employee count') details.employeeCount = Number(value.replace(/,/g, ''));
    else if (label === 'plan type') details.planType = value.toUpperCase().replace(/[^0-9A-Z]/g, '') as PlanDetails['planType'];
    else if (label === 'effective date') details.effectiveDate = value;
    else if (label === 'plan assets') details.planAssetsUsd = Number(value.replace(/[$,]/g, ''));
  }
  return details;
}

function camel(s: string): string {
  if (/^[a-zA-Z0-9]+$/.test(s)) return s[0].toLowerCase() + s.slice(1); // already a key, e.g. "effectiveDate"
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}
