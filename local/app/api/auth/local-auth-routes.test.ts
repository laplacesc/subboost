import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalRateLimitsForTests } from "@local/lib/rate-limit";

const mocks = vi.hoisted(() => ({
  bcryptCompare: vi.fn(),
  cleanupExpiredSessionRevocations: vi.fn(async () => 0),
  clearSessionCookieOptions: vi.fn(() => ({ maxAge: 0, path: "/" })),
  getCurrentAdmin: vi.fn(),
  isSetupRequired: vi.fn(),
  prisma: {
    $queryRaw: vi.fn(),
    localAdmin: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    localTemplate: {
      count: vi.fn(),
    },
    subscription: {
      count: vi.fn(),
    },
  },
  sessionCookieOptions: vi.fn(() => ({ httpOnly: true, path: "/" })),
  revokeCurrentSession: vi.fn(async () => true),
  SessionRevocationStoreUnavailableError: class SessionRevocationStoreUnavailableError extends Error {},
  signSession: vi.fn(async () => "signed-session"),
}));

vi.mock("bcryptjs", () => ({
  default: { compare: mocks.bcryptCompare },
}));

vi.mock("@local/lib/auth", () => ({
  getCurrentAdmin: mocks.getCurrentAdmin,
  isSetupRequired: mocks.isSetupRequired,
}));

vi.mock("@local/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@local/lib/session", () => ({
  cleanupExpiredSessionRevocations: mocks.cleanupExpiredSessionRevocations,
  clearSessionCookieOptions: mocks.clearSessionCookieOptions,
  revokeCurrentSession: mocks.revokeCurrentSession,
  SessionRevocationStoreUnavailableError: mocks.SessionRevocationStoreUnavailableError,
  SESSION_COOKIE: "subboost-local-session",
  sessionCookieOptions: mocks.sessionCookieOptions,
  signSession: mocks.signSession,
}));

