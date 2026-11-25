// Fork extension: GitHub OAuth App web flow (state + PKCE S256) on top of the
// existing local session. Nothing from GitHub (code, token, secret) is persisted
// or returned to the browser.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { ACCOUNT_KIND_GITHUB, accountSelect, toCurrentAccount, type CurrentAdmin } from "./account-identity";
import { getAppUrl, isHttpsAppUrl, requireEnv } from "./env";
import type { GithubOAuthConfig } from "./github-oauth-config";
import { prisma } from "./prisma";

export const GITHUB_OAUTH_STATE_COOKIE = "subboost_github_oauth";
const STATE_TTL_SECONDS = 10 * 60;
const STATE_ISSUER = "subboost-local-github-oauth";
const STATE_REVOCATION_PREFIX = "github-oauth-state:";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const DEFAULT_RETURN_PATH = "/dashboard";
const UPSTREAM_TIMEOUT_MS = 10_000;

export type GithubOAuthStart = { authorizeUrl: string; stateCookie: string };

type StatePayload = { state: string; verifier: string; returnTo: string; jti: string; expiresAt: Date };

export type GithubProfile = { id: string; login: string; name: string | null; avatarUrl: string | null };

export class GithubOAuthError extends Error {
  constructor(readonly reason: string) {
    super(`GitHub login failed: ${reason}`);
    this.name = "GithubOAuthError";
  }
}

function stateKey(): Uint8Array {
  return new TextEncoder().encode(`${requireEnv("JWT_SECRET")}:github-oauth-state`);
}

/** Only same-site absolute paths are accepted; anything else falls back to the dashboard. */
export function sanitizeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_RETURN_PATH;
  try {
    const appUrl = new URL(getAppUrl());
    const resolved = new URL(value, appUrl);
    if (resolved.origin !== appUrl.origin) return DEFAULT_RETURN_PATH;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return DEFAULT_RETURN_PATH;
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function startGithubOAuth(config: GithubOAuthConfig, returnTo: string | null): Promise<GithubOAuthStart> {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const stateCookie = await new SignJWT({ state, verifier, returnTo: sanitizeReturnPath(returnTo) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(STATE_ISSUER)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(stateKey());

  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", config.callbackUrl);
  // No scope: public profile only (no repo, email or offline access).
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("allow_signup", "true");
  return { authorizeUrl: authorizeUrl.toString(), stateCookie };
}

async function readStateCookie(cookieValue: string | undefined): Promise<StatePayload> {
  if (!cookieValue) throw new GithubOAuthError("state_missing");
  try {
    const { payload } = await jwtVerify(cookieValue, stateKey(), { algorithms: ["HS256"], issuer: STATE_ISSUER });
    const { state, verifier, returnTo, jti, exp } = payload;
    if (typeof state !== "string" || typeof verifier !== "string" || typeof returnTo !== "string" || !jti || !exp) {
      throw new GithubOAuthError("state_invalid");
    }
    return { state, verifier, returnTo, jti, expiresAt: new Date(exp * 1000) };
  } catch (error) {
    if (error instanceof GithubOAuthError) throw error;
    throw new GithubOAuthError("state_invalid");
  }
}

/** Marks the login attempt as used; a replayed state cookie is rejected. */
async function consumeState(payload: StatePayload): Promise<void> {
  try {
    await prisma.revokedSession.create({
      data: { revocationKey: `${STATE_REVOCATION_PREFIX}${payload.jti}`, expiresAt: payload.expiresAt },
    });
  } catch {
    throw new GithubOAuthError("state_replayed");
  }
}

async function githubFetch(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new GithubOAuthError("upstream_unreachable");
  }
  if (!response.ok) throw new GithubOAuthError(`upstream_status_${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new GithubOAuthError("upstream_invalid_json");
  }
}

async function exchangeCode(config: GithubOAuthConfig, code: string, verifier: string): Promise<string> {
  const body = await githubFetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: verifier,
    }),
  });
  if (body && typeof body === "object" && "access_token" in body && typeof body.access_token === "string" && body.access_token) {
    return body.access_token;
  }
  throw new GithubOAuthError("token_rejected");
}

async function fetchProfile(accessToken: string): Promise<GithubProfile> {
  const body = await githubFetch(GITHUB_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "SubBoost-Local",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!body || typeof body !== "object" || !("id" in body) || !("login" in body)) {
    throw new GithubOAuthError("profile_invalid");
  }
  const { id, login } = body;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof login !== "string" || !login) {
    throw new GithubOAuthError("profile_invalid");
  }
  const name = "name" in body && typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  const avatar = "avatar_url" in body && typeof body.avatar_url === "string" ? body.avatar_url : "";
  return { id: String(id), login, name, avatarUrl: avatar.startsWith("https://") ? avatar : null };
}

/**
 * Creates the account on first login (Level 1) or refreshes profile fields on
 * later logins. Level and binding are never changed here. Concurrent first
 * logins for the same GitHub id converge on one row via the unique index.
 */
export async function upsertGithubAccount(profile: GithubProfile): Promise<CurrentAdmin> {
  const profileData = {
    githubLogin: profile.login,
    displayName: profile.name,
    avatarUrl: profile.avatarUrl,
    lastLoginAt: new Date(),
  };
  const upsert = () =>
    prisma.localAdmin.upsert({
      where: { githubId: profile.id },
      create: { accountKind: ACCOUNT_KIND_GITHUB, accountLevel: 1, githubId: profile.id, ...profileData },
      update: profileData,
      select: accountSelect,
    });
  let row;
  try {
    row = await upsert();
  } catch (error) {
    // A concurrent first login won the insert; the retry takes the update path.
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
    row = await upsert();
  }
  const account = toCurrentAccount(row);
  if (!account || account.kind !== ACCOUNT_KIND_GITHUB) throw new GithubOAuthError("account_invalid");
  return account;
}

/**
 * Validates the callback and returns the signed-in account plus the same-site
 * path to continue to. Throws GithubOAuthError for every rejected callback.
 */
export async function completeGithubOAuth(params: {
  config: GithubOAuthConfig;
  url: URL;
  stateCookie: string | undefined;
}): Promise<{ account: CurrentAdmin; returnTo: string }> {
  const payload = await readStateCookie(params.stateCookie);
  const { searchParams } = params.url;
  if (searchParams.get("error")) throw new GithubOAuthError("authorization_denied");
  const state = searchParams.get("state");
  const code = searchParams.get("code");
  if (!state || state !== payload.state) throw new GithubOAuthError("state_mismatch");
  if (!code) throw new GithubOAuthError("code_missing");
  await consumeState(payload);

  const accessToken = await exchangeCode(params.config, code, payload.verifier);
  const profile = await fetchProfile(accessToken);
  const account = await upsertGithubAccount(profile);
  return { account, returnTo: payload.returnTo };
}

export function githubStateCookieOptions(maxAge = STATE_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isHttpsAppUrl(),
    path: "/api/auth/github",
    maxAge,
  };
}

export function githubLoginFailureUrl(): string {
  return `${getAppUrl()}/login?error=github`;
}
