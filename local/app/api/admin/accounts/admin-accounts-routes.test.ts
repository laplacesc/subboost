import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const localAdmin = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const tx = { $queryRaw: vi.fn(), localAdmin };
  return {
    getCurrentAdmin: vi.fn(),
    tx,
    prisma: {
      localAdmin,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock("@local/lib/auth", () => ({ getCurrentAdmin: mocks.getCurrentAdmin }));
vi.mock("@local/lib/prisma", () => ({ prisma: mocks.prisma }));

import { GET } from "./route";
import { DELETE, PATCH } from "./[id]/route";

const APP_ORIGIN = "https://local.subboost.test";
const PASSWORD_ADMIN = { id: "admin-1", username: "admin", kind: "PASSWORD", level: 4 };
const createdAt = new Date("2026-11-01T00:00:00.000Z");

function row(overrides: Record<string, unknown>) {
  return {
    id: "github-1",
    username: null,
    accountKind: "GITHUB",
    accountLevel: 1,
    githubId: "1001",
    githubLogin: "octo",
    displayName: "Octo Cat",
    avatarUrl: "https://avatars.example/octo",
    createdAt,
    lastLoginAt: null,
    _count: { subscriptions: 2, templates: 1 },
    passwordHash: "$argon2id$secret-hash",
    ...overrides,
  };
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(body: string, origin: string | null = APP_ORIGIN) {
  return new Request(`${APP_ORIGIN}/api/admin/accounts/github-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body,
  });
}

function deleteRequest(origin: string | null = APP_ORIGIN) {
  return new Request(`${APP_ORIGIN}/api/admin/accounts/github-1`, {
    method: "DELETE",
    headers: origin ? { Origin: origin } : {},
  });
}

function expectNoWrites() {
  expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  expect(mocks.prisma.localAdmin.updateMany).not.toHaveBeenCalled();
  expect(mocks.prisma.localAdmin.deleteMany).not.toHaveBeenCalled();
}

describe("admin account routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", `${APP_ORIGIN}/`);
    mocks.getCurrentAdmin.mockResolvedValue(PASSWORD_ADMIN);
    mocks.tx.$queryRaw.mockResolvedValue([{ accountLevel: 1 }]);
  });

  it.each([
    ["anonymous requests", null, 401],
    ["GitHub Level 1 accounts", { id: "github-1", kind: "GITHUB", level: 1 }, 403],
    ["GitHub Level 2 accounts", { id: "github-2", kind: "GITHUB", level: 2 }, 403],
    ["GitHub Level 3 accounts", { id: "github-3", kind: "GITHUB", level: 3 }, 403],
  ])("denies %s without listing or mutating accounts", async (_name, account, status) => {
    mocks.getCurrentAdmin.mockResolvedValue(account);

    expect((await GET()).status).toBe(status);
    expect((await PATCH(patchRequest('{"level":2}'), context("github-1"))).status).toBe(status);
    expect((await DELETE(deleteRequest(), context("github-1"))).status).toBe(status);
    expect(mocks.prisma.localAdmin.findMany).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("lists accounts without password hashes or credentials", async () => {
    mocks.prisma.localAdmin.findMany.mockResolvedValue([
      row({
        id: "admin-1",
        username: "admin",
        accountKind: "PASSWORD",
        accountLevel: 4,
        githubId: null,
        githubLogin: null,
        displayName: null,
        avatarUrl: null,
        _count: { subscriptions: 5, templates: 0 },
      }),
      row({ lastLoginAt: new Date("2026-11-20T08:00:00.000Z") }),
      row({ id: "broken", accountKind: "GITHUB", accountLevel: 4 }),
    ]);

    const response = await GET();
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("secret-hash");
    expect(JSON.parse(text)).toEqual({
      currentAccountId: "admin-1",
      accounts: [
        {
          id: "admin-1",
          kind: "PASSWORD",
          level: 4,
          loginIdentifier: "admin",
          githubId: null,
          displayName: null,
          avatarUrl: null,
          createdAt: createdAt.toISOString(),
          lastLoginAt: null,
          subscriptionCount: 5,
          templateCount: 0,
        },
        {
          id: "github-1",
          kind: "GITHUB",
          level: 1,
          loginIdentifier: "octo",
          githubId: "1001",
          displayName: "Octo Cat",
          avatarUrl: "https://avatars.example/octo",
          createdAt: createdAt.toISOString(),
          lastLoginAt: "2026-11-20T08:00:00.000Z",
          subscriptionCount: 2,
          templateCount: 1,
        },
      ],
    });
    const query = mocks.prisma.localAdmin.findMany.mock.calls[0][0];
    expect(query.select).not.toHaveProperty("passwordHash");
  });

  it.each([
    ["a missing Origin header", null],
    ["another origin", "https://evil.example"],
    ["a different port on the same host", "https://local.subboost.test:8443"],
  ])("rejects mutations with %s before authenticating", async (_name, origin) => {
    for (const response of [
      await PATCH(patchRequest('{"level":2}', origin), context("github-1")),
      await DELETE(deleteRequest(origin), context("github-1")),
    ]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "Cross-origin request rejected.", code: "FORBIDDEN" });
    }
    expect(mocks.getCurrentAdmin).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("changes a GitHub account level under the account lock with a kind-restricted write", async () => {
    mocks.prisma.localAdmin.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.localAdmin.findUnique.mockResolvedValue(row({ accountLevel: 3 }));

    const response = await PATCH(patchRequest('{"level":3}'), context("github-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ account: { id: "github-1", kind: "GITHUB", level: 3 } });
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.tx.$queryRaw.mock.calls[0][0].join("?")).toContain("FOR UPDATE");
    expect(mocks.prisma.localAdmin.updateMany).toHaveBeenCalledWith({
      where: { id: "github-1", accountKind: "GITHUB" },
      data: { accountLevel: 3 },
    });
  });

  it.each([
    ["Level 4", '{"level":4}'],
    ["Level 0", '{"level":0}'],
    ["a non-integer", '{"level":2.5}'],
    ["a numeric string", '{"level":"2"}'],
    ["a missing level", "{}"],
    ["a non-object body", "[2]"],
  ])("rejects %s without writing", async (_name, body) => {
    const response = await PATCH(patchRequest(body), context("github-1"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Level must be the integer 1, 2 or 3.",
      code: "VALIDATION_ERROR",
    });
    expectNoWrites();
  });

  it("rejects malformed JSON", async () => {
    expect((await PATCH(patchRequest("{"), context("github-1"))).status).toBe(400);
    expectNoWrites();
  });

  it("refuses to change or delete the password administrator, including itself", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([{ accountLevel: 4 }]);
    mocks.prisma.localAdmin.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.localAdmin.deleteMany.mockResolvedValue({ count: 0 });

    const patched = await PATCH(patchRequest('{"level":3}'), context("admin-1"));
    const deleted = await DELETE(deleteRequest(), context("admin-1"));

    for (const response of [patched, deleted]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "The password administrator account cannot be changed or deleted.",
        code: "FORBIDDEN",
      });
    }
    expect(mocks.prisma.localAdmin.updateMany).toHaveBeenCalledWith({
      where: { id: "admin-1", accountKind: "GITHUB" },
      data: { accountLevel: 3 },
    });
    expect(mocks.prisma.localAdmin.deleteMany).toHaveBeenCalledWith({ where: { id: "admin-1", accountKind: "GITHUB" } });
  });

  it("returns 404 for unknown accounts", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([]);

    expect((await PATCH(patchRequest('{"level":2}'), context("missing"))).status).toBe(404);
    expect((await DELETE(deleteRequest(), context("missing"))).status).toBe(404);
    expect(mocks.prisma.localAdmin.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.localAdmin.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes a GitHub account with a kind-restricted delete", async () => {
    mocks.prisma.localAdmin.deleteMany.mockResolvedValue({ count: 1 });

    const response = await DELETE(deleteRequest(), context("github-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.localAdmin.deleteMany).toHaveBeenCalledWith({ where: { id: "github-1", accountKind: "GITHUB" } });
  });
});
