import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("./prisma", () => ({
  prisma: {
    localAdmin: { findUnique: mocks.findUnique },
  },
}));

import { getAllowUnsafeSubscriptionSources } from "./source-import-settings";

describe("local source import settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("denies the exception to an owner who is not the password administrator", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);

    await expect(getAllowUnsafeSubscriptionSources("github-owner")).resolves.toBe(false);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "github-owner", accountKind: "PASSWORD", accountLevel: 4 },
      select: { allowUnsafeSubscriptionSources: true },
    });
  });

  it("reads the setting only for the administrator's own requests", async () => {
    mocks.findUnique.mockResolvedValueOnce({ allowUnsafeSubscriptionSources: true });

    await expect(getAllowUnsafeSubscriptionSources("admin-owner")).resolves.toBe(true);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "admin-owner", accountKind: "PASSWORD", accountLevel: 4 },
      select: { allowUnsafeSubscriptionSources: true },
    });
  });
});
