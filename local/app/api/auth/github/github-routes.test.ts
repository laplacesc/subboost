import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalRateLimitsForTests } from "@local/lib/rate-limit";
import type * as GithubOAuthModule from "@local/lib/github-oauth";

const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  isSetupRequired: vi.fn(async () => false),
  completeGithubOAuth: vi.fn(),
  signSession: vi.fn(async () => "signed-session"),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "subboost_github_oauth" && mocks.cookieValue ? { name, value: mocks.cookieValue } : undefined,
  }),
}));

vi.mock("@local/lib/auth", () => ({ isSetupRequired: mocks.isSetupRequired }));

vi.mock("@local/lib/session", () => ({
  SESSION_COOKIE: "subboost_local_session",
  sessionCookieOptions: () => ({ httpOnly: true, path: "/" }),
  signSession: mocks.signSession,
}));

vi.mock("@local/lib/github-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubOAuthModule>();
  return { ...actual, completeGithubOAuth: mocks.completeGithubOAuth };
});

import { GET as start } from "./route";
import { GET as callback } from "./callback/route";
import { GithubOAuthError } from "@local/lib/github-oauth";

const APP = "https://sb.example.test";

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe("GitHub auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalRateLimitsForTests();
    mocks.cookieValue = undefined;
    mocks.isSetupRequired.mockResolvedValue(false);
    vi.stubEnv("APP_URL", APP);
    vi.stubEnv("JWT_SECRET", "test-jwt-secret-for-github-oauth-0001");
    vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "client-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects to GitHub and sets a short-lived httpOnly state cookie", async () => {
    const response = await start(new Request(`${APP}/api/auth/github?returnTo=/dashboard`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    const cookie = setCookies(response).find((value) => value.startsWith("subboost_github_oauth="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).toMatch(/Path=\/api\/auth\/github/);
    expect(cookie).toMatch(/Secure/i);
  });

  it.each([
    ["missing client secret", () => vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "")],
    ["setup not completed", () => mocks.isSetupRequired.mockResolvedValue(true)],
  ])("does not start GitHub login when %s", async (_name, arrange) => {
    arrange();
    const response = await start(new Request(`${APP}/api/auth/github`));
    expect(response.headers.get("location")).toBe(`${APP}/login?error=github`);
    expect(setCookies(response).some((value) => value.startsWith("subboost_github_oauth="))).toBe(false);
  });

  it("signs a local session and continues to the same-site path on success", async () => {
    mocks.cookieValue = "state-cookie";
    mocks.completeGithubOAuth.mockResolvedValue({
      account: { id: "acc-1", username: null, kind: "GITHUB", level: 1, githubId: "4242" },
      returnTo: "/dashboard/settings",
    });
    const response = await callback(new Request(`${APP}/api/auth/github/callback?code=c&state=s`));

    expect(response.headers.get("location")).toBe(`${APP}/dashboard/settings`);
    expect(mocks.completeGithubOAuth.mock.calls[0][0].stateCookie).toBe("state-cookie");
    expect(mocks.signSession).toHaveBeenCalledWith({ adminId: "acc-1", username: "github:4242" });
    const cookies = setCookies(response);
    expect(cookies.some((value) => value.startsWith("subboost_local_session=signed-session"))).toBe(true);
    expect(cookies.some((value) => /^subboost_github_oauth=;/.test(value))).toBe(true);
  });

  it("sends every rejected callback to the login page without a session", async () => {
    mocks.completeGithubOAuth.mockRejectedValue(new GithubOAuthError("state_mismatch"));
    const response = await callback(new Request(`${APP}/api/auth/github/callback?code=c&state=x`));

    expect(response.headers.get("location")).toBe(`${APP}/login?error=github`);
    expect(mocks.signSession).not.toHaveBeenCalled();
    expect(setCookies(response).some((value) => value.startsWith("subboost_local_session="))).toBe(false);
    expect(await response.text()).not.toContain("client-secret");
  });

  it("refuses callbacks while GitHub login is disabled", async () => {
    vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "");
    const response = await callback(new Request(`${APP}/api/auth/github/callback?code=c&state=s`));
    expect(response.headers.get("location")).toBe(`${APP}/login?error=github`);
    expect(mocks.completeGithubOAuth).not.toHaveBeenCalled();
  });
});
