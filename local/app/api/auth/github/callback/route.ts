// Fork extension: GitHub OAuth callback. Every failure ends on /login without a session.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sessionLabel } from "@local/lib/account-identity";
import { isSetupRequired } from "@local/lib/auth";
import { getAppUrl } from "@local/lib/env";
import { getGithubOAuthConfig } from "@local/lib/github-oauth-config";
import {
  completeGithubOAuth,
  GITHUB_OAUTH_STATE_COOKIE,
  githubLoginFailureUrl,
  GithubOAuthError,
  githubStateCookieOptions,
} from "@local/lib/github-oauth";
import { sessionCookieOptions, signSession, SESSION_COOKIE } from "@local/lib/session";

function failure(): NextResponse {
  const response = NextResponse.redirect(githubLoginFailureUrl(), 303);
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, "", githubStateCookieOptions(0));
  return response;
}

export async function GET(request: Request) {
  const config = getGithubOAuthConfig();
  if (!config || (await isSetupRequired())) return failure();

  const stateCookie = (await cookies()).get(GITHUB_OAUTH_STATE_COOKIE)?.value;
  let result;
  try {
    result = await completeGithubOAuth({ config, url: new URL(request.url), stateCookie });
  } catch (error) {
    if (error instanceof GithubOAuthError) {
      console.warn(error.message);
      return failure();
    }
    throw error;
  }

  const response = NextResponse.redirect(`${getAppUrl()}${result.returnTo}`, 303);
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, "", githubStateCookieOptions(0));
  response.cookies.set(
    SESSION_COOKIE,
    await signSession({ adminId: result.account.id, username: sessionLabel(result.account) }),
    sessionCookieOptions()
  );
  return response;
}
