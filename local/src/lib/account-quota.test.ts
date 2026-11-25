import { describe, expect, it } from "vitest";
import {
  ACCOUNT_QUOTAS,
  QuotaExceededError,
  assertSubscriptionWithinQuota,
  assertWithinQuota,
  subscriptionUsage,
  toUserQuotaProjection,
} from "./account-quota";
import { effectiveNodeLimit } from "./account-quota-store";

const tiers = [
  { level: 1, subscriptions: 1, templates: 1, nodes: 100, sources: 2 },
  { level: 2, subscriptions: 1, templates: 1, nodes: 200, sources: 3 },
  { level: 3, subscriptions: 5, templates: 5, nodes: 1000, sources: 10 },
  { level: 4, subscriptions: 9999, templates: 9999, nodes: 10000, sources: Number.POSITIVE_INFINITY },
] as const;

function sources(type: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `${type}-${index}`, type }));
}

describe.each(tiers)("Level $level quota", (tier) => {
  it("allows each dimension at the limit and rejects one above it", () => {
    for (const [dimension, limit] of [
      ["subscriptions", tier.subscriptions],
      ["templates", tier.templates],
      ["nodesPerSubscription", tier.nodes],
    ] as const) {
      expect(() => assertWithinQuota(dimension, tier.level, limit, 0)).not.toThrow();
      expect(() => assertWithinQuota(dimension, tier.level, limit + 1, 0)).toThrow(QuotaExceededError);
    }
  });

  it("checks import sources per type independently", () => {
    const perType = Number.isFinite(tier.sources) ? tier.sources : 50;
    const config = { sources: [...sources("url", perType), ...sources("yaml", perType), ...sources("nodes", perType)] };
    expect(() => assertSubscriptionWithinQuota(tier.level, subscriptionUsage([], config, []))).not.toThrow();
    if (Number.isFinite(tier.sources)) {
      const over = { sources: [...config.sources, { id: "extra", type: "yaml" }] };
      expect(() => assertSubscriptionWithinQuota(tier.level, subscriptionUsage([], over, []))).toThrow(
        expect.objectContaining({ dimension: "importSourcesPerType", limit: tier.sources })
      );
    }
  });

  it("projects the shared UI quota shape", () => {
    expect(toUserQuotaProjection(tier.level)).toEqual({
      maxSubscriptions: tier.subscriptions,
      maxNodesPerSubscription: tier.nodes,
      maxCustomTemplates: tier.templates,
      maxImportSourcesPerType: Number.isFinite(tier.sources) ? tier.sources : 9999,
      canUseSubscriptionLink: true,
    });
  });
});

describe("downgraded accounts", () => {
  it("keep existing over-limit usage but cannot grow any dimension", () => {
    const stored = subscriptionUsage(Array(500), { sources: sources("url", 6) }, Array(6));

    expect(() => assertSubscriptionWithinQuota(1, stored, stored)).not.toThrow();
    expect(() => assertSubscriptionWithinQuota(1, subscriptionUsage(Array(300), { sources: sources("url", 4) }, Array(4)), stored)).not.toThrow();
    expect(() => assertSubscriptionWithinQuota(1, subscriptionUsage(Array(501), { sources: sources("url", 6) }, Array(6)), stored)).toThrow(
      expect.objectContaining({ dimension: "nodesPerSubscription" })
    );
    expect(() => assertSubscriptionWithinQuota(1, subscriptionUsage(Array(500), { sources: sources("url", 7) }, Array(6)), stored)).toThrow(
      expect.objectContaining({ dimension: "importSourcesPerType" })
    );
    expect(() => assertSubscriptionWithinQuota(1, subscriptionUsage(Array(500), { sources: sources("url", 6) }, Array(7)), stored)).toThrow(
      expect.objectContaining({ dimension: "importSourcesPerType" })
    );
    expect(() => assertSubscriptionWithinQuota(1, subscriptionUsage([], { sources: sources("yaml", 3) }, []), stored)).toThrow(
      expect.objectContaining({ dimension: "importSourcesPerType" })
    );
  });

  it("refresh keeps the larger of stored nodes and the tier, bounded by the hard cap", () => {
    expect(effectiveNodeLimit(1, 40, 10000)).toBe(ACCOUNT_QUOTAS[1].nodesPerSubscription);
    expect(effectiveNodeLimit(1, 700, 10000)).toBe(700);
    expect(effectiveNodeLimit(4, 20000, 10000)).toBe(10000);
  });
});
