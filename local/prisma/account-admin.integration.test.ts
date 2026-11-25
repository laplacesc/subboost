import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultSubBoostTemplateConfig } from "@subboost/core/config/defaults";
import type * as ServerSubscriptionModule from "@subboost/server-core/subscription";

// Needs a PostgreSQL server where the user may CREATE DATABASE, e.g.
// MIGRATION_TEST_DATABASE_URL=postgresql://sb:sb@localhost:55432/postgres
const target = vi.hoisted(() => {
  const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL?.trim();
  const dbName = `admin_${Math.random().toString(36).slice(2, 12)}`;
  if (adminUrl) {
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.toString();
    process.env.ENCRYPTION_KEY = "admin-integration-test-encryption-key";
    process.env.APP_URL = "https://local.subboost.test";
    Reflect.deleteProperty(globalThis, "localPrisma");
  }
  return { adminUrl, dbName, snapshot: vi.fn(), readSession: vi.fn() };
});

vi.mock("@subboost/server-core/subscription", async (importOriginal) => ({
  ...(await importOriginal<typeof ServerSubscriptionModule>()),
  refreshNodeSnapshot: target.snapshot,
}));

vi.mock("@local/lib/session", () => ({ readSession: target.readSession }));

import { deleteGithubAccount, listAdminAccounts, setGithubAccountLevel } from "@local/lib/account-admin";
import { getCurrentAdmin } from "@local/lib/auth";
import { runLocalSubscriptionAutoUpdateCron } from "@local/lib/auto-update-service";
import { decryptJson } from "@local/lib/crypto";
import { upsertGithubAccount } from "@local/lib/github-oauth";
import { prisma } from "@local/lib/prisma";
import { createSubscription, generateSubscriptionYaml } from "@local/lib/subscription-service";
import { createTemplate } from "@local/lib/template-service";

const migrationsDir = path.join(__dirname, "migrations");
const FAR_FUTURE = new Date("2100-01-01T00:00:00.000Z");

