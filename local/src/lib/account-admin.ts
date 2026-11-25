// Fork extension: password-administrator management of GitHub accounts.
// Every write re-restricts the target to accountKind GITHUB in the database
// condition, so the single password administrator can never be changed or deleted.
import {
  ACCOUNT_KIND_GITHUB,
  MAX_GITHUB_ACCOUNT_LEVEL,
  toCurrentAccount,
  type AccountKind,
  type AccountLevel,
} from "./account-identity";
import { lockAccountLevel } from "./account-quota-store";
import { prisma } from "./prisma";

export type GithubAccountLevel = 1 | 2 | 3;

/** Admin-facing account projection; never carries password hashes or session/OAuth credentials. */
export type AdminAccountView = {
  id: string;
  kind: AccountKind;
  level: AccountLevel;
  /** Password username, or the GitHub login (falling back to the numeric GitHub ID). */
  loginIdentifier: string;
  githubId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  subscriptionCount: number;
  templateCount: number;
};

export type AdminAccountMutationResult<T> =
  | { status: "ok"; value: T }
  | { status: "not_found" }
  | { status: "protected" };

const adminAccountSelect = {
  id: true,
  username: true,
  accountKind: true,
  accountLevel: true,
  githubId: true,
  githubLogin: true,
  displayName: true,
  avatarUrl: true,
  createdAt: true,
  lastLoginAt: true,
  _count: { select: { subscriptions: true, templates: true } },
} as const;

type AdminAccountRow = {
  id: string;
  username: string | null;
  accountKind: string;
  accountLevel: number;
  githubId: string | null;
  githubLogin: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  _count: { subscriptions: number; templates: number };
};

function toAdminAccountView(row: AdminAccountRow): AdminAccountView | null {
  const account = toCurrentAccount(row);
  if (!account) return null;
  return {
    id: account.id,
    kind: account.kind,
    level: account.level,
    loginIdentifier: account.username ?? account.githubLogin ?? account.githubId ?? "",
    githubId: account.githubId,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    subscriptionCount: row._count.subscriptions,
    templateCount: row._count.templates,
  };
}

/** The password administrator first, then GitHub accounts by creation time. */
export async function listAdminAccounts(): Promise<AdminAccountView[]> {
  const rows = await prisma.localAdmin.findMany({
    select: adminAccountSelect,
    // "PASSWORD" sorts after "GITHUB", so descending puts the administrator first.
    orderBy: [{ accountKind: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return rows.flatMap((row) => toAdminAccountView(row) ?? []);
}

/** Accepts only the JSON integers 1, 2 or 3 under `level`. */
export function parseGithubAccountLevel(body: unknown): GithubAccountLevel | null {
  if (!body || typeof body !== "object" || !("level" in body)) return null;
  const level = body.level;
  return level === 1 || level === 2 || level === MAX_GITHUB_ACCOUNT_LEVEL ? level : null;
}

/**
 * Changes a GitHub account's level under the same account-row lock that quota
 * checks and refresh commits take, so in-flight capacity decisions see either
 * the old or the new level, never a mix.
 */
export async function setGithubAccountLevel(
  id: string,
  level: GithubAccountLevel
): Promise<AdminAccountMutationResult<AdminAccountView>> {
  return prisma.$transaction(async (tx) => {
    if ((await lockAccountLevel(tx, id)) === null) return { status: "not_found" as const };
    const updated = await tx.localAdmin.updateMany({
      where: { id, accountKind: ACCOUNT_KIND_GITHUB },
      data: { accountLevel: level },
    });
    if (updated.count === 0) return { status: "protected" as const };
    const row = await tx.localAdmin.findUnique({ where: { id }, select: adminAccountSelect });
    const view = row ? toAdminAccountView(row) : null;
    return view ? { status: "ok" as const, value: view } : { status: "not_found" as const };
  });
}

/**
 * Deletes a GitHub account. Subscriptions (with their refresh state) and
 * templates cascade in the database; account settings live on the row itself.
 * Old sessions fail the per-request account lookup and old subscription tokens
 * no longer resolve. Taking the account lock first waits for any refresh commit
 * already holding it, and later commits find the account gone.
 */
export async function deleteGithubAccount(id: string): Promise<AdminAccountMutationResult<null>> {
  return prisma.$transaction(async (tx) => {
    if ((await lockAccountLevel(tx, id)) === null) return { status: "not_found" as const };
    const deleted = await tx.localAdmin.deleteMany({ where: { id, accountKind: ACCOUNT_KIND_GITHUB } });
    return deleted.count === 0 ? { status: "protected" as const } : { status: "ok" as const, value: null };
  });
}
