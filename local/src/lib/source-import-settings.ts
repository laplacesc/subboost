import { prisma } from "./prisma";
import { ACCOUNT_KIND_PASSWORD, PASSWORD_ADMIN_LEVEL } from "./account-identity";

export async function getAllowUnsafeSubscriptionSources(ownerId: string): Promise<boolean> {
  const admin = await prisma.localAdmin.findUnique({
    where: { id: ownerId, accountKind: ACCOUNT_KIND_PASSWORD, accountLevel: PASSWORD_ADMIN_LEVEL },
    select: { allowUnsafeSubscriptionSources: true },
  });

  return admin?.allowUnsafeSubscriptionSources ?? false;
}
