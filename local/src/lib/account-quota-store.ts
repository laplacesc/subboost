// Fork extension: database side of account quotas. Capacity changes for one
// account are serialized by locking its LocalAdmin row first (account, then
// resources), so concurrent requests cannot both take the last slot.
import type { Prisma } from "../generated/prisma";
import type { AccountLevel } from "./account-identity";
import { ACCOUNT_QUOTAS } from "./account-quota";

export type QuotaTx = Prisma.TransactionClient;

function toAccountLevel(value: unknown): AccountLevel | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

/** Locks the account row for the rest of the transaction and returns its current level. */
export async function lockAccountLevel(tx: QuotaTx, accountId: string): Promise<AccountLevel | null> {
  const rows = await tx.$queryRaw<Array<{ accountLevel: number }>>`
    SELECT "accountLevel" FROM "LocalAdmin" WHERE id = ${accountId} FOR UPDATE`;
  return toAccountLevel(rows[0]?.accountLevel);
}

export async function requireLockedAccountLevel(tx: QuotaTx, accountId: string): Promise<AccountLevel> {
  const level = await lockAccountLevel(tx, accountId);
  if (level === null) throw new Error("Account not found.");
  return level;
}

/**
 * Node limit handed to the shared refresh pipeline: the tier limit, or the
 * stored snapshot size when a downgraded subscription already holds more, never
 * above the hard per-subscription cap.
 */
export function effectiveNodeLimit(level: AccountLevel, storedNodeCount: number, hardCap: number): number {
  return Math.min(hardCap, Math.max(storedNodeCount, ACCOUNT_QUOTAS[level].nodesPerSubscription));
}
