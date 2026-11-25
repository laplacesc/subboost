import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildDefaultSubBoostTemplateConfig } from "@subboost/core/config/defaults";

// Needs a PostgreSQL server where the user may CREATE DATABASE, e.g.
// MIGRATION_TEST_DATABASE_URL=postgresql://sb:sb@localhost:55432/postgres
const target = vi.hoisted(() => {
  const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL?.trim();
  const dbName = `quota_${Math.random().toString(36).slice(2, 12)}`;
  if (adminUrl) {
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.toString();
    process.env.ENCRYPTION_KEY = "quota-integration-test-encryption-key";
    process.env.APP_URL = "https://local.subboost.test";
    delete (globalThis as { localPrisma?: unknown }).localPrisma;
  }
  return { adminUrl, dbName, snapshot: vi.fn() };
});

vi.mock("@subboost/server-core/subscription", async (importOriginal) => ({
  ...await importOriginal<typeof import("@subboost/server-core/subscription")>(),
  refreshNodeSnapshot: target.snapshot,
}));

import { QuotaExceededError } from "@local/lib/account-quota";
import { decryptJson, encryptJson } from "@local/lib/crypto";
import { prisma } from "@local/lib/prisma";
import { createSubscription, refreshSubscription, updateSubscription } from "@local/lib/subscription-service";
import { createTemplate } from "@local/lib/template-service";

const migrationsDir = path.join(__dirname, "migrations");

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

let seq = 0;
async function githubAccount(level: 1 | 2 | 3) {
  seq += 1;
  return prisma.localAdmin.create({
    data: { accountKind: "GITHUB", accountLevel: level, githubId: `quota-${seq}`, githubLogin: `quota${seq}` },
  });
}

function snapshotOf(count: number) {
  return {
    nodes: nodes(count, "fresh"), subscriptionInfo: {}, savedSources: [], attemptedUrlFetch: true, usedUrlFetch: true,
    refreshableSourceCount: 1, refreshedSourceCount: 1, refreshedUrlSourceCount: 1, refreshedStaticSourceCount: 0,
    detachedSourceCount: 0, failedSourceCount: 0, failedSources: [],
  };
}

async function storedNodeCount(id: string) {
  const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
  return decryptJson<unknown[]>(row.encryptedNodes, []).length;
}

describe.skipIf(!target.adminUrl)("account quotas on PostgreSQL", () => {
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
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${target.dbName} WITH (FORCE)`));
  });

  it("lets exactly one concurrent request take the last subscription and template slot", async () => {
    const account = await githubAccount(1);
    const subs = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => createSubscription(account.id, { name: `s${index}`, nodes: nodes(1) }))
    );
    const templates = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => createTemplate(account.id, { name: `t${index}`, config: buildDefaultSubBoostTemplateConfig("minimal") }))
    );

    for (const results of [subs, templates]) {
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") expect(result.reason).toBeInstanceOf(QuotaExceededError);
      }
    }
    expect(await prisma.subscription.count({ where: { ownerId: account.id } })).toBe(1);
    expect(await prisma.localTemplate.count({ where: { ownerId: account.id } })).toBe(1);
  });

  it("lets a downgraded account rename and shrink but not grow", async () => {
    const account = await githubAccount(3);
    const created = await createSubscription(account.id, { name: "big", nodes: nodes(500) });
    await prisma.localAdmin.update({ where: { id: account.id }, data: { accountLevel: 1 } });

    await expect(updateSubscription(account.id, created.id, { name: "renamed" })).resolves.toMatchObject({ name: "renamed" });
    await expect(updateSubscription(account.id, created.id, { nodes: nodes(501) })).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(updateSubscription(account.id, created.id, { nodes: nodes(300) })).resolves.toBeTruthy();
    expect(await storedNodeCount(created.id)).toBe(300);
    await expect(createSubscription(account.id, { name: "second", nodes: nodes(1) })).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("keeps the old snapshot when a refresh exceeds the effective limit and saves a shrunk over-limit one", async () => {
    const account = await githubAccount(3);
    const created = await createSubscription(account.id, { name: "refresh", nodes: nodes(500) });
    await prisma.localAdmin.update({ where: { id: account.id }, data: { accountLevel: 1 } });

    target.snapshot.mockResolvedValueOnce(snapshotOf(600));
    const rejected = await refreshSubscription(account.id, created.id);
    expect(rejected).toMatchObject({ ok: false });
    expect(await storedNodeCount(created.id)).toBe(500);

    target.snapshot.mockResolvedValueOnce(snapshotOf(400));
    await expect(refreshSubscription(account.id, created.id)).resolves.toMatchObject({ ok: true });
    expect(await storedNodeCount(created.id)).toBe(400);
  });

  it("does not overwrite a subscription changed or deleted while a refresh was in flight", async () => {
    const account = await githubAccount(1);
    const created = await createSubscription(account.id, { name: "race", nodes: nodes(10) });

    target.snapshot.mockImplementationOnce(async () => {
      await prisma.subscription.update({ where: { id: created.id }, data: { encryptedNodes: encryptJson(nodes(3)) } });
      return snapshotOf(20);
    });
    await expect(refreshSubscription(account.id, created.id)).resolves.toMatchObject({ ok: false, response: { status: 409 } });
    expect(await storedNodeCount(created.id)).toBe(3);

    target.snapshot.mockImplementationOnce(async () => {
      await prisma.localAdmin.delete({ where: { id: account.id } });
      return snapshotOf(20);
    });
    await expect(refreshSubscription(account.id, created.id)).resolves.toMatchObject({ ok: false, response: { status: 409 } });
    expect(await prisma.subscription.count({ where: { id: created.id } })).toBe(0);
  });
});
