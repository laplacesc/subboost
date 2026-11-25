// Fork extension: starts the GitHub OAuth web flow.
import { NextResponse } from "next/server";
import { isSetupRequired } from "@local/lib/auth";
import { getGithubOAuthConfig } from "@local/lib/github-oauth-config";
import { GITHUB_OAUTH_STATE_COOKIE, githubLoginFailureUrl, githubStateCookieOptions, startGithubOAuth } from "@local/lib/github-oauth";
import { consumeLocalRateLimit, getTrustedClientRateLimitKey, localRateLimitResponse } from "@local/lib/rate-limit";

export async function GET(request: Request) {
  const config = getGithubOAuthConfig();
  if (!config || (await isSetupRequired())) {
    return NextResponse.redirect(githubLoginFailureUrl(), 303);
  }

  const clientKey = getTrustedClientRateLimitKey(request);
  if (clientKey) {
    const limit = consumeLocalRateLimit("auth-github-start", clientKey, { limit: 30, windowMs: 15 * 60 * 1000 });
    if (!limit.allowed) return localRateLimitResponse("Too many login attempts. Try again later.", limit.retryAfterSeconds);
  }

  const returnTo = new URL(request.url).searchParams.get("returnTo");
  const { authorizeUrl, stateCookie } = await startGithubOAuth(config, returnTo);
  const response = NextResponse.redirect(authorizeUrl, 303);
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, stateCookie, githubStateCookieOptions());
  return response;
}
