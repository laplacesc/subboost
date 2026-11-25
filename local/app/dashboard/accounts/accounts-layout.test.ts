import { expect, it, vi } from "vitest";

const getCurrentAdmin = vi.hoisted(() => vi.fn());
vi.mock("@local/lib/auth", () => ({ getCurrentAdmin }));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => { throw new Error(`redirect: ${path}`); },
  notFound: (): never => { throw new Error("not found"); },
}));

import AccountsLayout from "./layout";

it("requires login before rendering account management", async () => {
  getCurrentAdmin.mockResolvedValue(null);
  await expect(AccountsLayout({ children: "accounts" })).rejects.toThrow("redirect: /login");
});

it.each([1, 2, 3])("hides the page from GitHub level %s", async (level) => {
  getCurrentAdmin.mockResolvedValue({ kind: "GITHUB", level });
  await expect(AccountsLayout({ children: "accounts" })).rejects.toThrow("not found");
});

it("renders the page for the Level 4 password administrator", async () => {
  getCurrentAdmin.mockResolvedValue({ kind: "PASSWORD", level: 4 });
  await expect(AccountsLayout({ children: "accounts" })).resolves.toBe("accounts");
});
