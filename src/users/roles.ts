import type { User } from '../domain/types.ts';

/**
 * Roles come from identity-provider groups named `role:<name>`.
 *
 * - `auditor`: read-only. Sees every case, audit trail, rule, integration call and
 *   email, but can change nothing and is never routed work. Read-only wins: an
 *   auditor who also holds `admin` is still read-only, so an audit account can't
 *   be quietly given write access by adding a group.
 * - `admin`: user administration, cancelling cases, reassigning others' tasks,
 *   testing integrations.
 */
export const isAuditor = (u: User | undefined): boolean => !!u?.roles?.includes('auditor');
export const isAdmin = (u: User | undefined): boolean => !!u?.roles?.includes('admin') && !isAuditor(u);
/** Can this user be given tasks? */
export const canWork = (u: User): boolean => u.active && !isAuditor(u);
