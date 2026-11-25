// Fork extension: single source of truth for per-level quotas. Server routes and
// services must enforce through this module; /api/auth/me only reports it.

import type { AccountLevel } from "./account-identity";

/** Sentinel for "no limit" in server checks. Shared UI treats >= 9999 as unlimited. */
export const UNLIMITED = Number.POSITIVE_INFINITY;
const UI_UNLIMITED = 9999;

export type QuotaDimension = "subscriptions" | "templates" | "nodesPerSubscription" | "importSourcesPerType";

export type AccountQuota = Record<QuotaDimension, number>;

export const ACCOUNT_QUOTAS: Record<AccountLevel, AccountQuota> = {
  1: { subscriptions: 1, templates: 1, nodesPerSubscription: 100, importSourcesPerType: 2 },
  2: { subscriptions: 1, templates: 1, nodesPerSubscription: 200, importSourcesPerType: 3 },
  3: { subscriptions: 5, templates: 5, nodesPerSubscription: 1000, importSourcesPerType: 10 },
  4: { subscriptions: 9999, templates: 9999, nodesPerSubscription: 10000, importSourcesPerType: UNLIMITED },
};

export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";
  constructor(
    readonly dimension: QuotaDimension,
    readonly actual: number,
    readonly limit: number
  ) {
    super(QUOTA_MESSAGES[dimension](actual, limit));
    this.name = "QuotaExceededError";
  }
}

const QUOTA_MESSAGES: Record<QuotaDimension, (actual: number, limit: number) => string> = {
  subscriptions: (_actual, limit) => `当前账户等级最多可创建 ${limit} 个订阅。`,
  templates: (_actual, limit) => `当前账户等级最多可创建 ${limit} 个自定义模板。`,
  nodesPerSubscription: (actual, limit) => `节点数量 ${actual} 超过当前账户等级的单订阅上限 ${limit}。`,
  importSourcesPerType: (_actual, limit) => `当前账户等级每种导入来源类型最多 ${limit} 个。`,
};

/**
 * A change is allowed when the candidate usage fits the level limit, or does not
 * exceed what the account already holds (so a downgraded account can still
 * rename, delete or shrink existing data without being blocked).
 */
export function isWithinQuota(candidate: number, currentUsage: number, limit: number): boolean {
  return candidate <= Math.max(currentUsage, limit);
}

export function assertWithinQuota(
  dimension: QuotaDimension,
  level: AccountLevel,
  candidate: number,
  currentUsage: number
): void {
  const limit = ACCOUNT_QUOTAS[level][dimension];
  if (!isWithinQuota(candidate, currentUsage, limit)) {
    throw new QuotaExceededError(dimension, candidate, limit);
  }
}

/** Per-source-type usage for a normalized `config.sources` list. */
export function countSourcesByType(sources: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(sources)) return counts;
  for (const source of sources) {
    const key = source && typeof source === "object" && "type" in source && typeof source.type === "string" ? source.type : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Checks every source type independently. `current` is usage of the stored
 * subscription (empty for a new one).
 */
export function assertSourcesWithinQuota(
  level: AccountLevel,
  candidate: Record<string, number>,
  current: Record<string, number> = {}
): void {
  for (const [type, count] of Object.entries(candidate)) {
    assertWithinQuota("importSourcesPerType", level, count, current[type] ?? 0);
  }
}

export type SubscriptionUsage = {
  nodes: number;
  /** Per-type counts of the normalized `config.sources`. */
  sources: Record<string, number>;
  /** Length of the separately stored `urls` list (mirror of url sources, checked on its own). */
  urls: number;
};

const EMPTY_SUBSCRIPTION_USAGE: SubscriptionUsage = { nodes: 0, sources: {}, urls: 0 };

export function subscriptionUsage(nodes: unknown[], config: Record<string, unknown>, urls: unknown[]): SubscriptionUsage {
  return { nodes: nodes.length, sources: countSourcesByType(config.sources), urls: urls.length };
}

/** Every stored representation is checked against the stored usage independently. */
export function assertSubscriptionWithinQuota(
  level: AccountLevel,
  candidate: SubscriptionUsage,
  current: SubscriptionUsage = EMPTY_SUBSCRIPTION_USAGE
): void {
  assertWithinQuota("nodesPerSubscription", level, candidate.nodes, current.nodes);
  assertSourcesWithinQuota(level, candidate.sources, current.sources);
  assertWithinQuota("importSourcesPerType", level, candidate.urls, current.urls);
}

/** Shape expected by the shared UI user model (`quota`). */
export function toUserQuotaProjection(level: AccountLevel) {
  const quota = ACCOUNT_QUOTAS[level];
  return {
    maxSubscriptions: quota.subscriptions,
    maxNodesPerSubscription: quota.nodesPerSubscription,
    maxCustomTemplates: quota.templates,
    maxImportSourcesPerType: quota.importSourcesPerType === UNLIMITED ? UI_UNLIMITED : quota.importSourcesPerType,
    canUseSubscriptionLink: true,
  };
}
