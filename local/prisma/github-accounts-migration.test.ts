import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

// Needs a PostgreSQL server where the user may CREATE DATABASE, e.g.
// MIGRATION_TEST_DATABASE_URL=postgresql://sb:sb@localhost:55432/postgres
const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL?.trim();
const migrationsDir = path.join(__dirname, "migrations");
const TARGET = "20261124090000_github_accounts";

function migrationSql(name: string): string {
  return readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
}

const priorMigrations = readdirSync(migrationsDir)
  .filter((name) => /^\d+_/.test(name) && name < TARGET)
  .sort();

const created: string[] = [];

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabaseAtPriorSchema(): Promise<Client> {
  const name = `mig_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name}`));
  created.push(name);
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  for (const migration of priorMigrations) await client.query(migrationSql(migration));
  return client;
}

describe.skipIf(!adminUrl)("github accounts migration", () => {
  afterAll(async () => {
    await withAdmin(async (admin) => {
      for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    });
  });

  it("backfills the single legacy account as Level 4 and keeps ids, tokens and ownership", async () => {
    const db = await createDatabaseAtPriorSchema();
    try {
      await db.query(`INSERT INTO "LocalAdmin"(id, username, "passwordHash", "updatedAt") VALUES ('adm1', 'root', 'hash', now())`);
      await db.query(
        `INSERT INTO "Subscription"(id, "ownerId", name, token, "encryptedUrls", "encryptedNodes", "encryptedConfig", "updatedAt")
         VALUES ('s1', 'adm1', 'n', 'tok-1', 'a', 'b', 'c', now())`
      );
      await db.query(`INSERT INTO "LocalTemplate"(id, "ownerId", name, "encryptedConfig", "updatedAt") VALUES ('t1', 'adm1', 't', 'c', now())`);

      await db.query(migrationSql(TARGET));

      const admin = await db.query(`SELECT id, username, "accountKind", "accountLevel", "githubId" FROM "LocalAdmin"`);
      expect(admin.rows).toEqual([{ id: "adm1", username: "root", accountKind: "PASSWORD", accountLevel: 4, githubId: null }]);
      expect((await db.query(`SELECT "ownerId", token FROM "Subscription"`)).rows).toEqual([{ ownerId: "adm1", token: "tok-1" }]);
      expect((await db.query(`SELECT "ownerId" FROM "LocalTemplate"`)).rows).toEqual([{ ownerId: "adm1" }]);
    } finally {
      await db.end();
    }
  });

  it("fails instead of picking an administrator when several legacy accounts exist", async () => {
    const db = await createDatabaseAtPriorSchema();
    try {
      await db.query(
        `INSERT INTO "LocalAdmin"(id, username, "passwordHash", "updatedAt") VALUES ('a', 'a', 'h', now()), ('b', 'b', 'h', now())`
      );
      await expect(db.query(migrationSql(TARGET))).rejects.toThrow(/at most one existing LocalAdmin/);
    } finally {
      await db.end();
    }
  });

  describe("constraints", () => {
    const insertGithub = (db: Client, id: string, githubId: string, level: number) =>
      db.query(
        `INSERT INTO "LocalAdmin"(id, "accountKind", "accountLevel", "githubId", "updatedAt") VALUES ($1, 'GITHUB', $2, $3, now())`,
        [id, level, githubId]
      );
    const insertPassword = (db: Client, id: string, username: string, level: number) =>
      db.query(
        `INSERT INTO "LocalAdmin"(id, username, "passwordHash", "accountKind", "accountLevel", "updatedAt") VALUES ($1, $2, 'h', 'PASSWORD', $3, now())`,
        [id, username, level]
      );

    it("enforces unique GitHub ids, a single password administrator and valid kind/level pairs", async () => {
      const db = await createDatabaseAtPriorSchema();
      try {
        await db.query(migrationSql(TARGET));

        await insertGithub(db, "g1", "100", 1);
        await insertGithub(db, "g2", "101", 3);
        await expect(insertGithub(db, "g3", "100", 1)).rejects.toThrow(/duplicate key/);
        await expect(insertGithub(db, "g4", "102", 4)).rejects.toThrow(/LocalAdmin_account_shape_check/);
        await expect(insertGithub(db, "g5", "103", 0)).rejects.toThrow(/LocalAdmin_account_shape_check/);

        await insertPassword(db, "p1", "root", 4);
        await expect(insertPassword(db, "p2", "other", 4)).rejects.toThrow(/duplicate key/);
        await expect(insertPassword(db, "p3", "third", 2)).rejects.toThrow(/LocalAdmin_account_shape_check/);

        await expect(
          db.query(
            `INSERT INTO "LocalAdmin"(id, username, "passwordHash", "githubId", "accountKind", "accountLevel", "updatedAt")
             VALUES ('m1', 'mix', 'h', '200', 'GITHUB', 2, now())`
          )
        ).rejects.toThrow(/LocalAdmin_account_shape_check/);
        await expect(
          db.query(
            `INSERT INTO "LocalAdmin"(id, "accountKind", "accountLevel", "updatedAt") VALUES ('m2', 'OTHER', 1, now())`
          )
        ).rejects.toThrow(/LocalAdmin_account_shape_check/);
      } finally {
        await db.end();
      }
    });
  });
});
