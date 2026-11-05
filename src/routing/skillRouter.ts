import type { Task, User } from '../domain/types.ts';
import { canWork } from '../users/roles.ts';

export interface RoutingDecision {
  assigneeId?: string;
  reason: string;
  candidates: { userId: string; level: number; load: number; capacity: number }[];
}

/**
 * Skill-based routing:
 *  1. Eligible = active, has the task's skill at >= minSkillLevel, below capacity.
 *     Skill level decides who MAY take a task, not who gets it.
 *  2. Pick the lowest load ratio (open tasks / capacity) to spread work.
 *  3. Tie-break: whoever was assigned work least recently (round-robin), so equally
 *     loaded people take turns regardless of seniority. Never-assigned users go first.
 *  4. Final tie-break: user id, for determinism.
 *  5. If nobody is eligible the task stays in the skill's unassigned queue and is
 *     re-routed when capacity frees up or new users are imported.
 *
 * `lastAssigned` maps user id -> position of their most recent assignment
 * (higher = more recent). The engine derives it from the audit log.
 */
export function routeTask(
  task: Task,
  users: User[],
  openLoad: Map<string, number>,
  excludeUserIds: string[] = [],
  lastAssigned: Map<string, number> = new Map(),
): RoutingDecision {
  const candidates = users
    .filter((u) => canWork(u) && !excludeUserIds.includes(u.id))
    .map((u) => {
      const grant = u.skills.find((s) => s.skill === task.skill);
      return { user: u, level: grant?.level ?? 0, load: openLoad.get(u.id) ?? 0, last: lastAssigned.get(u.id) ?? -1 };
    })
    .filter((c) => c.level >= Math.max(1, task.minSkillLevel));

  const summary = candidates.map((c) => ({ userId: c.user.id, level: c.level, load: c.load, capacity: c.user.capacity }));
  const available = candidates.filter((c) => c.load < c.user.capacity);

  if (candidates.length === 0) {
    return { reason: `No active user has skill ${task.skill} at level ${task.minSkillLevel}+`, candidates: summary };
  }
  if (available.length === 0) {
    return { reason: `All ${candidates.length} ${task.skill} users are at capacity`, candidates: summary };
  }

  available.sort(
    (a, b) =>
      a.load / a.user.capacity - b.load / b.user.capacity ||
      a.last - b.last ||
      a.user.id.localeCompare(b.user.id),
  );
  const pick = available[0];
  const tied = available.filter((c) => c.load / c.user.capacity === pick.load / pick.user.capacity).length;
  return {
    assigneeId: pick.user.id,
    reason: `${task.skill} L${pick.level}, load ${pick.load}/${pick.user.capacity}${tied > 1 ? `, next in rotation of ${tied}` : ''}`,
    candidates: summary,
  };
}
