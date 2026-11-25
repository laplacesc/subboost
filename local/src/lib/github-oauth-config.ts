// Fork extension: optional GitHub OAuth App configuration. Login is enabled only
// when both values are set; missing values never affect password login or setup.
import { getAppUrl } from "./env";

export type GithubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};

export function getGithubOAuthConfig(): GithubOAuthConfig | null {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, callbackUrl: `${getAppUrl()}/api/auth/github/callback` };
}

export function isGithubLoginEnabled(): boolean {
  return getGithubOAuthConfig() !== null;
}
