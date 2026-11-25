import { isPasswordAdmin } from "@local/lib/account-identity";
import { toUserQuotaProjection } from "@local/lib/account-quota";
import { getCurrentAdmin, isSetupRequired } from "@local/lib/auth";
import { isGithubLoginEnabled } from "@local/lib/github-oauth-config";
import { json } from "@local/lib/http";
import { prisma } from "@local/lib/prisma";

export async function GET() {
  const [setupRequired, admin] = await Promise.all([isSetupRequired(), getCurrentAdmin()]);
  const [subscriptionCount, templateCount] = admin
    ? await Promise.all([
        prisma.subscription.count({ where: { ownerId: admin.id } }),
        prisma.localTemplate.count({ where: { ownerId: admin.id } }),
      ])
    : [0, 0];
  const now = new Date().toISOString();
  return json({
    setupRequired,
    authenticated: Boolean(admin),
    githubLoginEnabled: !setupRequired && isGithubLoginEnabled(),
    user: admin
      ? {
          id: admin.id,
          username: admin.username ?? admin.githubLogin ?? "",
          name: admin.displayName ?? admin.githubLogin ?? admin.username ?? "",
          avatarUrl: admin.avatarUrl,
          trustLevel: admin.level,
          aiAssistantEnabled: false,
          isAdmin: isPasswordAdmin(admin),
          isBanned: false,
          active: true,
          silenced: false,
          saveRequirementSatisfied: true,
          saveRequirementSatisfiedAt: now,
          createdAt: now,
          updatedAt: now,
          accounts:
            admin.githubId
              ? [{ provider: "github", providerAccountId: admin.githubId, username: admin.githubLogin }]
              : [],
          quota: toUserQuotaProjection(admin.level),
          subscriptionCount,
          templateCount,
        }
      : null,
  });
}
