// Fork extension: account kinds and levels. Everything here is derived from the
// database row, never from the session token or request input.

export const ACCOUNT_KIND_PASSWORD = "PASSWORD";
export const ACCOUNT_KIND_GITHUB = "GITHUB";
export const PASSWORD_ADMIN_LEVEL = 4;
export const MAX_GITHUB_ACCOUNT_LEVEL = 3;

export type AccountKind = typeof ACCOUNT_KIND_PASSWORD | typeof ACCOUNT_KIND_GITHUB;
export type AccountLevel = 1 | 2 | 3 | 4;

export const accountSelect = {
  id: true,
  username: true,
  accountKind: true,
  accountLevel: true,
  githubId: true,
  githubLogin: true,
  displayName: true,
  avatarUrl: true,
} as const;

export type AccountRecord = {
  id: string;
  username: string | null;
  accountKind: string;
  accountLevel: number;
  githubId: string | null;
  githubLogin: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type CurrentAdmin = {
  id: string;
  /** Password username; always null for GitHub accounts. */
  username: string | null;
  kind: AccountKind;
  level: AccountLevel;
  githubId: string | null;
  githubLogin: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * Validates the stored kind/level/identifier combination. Anything the database
 * constraints should have prevented (missing or unknown kind, Level 4 GitHub,
 * password account that is not Level 4) yields null, which every caller treats
 * as "not authenticated".
 */
export function toCurrentAccount(row: AccountRecord | null | undefined): CurrentAdmin | null {
  if (!row) return null;
  const level = row.accountLevel;
  if (!Number.isInteger(level)) return null;

  if (row.accountKind === ACCOUNT_KIND_PASSWORD) {
    if (level !== PASSWORD_ADMIN_LEVEL || !row.username || row.githubId) return null;
    return buildAccount(row, ACCOUNT_KIND_PASSWORD, PASSWORD_ADMIN_LEVEL);
  }
  if (row.accountKind === ACCOUNT_KIND_GITHUB) {
    if (level < 1 || level > MAX_GITHUB_ACCOUNT_LEVEL || !row.githubId || row.username) return null;
    return buildAccount(row, ACCOUNT_KIND_GITHUB, level as AccountLevel);
  }
  return null;
}

function buildAccount(row: AccountRecord, kind: AccountKind, level: AccountLevel): CurrentAdmin {
  return {
    id: row.id,
    username: row.username,
    kind,
    level,
    githubId: row.githubId,
    githubLogin: row.githubLogin,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  };
}

export function isPasswordAdmin(account: Pick<CurrentAdmin, "kind" | "level">): boolean {
  return account.kind === ACCOUNT_KIND_PASSWORD && account.level === PASSWORD_ADMIN_LEVEL;
}

/** Value for the session `username` claim, which is informational only. */
export function sessionLabel(account: CurrentAdmin): string {
  return account.username ?? `github:${account.githubId}`;
}
