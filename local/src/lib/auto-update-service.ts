import {
  applyCronUpdateOutcome,
  createCronUpdateAccumulator,
  extractHostsFromSubscriptionUrls,
  finalizeCronUpdateSummary,
  prepareRefreshCacheResult,
  refreshNodeSnapshot,
  recordCronUpdateSkipped,
  resolveAutomaticRefreshCompletionDecision,
  resolveAutoUpdateScheduleState,
  resolveAutomaticRefreshUnexpectedFailureCompletion,
  resolveAutomaticRefreshFailureAnalysis,
  resolveSubscriptionAutoUpdateState,
  type AutomaticRefreshCompletionTarget,
  type CronUpdateOutcome,
  type FinalCronUpdateSummary,
  type RefreshNodeSnapshotResult,
  type SubscriptionAutoUpdateStateFields,
} from "@subboost/server-core/subscription";
import { encryptJson } from "./crypto";
import { prisma } from "./prisma";
import {
  buildSubscriptionCacheExpiry,
  buildSubscriptionFetchCallbacks,
  MAX_NODES_PER_SUBSCRIPTION,
  readSubscriptionSecrets,
  type SubscriptionRow,
} from "./subscription-service";
import { LOCAL_AUTO_UPDATE_MIN_SECONDS } from "./auto-update-policy";
import { JobLeaseLostError } from "./job-lease";
import { effectiveNodeLimit, lockAccountLevel } from "./account-quota-store";
import type { QuotaTx } from "./account-quota-store";

type AutoUpdateSubscriptionRow = SubscriptionRow & {
  owner: {
    username: string | null;
  };
};

type PreparedLocalRefresh = {
  config: Record<string, unknown>;
  requestedHosts: string[];
  snapshot: RefreshNodeSnapshotResult;
  storedNodeCount: number;
  failureState: ReturnType<typeof resolveAutomaticRefreshFailureAnalysis>["failureState"];
  failureReason: string;
};

function toCompletionTarget(subscription: AutoUpdateSubscriptionRow): AutomaticRefreshCompletionTarget {
  return {
    id: subscription.id,
    name: subscription.name,
    userId: subscription.ownerId,
    username: subscription.owner.username,
    autoUpdateInterval: subscription.autoUpdateInterval,
  };
}

async function writeAutoUpdateState(
  tx: QuotaTx,
  subscription: AutoUpdateSubscriptionRow,
  state: SubscriptionAutoUpdateStateFields,
  extraSubscriptionData: Record<string, unknown> = {}
): Promise<boolean> {
  const updated = await tx.subscription.updateMany({
    where: { id: subscription.id, updatedAt: subscription.updatedAt },
    data: { ...extraSubscriptionData, updatedAt: new Date() },
  });
  if (updated.count !== 1) return false;
  await tx.subscriptionAutoUpdateState.upsert({
    where: { subscriptionId: subscription.id },
    create: { subscriptionId: subscription.id, ...state },
    update: state,
  });
  return true;
}

function staleOutcome(requestedHosts: string[]): CronUpdateOutcome {
  return { status: "skipped", requestedHosts, recordHosts: false };
}

async function prepareLocalRefresh(
  subscription: AutoUpdateSubscriptionRow,
  currentAutoUpdateState: SubscriptionAutoUpdateStateFields,
  attemptedAt: Date
): Promise<PreparedLocalRefresh> {
  const secrets = readSubscriptionSecrets(subscription);
  const requestedHosts = extractHostsFromSubscriptionUrls(secrets.urls);
  const snapshot = await refreshNodeSnapshot({
    config: secrets.config,
    urls: secrets.urls,
    storedNodes: secrets.nodes,
    ...buildSubscriptionFetchCallbacks(subscription.ownerId),
  });
  const { failureState, failureReason } = resolveAutomaticRefreshFailureAnalysis({
    currentState: currentAutoUpdateState,
    snapshot,
    failedAt: attemptedAt,
  });
  return {
    config: secrets.config,
    requestedHosts,
    snapshot,
    storedNodeCount: secrets.nodes.length,
    failureState,
    failureReason,
  };
}

