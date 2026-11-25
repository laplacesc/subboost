import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const publicRoot = path.resolve(__dirname, "../..");
const envFixture = {
  POSTGRES_PASSWORD: "fixture",
  DATABASE_URL: "postgresql://subboost:fixture@db:5432/subboost?schema=public",
  ENCRYPTION_KEY: "fixture",
  JWT_SECRET: "fixture",
  CRON_SECRET: "fixture",
  APP_URL: "https://subboost.example.com",
};
const oauthFixture = {
  GITHUB_OAUTH_CLIENT_ID: "fixture-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "fixture-client-secret",
};
const hasCompose = spawnSync("docker", ["compose", "version"], { timeout: 5_000 }).status === 0;

describe.skipIf(!hasCompose)("fork source Compose deployment", () => {
  it.each([
    { fork: true, configured: false },
    { fork: true, configured: true },
    { fork: false, configured: true },
  ])("resolves app env with fork override: $fork, OAuth configured: $configured", ({ fork, configured }) => {
    const dir = mkdtempSync(path.join(tmpdir(), "subboost-fork-compose-"));
    try {
      const envFile = path.join(dir, ".env");
      const settings = configured ? { ...envFixture, ...oauthFixture } : envFixture;
      writeFileSync(envFile, Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(""));

      const env = { ...process.env };
      for (const key of [...Object.keys(envFixture), ...Object.keys(oauthFixture)]) delete env[key];
      const result = spawnSync("docker", [
        "compose", "-p", "subboost-fork-test", "--env-file", envFile,
        "-f", "local/docker-compose.yml",
        ...(fork ? ["-f", "local/docker-compose.fork.yml"] : []),
        "config", "--format", "json",
      ], { cwd: publicRoot, env, encoding: "utf8", timeout: 5_000 });
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      const { app, db, cron } = JSON.parse(result.stdout).services;

      expect(app.build.dockerfile).toBe("local/Dockerfile");
      expect(app.image).toBeUndefined();
      expect(app.environment).toMatchObject({
        DATABASE_URL: envFixture.DATABASE_URL,
        APP_URL: envFixture.APP_URL,
      });
      for (const [key, value] of Object.entries(oauthFixture)) {
        expect(app.environment[key]).toBe(fork ? (configured ? value : "") : undefined);
        expect(app.build.args ?? {}).not.toHaveProperty(key);
        expect(db.environment).not.toHaveProperty(key);
        expect(cron.environment).not.toHaveProperty(key);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});