async function readJson(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe("local auth and health routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalRateLimitsForTests();
  });

  it("logs in a valid local admin and sets the session cookie", async () => {
    const { POST } = await import("./login/route");
    mocks.prisma.localAdmin.findUnique.mockResolvedValueOnce({
      id: "admin-1",
      username: "admin",
      passwordHash: "hash",
      accountKind: "PASSWORD",
      accountLevel: 4,
    });
    mocks.bcryptCompare.mockResolvedValueOnce(true);

    const response = await POST(
      new Request("https://local.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "secret" }),
      })
    );

    expect(await readJson(response)).toEqual({
      status: 200,
      body: { success: true, user: { id: "admin-1", username: "admin" } },
    });
    expect(mocks.prisma.localAdmin.update).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      data: { lastLoginAt: expect.any(Date) },
    });
    expect(mocks.signSession).toHaveBeenCalledWith({ adminId: "admin-1", username: "admin" });
    expect(response.headers.get("set-cookie")).toContain("subboost-local-session=signed-session");
  });

  it("never lets a GitHub or malformed account pass password login", async () => {
    const { POST } = await import("./login/route");
    const attempt = () =>
      POST(
        new Request("https://local.test/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: "admin", password: "secret" }),
        })
      );
    const rows = [
      { id: "g", username: "admin", passwordHash: "hash", accountKind: "GITHUB", accountLevel: 2 },
      { id: "x", username: "admin", passwordHash: "hash", accountKind: "PASSWORD", accountLevel: 2 },
      { id: "y", username: "admin", passwordHash: "hash", accountKind: "", accountLevel: 4 },
      { id: "z", username: "admin", passwordHash: null, accountKind: "PASSWORD", accountLevel: 4 },
    ];
    for (const row of rows) {
      clearLocalRateLimitsForTests();
      mocks.prisma.localAdmin.findUnique.mockResolvedValueOnce(row);
      mocks.bcryptCompare.mockResolvedValue(true);
      expect((await attempt()).status).toBe(401);
    }
    expect(mocks.signSession).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON or invalid credentials", async () => {
    const { POST } = await import("./login/route");

    await expect(readJson(await POST(new Request("https://local.test/api/auth/login", { method: "POST", body: "{" })))).resolves.toEqual({
      status: 400,
      body: { error: "Invalid JSON body.", code: "BAD_REQUEST" },
    });

    mocks.prisma.localAdmin.findUnique.mockResolvedValueOnce(null);
    await expect(
      readJson(
        await POST(
          new Request("https://local.test/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username: "admin", password: "bad" }),
          })
        )
      )
    ).resolves.toEqual({
      status: 401,
      body: { error: "Invalid username or password.", code: "UNAUTHORIZED" },
    });

    await expect(readJson(await POST(new Request("https://local.test/api/auth/login", {
      method: "POST",
      headers: { "content-length": String(64 * 1024 + 1) },
      body: "{}",
    })))).resolves.toEqual({
      status: 413,
      body: { error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("persists logout revocation before clearing the session cookie", async () => {
    const { POST } = await import("./logout/route");

    const response = await POST();

    expect(await readJson(response)).toEqual({ status: 200, body: { success: true } });
    expect(mocks.revokeCurrentSession).toHaveBeenCalledTimes(1);
    expect(response.headers.get("set-cookie")).toContain("subboost-local-session=");
  });

  it("does not clear the cookie or report success when revocation storage fails", async () => {
    const { POST } = await import("./logout/route");
    mocks.revokeCurrentSession.mockRejectedValueOnce(
      new mocks.SessionRevocationStoreUnavailableError("db down")
    );

    const response = await POST();

    expect(await readJson(response)).toEqual({
      status: 503,
      body: { error: "Session service unavailable.", code: "SESSION_STORE_UNAVAILABLE" },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("preserves successful logout when expired-session cleanup fails", async () => {
    const { POST } = await import("./logout/route");
    const cause = new Error("cleanup unavailable");
    mocks.cleanupExpiredSessionRevocations.mockRejectedValueOnce(cause);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST();
      expect(await readJson(response)).toEqual({ status: 200, body: { success: true } });
      expect(response.headers.get("set-cookie")).toContain("subboost-local-session=");
      expect(log).toHaveBeenCalledWith("Local session revocation cleanup failed:", cause);
    } finally {
      log.mockRestore();
    }
  });

  it("propagates unexpected revocation errors without clearing the cookie", async () => {
    const { POST } = await import("./logout/route");
    const cause = new Error("unexpected failure");
    mocks.revokeCurrentSession.mockRejectedValueOnce(cause);
    await expect(POST()).rejects.toBe(cause);
    expect(mocks.clearSessionCookieOptions).not.toHaveBeenCalled();
    expect(mocks.cleanupExpiredSessionRevocations).not.toHaveBeenCalled();
  });

  it("returns the current admin snapshot and anonymous setup state", async () => {
    const { GET } = await import("./me/route");
    mocks.isSetupRequired.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.getCurrentAdmin
      .mockResolvedValueOnce({ id: "admin-1", username: "admin", kind: "PASSWORD", level: 4, githubId: null, githubLogin: null, displayName: null, avatarUrl: null })
      .mockResolvedValueOnce({ id: "gh-1", username: null, kind: "GITHUB", level: 2, githubId: "100", githubLogin: "octo", displayName: "Octo", avatarUrl: "https://a/x.png" })
      .mockResolvedValueOnce(null);
    mocks.prisma.subscription.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    mocks.prisma.localTemplate.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    let response = await GET();
    let payload = await response.json();
    expect(payload).toMatchObject({
      setupRequired: false,
      authenticated: true,
      user: {
        id: "admin-1",
        username: "admin",
        trustLevel: 4,
        isAdmin: true,
        accounts: [],
        subscriptionCount: 2,
        templateCount: 3,
        quota: { maxSubscriptions: 9999, maxNodesPerSubscription: 10000, maxCustomTemplates: 9999, maxImportSourcesPerType: 9999 },
      },
    });
    expect(mocks.prisma.subscription.count).toHaveBeenLastCalledWith({ where: { ownerId: "admin-1" } });

    response = await GET();
    payload = await response.json();
    expect(payload).toMatchObject({
      user: {
        id: "gh-1",
        username: "octo",
        name: "Octo",
        avatarUrl: "https://a/x.png",
        trustLevel: 2,
        isAdmin: false,
        accounts: [{ provider: "github", providerAccountId: "100", username: "octo" }],
        subscriptionCount: 0,
        templateCount: 1,
        quota: { maxSubscriptions: 1, maxNodesPerSubscription: 200, maxCustomTemplates: 1, maxImportSourcesPerType: 3 },
      },
    });
    expect(mocks.prisma.subscription.count).toHaveBeenLastCalledWith({ where: { ownerId: "gh-1" } });

    response = await GET();
    payload = await response.json();
    expect(payload).toEqual({ setupRequired: true, authenticated: false, githubLoginEnabled: false, user: null });
  });

  it("reports live and ready health states", async () => {
    const live = await import("../health/live/route");
    const ready = await import("../health/ready/route");

    await expect(readJson(await live.GET())).resolves.toEqual({
      status: 200,
      body: { ok: true, service: "subboost-local" },
    });

    mocks.prisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]).mockRejectedValueOnce(new Error("db down"));
    await expect(readJson(await ready.GET())).resolves.toEqual({
      status: 200,
      body: { ok: true, database: "ready" },
    });
    await expect(readJson(await ready.GET())).resolves.toEqual({
      status: 503,
      body: { ok: false, database: "unavailable" },
    });
  });
});
