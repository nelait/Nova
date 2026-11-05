import type { Case, Task, User } from '../domain/types.ts';

export interface StepStats {
  caseType: string;
  stepId: string;
  name: string;
  mode: string;
  completed: number;
  avgHandleMinutes: number | null;
  autoFailures: number;
  overrides: number;
  draftEditRate: number | null; // share of executed drafts the user changed
  overdueOpen: number;
}

export interface Suggestion {
  kind: 'promote-to-auto' | 'fix-template' | 'fix-automation' | 'add-capacity' | 'review-sla';
  target: string;
  message: string;
}

export interface Insights {
  generatedAt: string;
  cases: { open: number; completed: number; cancelled: number; avgCycleHours: number | null };
  steps: StepStats[];
  backlogBySkill: Record<string, number>;
  suggestions: Suggestion[];
}

/**
 * The "review and learn" loop. It measures how each playbook step actually performs
 * and SUGGESTS process changes. A process owner decides; playbooks are never
 * changed automatically.
 */
export function computeInsights(cases: Case[], tasks: Task[], users: User[], now: Date, minSample = 5): Insights {
  const nowIso = now.toISOString();
  const caseType = new Map(cases.map((c) => [c.id, c.type]));
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const k = `${caseType.get(t.caseId)}|${t.stepId}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }

  const steps: StepStats[] = [];
  const suggestions: Suggestion[] = [];

  for (const [k, ts] of groups) {
    const [ct, stepId] = k.split('|');
    const done = ts.filter((t) => t.status === 'DONE');
    const handled = done.filter((t) => t.startedAt && t.completedAt);
    const drafts = done.filter((t) => t.draftEdited !== undefined);
    const autoFailures = ts.filter((t) => t.history.some((h) => h.event === 'auto-failed')).length;
    const overrides = ts.filter((t) => t.history.some((h) => h.event === 'overridden')).length;
    const s: StepStats = {
      caseType: ct,
      stepId,
      name: ts[0].name,
      mode: ts[0].mode,
      completed: done.length,
      avgHandleMinutes: handled.length
        ? Math.round(handled.reduce((a, t) => a + (Date.parse(t.completedAt!) - Date.parse(t.startedAt!)), 0) / handled.length / 60_000)
        : null,
      autoFailures,
      overrides,
      draftEditRate: drafts.length ? drafts.filter((t) => t.draftEdited).length / drafts.length : null,
      overdueOpen: ts.filter((t) => (t.status === 'READY' || t.status === 'IN_PROGRESS') && t.dueAt && t.dueAt < nowIso).length,
    };
    steps.push(s);
    const target = `${ct} / ${stepId}`;

    if (s.mode === 'REVIEW' && drafts.length >= minSample && s.draftEditRate === 0) {
      suggestions.push({ kind: 'promote-to-auto', target, message: `All ${drafts.length} drafts were approved unchanged. Consider making this step AUTO (or AUTO for selected clients).` });
    }
    if (drafts.length >= minSample && (s.draftEditRate ?? 0) >= 0.5) {
      suggestions.push({ kind: 'fix-template', target, message: `${Math.round(s.draftEditRate! * 100)}% of drafts were edited before sending. Review the template; users are correcting it by hand.` });
    }
    if (ts.length >= minSample && autoFailures / ts.length >= 0.3) {
      suggestions.push({ kind: 'fix-automation', target, message: `${autoFailures}/${ts.length} automated runs failed and needed a person. Fix the upstream data or the integration.` });
    }
    if (s.overdueOpen > 0) {
      suggestions.push({ kind: 'review-sla', target, message: `${s.overdueOpen} open task(s) are past SLA.` });
    }
  }

  const backlogBySkill: Record<string, number> = {};
  for (const t of tasks.filter((t) => t.status === 'READY' && !t.assigneeId && (t.mode !== 'AUTO' || t.exception))) {
    backlogBySkill[t.skill] = (backlogBySkill[t.skill] ?? 0) + 1;
  }
  for (const [skill, n] of Object.entries(backlogBySkill)) {
    const holders = users.filter((u) => u.active && u.skills.some((s) => s.skill === skill)).length;
    suggestions.push({ kind: 'add-capacity', target: skill, message: `${n} task(s) waiting with no eligible assignee (${holders} active user(s) hold ${skill}). Add capacity or cross-train.` });
  }

  const completed = cases.filter((c) => c.status === 'COMPLETED' && c.completedAt);
  return {
    generatedAt: nowIso,
    cases: {
      open: cases.filter((c) => c.status === 'OPEN').length,
      completed: completed.length,
      cancelled: cases.filter((c) => c.status === 'CANCELLED').length,
      avgCycleHours: completed.length
        ? Math.round((completed.reduce((a, c) => a + (Date.parse(c.completedAt!) - Date.parse(c.createdAt)), 0) / completed.length / 3_600_000) * 10) / 10
        : null,
    },
    steps: steps.sort((a, b) => a.caseType.localeCompare(b.caseType)),
    backlogBySkill,
    suggestions,
  };
}