async function completeLocalRefresh(params: {
  subscription: AutoUpdateSubscriptionRow;
  currentAutoUpdateState: SubscriptionAutoUpdateStateFields;
  prepared: PreparedLocalRefresh;
  attemptedAt: Date;
  intervalSeconds: number;
  assertLease?: () => Promise<void>;
}): Promise<CronUpdateOutcome> {
  const { subscription, prepared } = params;
  await params.assertLease?.();
  const decision = await prisma.$transaction(async (tx) => {
    const level = await lockAccountLevel(tx, subscription.ownerId);
    if (level === null) return null;
    const cachedAt = new Date();
    const maxNodesPerSubscription = effectiveNodeLimit(level, prepared.storedNodeCount, MAX_NODES_PER_SUBSCRIPTION);
    const refreshResult = prepareRefreshCacheResult({ config: prepared.config, snapshot: prepared.snapshot, maxNodesPerSubscription });
    const next = resolveAutomaticRefreshCompletionDecision({
      target: toCompletionTarget(subscription),
      currentAutoUpdateState: params.currentAutoUpdateState,
      prepared: { ...prepared, refreshResult },
      attemptedAt: params.attemptedAt,
      successAttemptedAt: cachedAt,
      maxNodesPerSubscription,
    });
    if (next.kind === "empty_result") {
      return (await writeAutoUpdateState(tx, subscription, next.attemptedState)) ? next : null;
    }
    const data: Record<string, unknown> = {};
    if (next.nextAutoUpdateState.shouldDisableAutoUpdate) data.autoUpdateInterval = null;
    if (next.kind === "success") {
      data.encryptedNodes = encryptJson(next.refreshResult.cacheEntry.nodes);
      data.encryptedConfig = encryptJson(next.refreshResult.refreshedConfig);
      data.encryptedSubscriptionInfo = encryptJson(next.refreshResult.cacheEntry.subscriptionInfo);
      data.lastUpdatedAt = cachedAt;
      data.cacheExpiresAt = buildSubscriptionCacheExpiry(cachedAt);
    }
    return (await writeAutoUpdateState(tx, subscription, next.nextAutoUpdateState.state, data)) ? next : null;
  });
  if (!decision) return staleOutcome(prepared.requestedHosts);

  if (decision.kind === "node_quota_exceeded") {
    const { state, shouldDisableAutoUpdate } = decision.nextAutoUpdateState;
    console.warn("[local-subscription-cron] node quota exceeded", {
      subscriptionId: subscription.id,
      actualNodeCount: state.lastNodeQuotaActual,
      effectiveNodeLimit: state.lastNodeQuotaLimit,
      nodeQuotaFailureCount: state.nodeQuotaFailureCount,
      autoUpdateDisabled: shouldDisableAutoUpdate,
    });
  } else if (decision.kind === "all_sources_failed" && decision.nextAutoUpdateState.shouldDisableAutoUpdate) {
    console.warn("[local-subscription-cron] auto update disabled", {
      subscriptionId: subscription.id,
      reason: prepared.failureReason,
    });
  } else if (decision.kind === "success") {
    console.info("[local-subscription-cron] updated", {
      subscriptionId: subscription.id,
      nodeCount: decision.refreshResult.nodeCount,
      intervalSeconds: params.intervalSeconds,
      externalFailureCount: decision.nextAutoUpdateState.externalFailureCount,
      autoUpdateDisabled: decision.nextAutoUpdateState.shouldDisableAutoUpdate,
    });
  }
  return decision.outcome;
}

async function recordUnexpectedFailure(params: {
  subscription: AutoUpdateSubscriptionRow;
  requestedHosts: string[];
  error: unknown;
  attemptStartedAt: Date | null;
  currentAutoUpdateState: SubscriptionAutoUpdateStateFields;
  assertLease?: () => Promise<void>;
}): Promise<CronUpdateOutcome> {
  const completion = resolveAutomaticRefreshUnexpectedFailureCompletion({
    target: toCompletionTarget(params.subscription),
    requestedHosts: params.requestedHosts,
    error: params.error,
    attemptStartedAt: params.attemptStartedAt,
    currentAutoUpdateState: params.currentAutoUpdateState,
  });
  if (completion.attemptedState) {
    const attemptedState = completion.attemptedState;
    await params.assertLease?.();
    const persisted = await prisma.$transaction(async (tx) => {
      if (await lockAccountLevel(tx, params.subscription.ownerId) === null) return false;
      return writeAutoUpdateState(tx, params.subscription, attemptedState);
    }).catch((error) => {
      if (error instanceof JobLeaseLostError) throw error;
      return null;
    });
    if (persisted === false) return staleOutcome(params.requestedHosts);
  }

  console.error("[local-subscription-cron] failed", {
    subscriptionId: params.subscription.id,
    message: completion.message,
  });

  return completion.outcome;
}

export async function runLocalSubscriptionAutoUpdateCron(
  now = new Date(),
  options: { assertLease?: () => Promise<void> } = {}
): Promise<FinalCronUpdateSummary> {
  await options.assertLease?.();
  const subscriptions = (await prisma.subscription.findMany({
    where: { autoUpdateInterval: { not: null } },
    include: { owner: { select: { username: true } }, autoUpdateState: true },
  })) as AutoUpdateSubscriptionRow[];

  const accumulator = createCronUpdateAccumulator(subscriptions.length);
  for (const subscription of subscriptions) {
    await options.assertLease?.();
    let requestedHosts: string[] = [];
    let attemptStartedAt: Date | null = null;
    try {
      const currentAutoUpdateState = resolveSubscriptionAutoUpdateState(subscription);
      const intervalSeconds = Math.max(
        Number(subscription.autoUpdateInterval) || 0,
        LOCAL_AUTO_UPDATE_MIN_SECONDS
      );
      const scheduleState = resolveAutoUpdateScheduleState({
        createdAt: subscription.createdAt,
        lastUpdatedAt: subscription.lastUpdatedAt,
        lastAttemptedAt: currentAutoUpdateState.lastAttemptedAt,
        now,
        intervalSeconds,
      });

      if (!scheduleState.due) {
        recordCronUpdateSkipped(accumulator);
        continue;
      }

      attemptStartedAt = new Date();
      const prepared = await prepareLocalRefresh(subscription, currentAutoUpdateState, attemptStartedAt);
      requestedHosts = prepared.requestedHosts;
      const outcome = await completeLocalRefresh({
        subscription,
        currentAutoUpdateState,
        prepared,
        attemptedAt: attemptStartedAt,
        intervalSeconds,
        assertLease: options.assertLease,
      });
      applyCronUpdateOutcome(accumulator, outcome);
    } catch (error) {
      if (error instanceof JobLeaseLostError) throw error;
      applyCronUpdateOutcome(
        accumulator,
        await recordUnexpectedFailure({
          subscription,
          requestedHosts,
          error,
          attemptStartedAt,
          currentAutoUpdateState: resolveSubscriptionAutoUpdateState(subscription),
          assertLease: options.assertLease,
        })
      );
    }
  }

  await options.assertLease?.();
  return finalizeCronUpdateSummary(accumulator, { maxTopHosts: 50, maxTopUsers: 50 });
}