async function withAdmin(fn: (client: Client) => Promise<unknown>): Promise<void> {
  const client = new Client({ connectionString: target.adminUrl });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

function nodes(count: number, prefix = "n") {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${index}`, type: "trojan", server: "example.com", port: 443, password: "secret",
  }));
}

function snapshotOf(count: number) {
  return {
    nodes: nodes(count, "fresh"), subscriptionInfo: {}, savedSources: [], attemptedUrlFetch: true, usedUrlFetch: true,
    refreshableSourceCount: 1, refreshedSourceCount: 1, refreshedUrlSourceCount: 1, refreshedStaticSourceCount: 0,
    detachedSourceCount: 0, failedSourceCount: 0, failedSources: [],
  };
}

let seq = 0;
function githubProfile() {
  seq += 1;
  return { id: `${9000 + seq}`, login: `member${seq}`, name: `Member ${seq}`, avatarUrl: null };
}

/** A GitHub account with an auto-updating subscription (with refresh state) and a custom template. */
async function seedGithubAccount() {
  const profile = githubProfile();
  const account = await upsertGithubAccount(profile);
  const subscription = await createSubscription(account.id, { name: `sub-${profile.login}`, nodes: nodes(2) });
  await prisma.subscription.update({ where: { id: subscription.id }, data: { autoUpdateInterval: 3600 } });
  await prisma.subscriptionAutoUpdateState.create({ data: { subscriptionId: subscription.id, externalFailureCount: 1 } });
  await createTemplate(account.id, { name: `tpl-${profile.login}`, config: buildDefaultSubBoostTemplateConfig("minimal") });
  const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
  return { profile, account, subscriptionId: subscription.id, token: row.token };
}

async function ownedCounts(ownerId: string) {
  const [subscriptions, templates, autoUpdateStates] = await Promise.all([
    prisma.subscription.count({ where: { ownerId } }),
    prisma.localTemplate.count({ where: { ownerId } }),
    prisma.subscriptionAutoUpdateState.count({ where: { subscription: { ownerId } } }),
  ]);
  return { subscriptions, templates, autoUpdateStates };
}

describe.skipIf(!target.adminUrl)("account administration on PostgreSQL", () => {
  let passwordAdminId = "";

  beforeAll(async () => {
    await withAdmin((admin) => admin.query(`CREATE DATABASE ${target.dbName}`));
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      for (const name of readdirSync(migrationsDir).filter((entry) => /^\d+_/.test(entry)).sort()) {
        await db.query(readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
      }
    } finally {
      await db.end();
    }
    const admin = await prisma.localAdmin.create({
      data: { accountKind: "PASSWORD", accountLevel: 4, username: "admin", passwordHash: "hash" },
    });
    passwordAdminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${target.dbName} WITH (FORCE)`));
  });

  beforeEach(async () => {
    target.snapshot.mockReset();
    target.readSession.mockReset();
    // Each test's cron run should only see the subscriptions it seeds.
    await prisma.subscription.updateMany({ data: { autoUpdateInterval: null } });
  });

  it("changes GitHub levels in place and never touches the password administrator", async () => {
    const { account, subscriptionId } = await seedGithubAccount();

    await expect(setGithubAccountLevel(account.id, 3)).resolves.toMatchObject({ status: "ok", value: { level: 3 } });
    target.readSession.mockResolvedValue({ adminId: account.id, username: "x" });
    await expect(getCurrentAdmin()).resolves.toMatchObject({ id: account.id, level: 3 });
    expect(await prisma.subscription.count({ where: { id: subscriptionId } })).toBe(1);

    await expect(setGithubAccountLevel(passwordAdminId, 3)).resolves.toEqual({ status: "protected" });
    await expect(deleteGithubAccount(passwordAdminId)).resolves.toEqual({ status: "protected" });
    await expect(prisma.localAdmin.findUniqueOrThrow({ where: { id: passwordAdminId } })).resolves.toMatchObject({
      accountKind: "PASSWORD",
      accountLevel: 4,
    });
    await expect(setGithubAccountLevel("missing", 2)).resolves.toEqual({ status: "not_found" });
    await expect(deleteGithubAccount("missing")).resolves.toEqual({ status: "not_found" });
  });

  it("lists the password administrator first without credentials", async () => {
    const accounts = await listAdminAccounts();

    expect(accounts[0]).toMatchObject({ id: passwordAdminId, kind: "PASSWORD", level: 4, loginIdentifier: "admin" });
    expect(JSON.stringify(accounts)).not.toContain("passwordHash");
    expect(JSON.stringify(accounts)).not.toContain('"hash"');
  });

  it("deletes a GitHub account with its data, sessions and links, leaving other accounts intact", async () => {
    const victim = await seedGithubAccount();
    const other = await seedGithubAccount();
    await expect(generateSubscriptionYaml(victim.token)).resolves.not.toBeNull();

    await expect(deleteGithubAccount(victim.account.id)).resolves.toEqual({ status: "ok", value: null });

    expect(await prisma.localAdmin.count({ where: { id: victim.account.id } })).toBe(0);
    expect(await ownedCounts(victim.account.id)).toEqual({ subscriptions: 0, templates: 0, autoUpdateStates: 0 });
    expect(await prisma.subscriptionAutoUpdateState.count({ where: { subscriptionId: victim.subscriptionId } })).toBe(0);
    target.readSession.mockResolvedValue({ adminId: victim.account.id, username: `github:${victim.profile.id}` });
    await expect(getCurrentAdmin()).resolves.toBeNull();
    await expect(generateSubscriptionYaml(victim.token)).resolves.toBeNull();

    expect(await ownedCounts(other.account.id)).toEqual({ subscriptions: 1, templates: 1, autoUpdateStates: 1 });
    await expect(generateSubscriptionYaml(other.token)).resolves.not.toBeNull();
    target.readSession.mockResolvedValue({ adminId: other.account.id, username: "x" });
    await expect(getCurrentAdmin()).resolves.toMatchObject({ id: other.account.id });

    // Only the surviving account's subscription is still picked by the cron.
    target.snapshot.mockResolvedValue(snapshotOf(3));
    await runLocalSubscriptionAutoUpdateCron(FAR_FUTURE);
    expect(target.snapshot).toHaveBeenCalledTimes(1);
    const otherRow = await prisma.subscription.findUniqueOrThrow({ where: { id: other.subscriptionId } });
    expect(decryptJson<unknown[]>(otherRow.encryptedNodes, [])).toHaveLength(3);
  });

  it("does not resurrect data when the account is deleted during an in-flight automatic refresh", async () => {
    const victim = await seedGithubAccount();
    target.snapshot.mockImplementationOnce(async () => {
      await expect(deleteGithubAccount(victim.account.id)).resolves.toMatchObject({ status: "ok" });
      return snapshotOf(5);
    });

    await runLocalSubscriptionAutoUpdateCron(FAR_FUTURE);

    expect(target.snapshot).toHaveBeenCalledTimes(1);
    expect(await prisma.localAdmin.count({ where: { id: victim.account.id } })).toBe(0);
    expect(await ownedCounts(victim.account.id)).toEqual({ subscriptions: 0, templates: 0, autoUpdateStates: 0 });
    expect(await prisma.subscription.count({ where: { id: victim.subscriptionId } })).toBe(0);
  });

  it("gives the same GitHub ID a fresh Level 1 account after deletion", async () => {
    const victim = await seedGithubAccount();
    await setGithubAccountLevel(victim.account.id, 3);
    await deleteGithubAccount(victim.account.id);

    const again = await upsertGithubAccount(victim.profile);

    expect(again.id).not.toBe(victim.account.id);
    expect(again).toMatchObject({ kind: "GITHUB", level: 1, githubId: victim.profile.id });
    expect(await ownedCounts(again.id)).toEqual({ subscriptions: 0, templates: 0, autoUpdateStates: 0 });
    await expect(generateSubscriptionYaml(victim.token)).resolves.toBeNull();
    target.readSession.mockResolvedValue({ adminId: victim.account.id, username: `github:${victim.profile.id}` });
    await expect(getCurrentAdmin()).resolves.toBeNull();
  });
});
