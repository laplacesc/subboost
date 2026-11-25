import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Needs a PostgreSQL server where the user may CREATE DATABASE, e.g.
// MIGRATION_TEST_DATABASE_URL=postgresql://sb:sb@localhost:55432/postgres
// Runs before imports: the real prisma client connects lazily to a fresh,
// fully migrated database created in beforeAll.
const target = vi.hoisted(() => {
  const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL?.trim();
  const dbName = `conc_${Math.random().toString(36).slice(2, 12)}`;
  if (adminUrl) {
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.toString();
    delete (globalThis as { localPrisma?: unknown }).localPrisma;
  }
  return { adminUrl, dbName };
});

import { upsertGithubAccount } from "@local/lib/github-oauth";
import { prisma } from "@local/lib/prisma";

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

describe.skipIf(!target.adminUrl)("GitHub account upsert on PostgreSQL", () => {
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

  it("creates exactly one Level 1 account for concurrent first logins", async () => {
    const profile = { id: "9001", login: "racer", name: null, avatarUrl: null };
    const accounts = await Promise.all(Array.from({ length: 8 }, () => upsertGithubAccount(profile)));

    expect(new Set(accounts.map((account) => account.id)).size).toBe(1);
    expect(accounts[0]).toMatchObject({ kind: "GITHUB", level: 1, githubId: "9001" });
    expect(await prisma.localAdmin.count({ where: { githubId: "9001" } })).toBe(1);
  });

  it("keeps the account, level and resources when the GitHub login name changes", async () => {
    const first = await upsertGithubAccount({ id: "9002", login: "before", name: "Before", avatarUrl: null });
    await prisma.localAdmin.update({ where: { id: first.id }, data: { accountLevel: 3 } });
    await prisma.localTemplate.create({ data: { ownerId: first.id, name: "t", encryptedConfig: "c" } });

    const again = await upsertGithubAccount({ id: "9002", login: "after", name: null, avatarUrl: null });

    expect(again).toMatchObject({ id: first.id, level: 3, githubLogin: "after" });
    expect(await prisma.localTemplate.count({ where: { ownerId: first.id } })).toBe(1);
  });
});
