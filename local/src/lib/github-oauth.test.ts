import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const mocks = vi.hoisted(() => ({
  prisma: {
    revokedSession: { create: vi.fn() },
    localAdmin: { upsert: vi.fn() },
  },
}));

vi.mock("@local/lib/prisma", () => ({ prisma: mocks.prisma }));

import {
  completeGithubOAuth,
  GithubOAuthError,
  pkceChallenge,
  sanitizeReturnPath,
  startGithubOAuth,
  upsertGithubAccount,
} from "@local/lib/github-oauth";

const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  callbackUrl: "https://sb.example.test/api/auth/github/callback",
};

const githubRow = {
  id: "acc-1",
  username: null,
  accountKind: "GITHUB",
  accountLevel: 1,
  githubId: "4242",
  githubLogin: "octo",
  displayName: "Octo Cat",
  avatarUrl: "https://avatars.githubusercontent.com/u/4242",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function begin(returnTo: string | null = "/dashboard/settings") {
  const started = await startGithubOAuth(config, returnTo);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  return { ...started, state };
}

function callbackUrl(params: Record<string, string>): URL {
  const url = new URL(config.callbackUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

describe("GitHub OAuth flow", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JWT_SECRET", "test-jwt-secret-for-github-oauth-0001");
    vi.stubEnv("APP_URL", "https://sb.example.test/");
    vi.stubGlobal("fetch", fetchMock);
    mocks.prisma.revokedSession.create.mockResolvedValue({});
    mocks.prisma.localAdmin.upsert.mockResolvedValue(githubRow);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds a public-profile authorize URL with S256 PKCE and the fixed callback", async () => {
    const { authorizeUrl } = await begin();
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has("scope")).toBe(false);
    expect(authorizeUrl).not.toContain(config.clientSecret);
  });

  it("only keeps same-site return paths", () => {
    expect(sanitizeReturnPath("/dashboard/settings?tab=1")).toBe("/dashboard/settings?tab=1");
    expect(sanitizeReturnPath("https://evil.example/x")).toBe("/dashboard");
    expect(sanitizeReturnPath("//evil.example/x")).toBe("/dashboard");
    expect(sanitizeReturnPath("/\\evil.example")).toBe("/dashboard");
    expect(sanitizeReturnPath(null)).toBe("/dashboard");
  });

  it("completes login, sends the PKCE verifier and returns the account", async () => {
    const { stateCookie, state, authorizeUrl } = await begin("https://evil.example/steal");
    const challenge = new URL(authorizeUrl).searchParams.get("code_challenge");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_token", token_type: "bearer" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 4242, login: "octo", name: "Octo Cat", avatar_url: "https://avatars.githubusercontent.com/u/4242" })
      );

    const result = await completeGithubOAuth({ config, url: callbackUrl({ code: "abc", state }), stateCookie });

    expect(result.returnTo).toBe("/dashboard");
    expect(result.account).toMatchObject({ id: "acc-1", kind: "GITHUB", level: 1, githubId: "4242" });
    const tokenBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(pkceChallenge(tokenBody.code_verifier)).toBe(challenge);
    expect(tokenBody.redirect_uri).toBe(config.callbackUrl);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer gho_token");
  });

  it.each([
    ["denied authorization", { error: "access_denied", state: "S" }, true],
    ["missing state cookie", { code: "abc", state: "S" }, false],
    ["mismatched state", { code: "abc", state: "other" }, true],
    ["missing code", { state: "S" }, true],
  ])("rejects %s without contacting GitHub or creating accounts", async (_name, params, withCookie) => {
    const { stateCookie, state } = await begin();
    const query = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === "S" ? state : v]));
    await expect(
      completeGithubOAuth({ config, url: callbackUrl(query), stateCookie: withCookie ? stateCookie : undefined })
    ).rejects.toBeInstanceOf(GithubOAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.prisma.localAdmin.upsert).not.toHaveBeenCalled();
  });

  it("rejects expired and forged state cookies", async () => {
    const key = new TextEncoder().encode("test-jwt-secret-for-github-oauth-0001:github-oauth-state");
    const expired = await new SignJWT({ state: "s", verifier: "v", returnTo: "/dashboard" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("subboost-local-github-oauth")
      .setJti("j1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    const forged = await new SignJWT({ state: "s", verifier: "v", returnTo: "/dashboard" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("subboost-local-github-oauth")
      .setJti("j2")
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("another-secret-another-secret-0001"));

    for (const stateCookie of [expired, forged]) {
      await expect(
        completeGithubOAuth({ config, url: callbackUrl({ code: "abc", state: "s" }), stateCookie })
      ).rejects.toMatchObject({ reason: "state_invalid" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a replayed login attempt", async () => {
    const { stateCookie, state } = await begin();
    mocks.prisma.revokedSession.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(
      completeGithubOAuth({ config, url: callbackUrl({ code: "abc", state }), stateCookie })
    ).rejects.toMatchObject({ reason: "state_replayed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["token endpoint failure", () => [jsonResponse({}, 500)]],
    ["token rejected", () => [jsonResponse({ error: "bad_verification_code" })]],
    ["profile failure", () => [jsonResponse({ access_token: "t" }), jsonResponse({}, 401)]],
    ["profile without numeric id", () => [jsonResponse({ access_token: "t" }), jsonResponse({ id: "x", login: "octo" })]],
  ])("rejects %s without creating accounts", async (_name, responses) => {
    for (const response of responses()) fetchMock.mockResolvedValueOnce(response);
    const { stateCookie, state } = await begin();
    await expect(
      completeGithubOAuth({ config, url: callbackUrl({ code: "abc", state }), stateCookie })
    ).rejects.toBeInstanceOf(GithubOAuthError);
    expect(mocks.prisma.localAdmin.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unreachable GitHub", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const { stateCookie, state } = await begin();
    await expect(
      completeGithubOAuth({ config, url: callbackUrl({ code: "abc", state }), stateCookie })
    ).rejects.toMatchObject({ reason: "upstream_unreachable" });
  });
});

describe("upsertGithubAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const profile = { id: "4242", login: "renamed", name: null, avatarUrl: null };

  it("creates Level 1 accounts and never changes level or binding on later logins", async () => {
    mocks.prisma.localAdmin.upsert.mockResolvedValue({ ...githubRow, accountLevel: 3, githubLogin: "renamed" });
    const account = await upsertGithubAccount(profile);

    expect(account).toMatchObject({ level: 3, githubLogin: "renamed" });
    const args = mocks.prisma.localAdmin.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ githubId: "4242" });
    expect(args.create).toMatchObject({ accountKind: "GITHUB", accountLevel: 1, githubId: "4242" });
    expect(args.update).not.toHaveProperty("accountLevel");
    expect(args.update).not.toHaveProperty("githubId");
    expect(args.update).not.toHaveProperty("accountKind");
  });

  it("retries once when a concurrent first login won the insert", async () => {
    mocks.prisma.localAdmin.upsert
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
      .mockResolvedValueOnce(githubRow);
    await expect(upsertGithubAccount(profile)).resolves.toMatchObject({ id: "acc-1" });
    expect(mocks.prisma.localAdmin.upsert).toHaveBeenCalledTimes(2);
  });

  it("does not swallow other database failures", async () => {
    mocks.prisma.localAdmin.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(upsertGithubAccount(profile)).rejects.toThrow("db down");
    expect(mocks.prisma.localAdmin.upsert).toHaveBeenCalledTimes(1);
  });

  it("refuses a row that is not a GitHub account", async () => {
    mocks.prisma.localAdmin.upsert.mockResolvedValue({
      ...githubRow,
      accountKind: "PASSWORD",
      accountLevel: 4,
      username: "admin",
      githubId: null,
    });
    await expect(upsertGithubAccount(profile)).rejects.toMatchObject({ reason: "account_invalid" });
  });
});
