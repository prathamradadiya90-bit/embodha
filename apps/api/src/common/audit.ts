import type { Db } from '../db/db.module';
import { auditLog } from '../db/schema';

/** One line in the audit log for a staff action. */
export function audit(
  db: Pick<Db, 'insert'>,
  entry: { actorId: string | null; action: string; entityType: string; entityId: string; before?: unknown; after?: unknown },
) {
  return db.insert(auditLog).values({ ...entry, before: entry.before ?? null, after: entry.after ?? null });
}

/** "Meera Krishnan" → "Meera K.": enough to feel human, not enough to find someone. */
export function shortName(name: string | null) {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!parts.length) return 'A member';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export const escapeLike = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);
