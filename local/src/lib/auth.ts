import { ACCOUNT_KIND_PASSWORD, accountSelect, toCurrentAccount, type CurrentAdmin } from "./account-identity";
import { prisma } from "./prisma";
import { readSession } from "./session";

export type { CurrentAdmin };

/** The logged-in account of any kind (password administrator or GitHub). */
export async function getCurrentAdmin(): Promise<CurrentAdmin | null> {
  const session = await readSession();
  if (!session) return null;
  const account = await prisma.localAdmin.findUnique({
    where: { id: session.adminId },
    select: accountSelect,
  });
  return toCurrentAccount(account);
}

/** Initial setup is pending until the password administrator exists. */
export async function isSetupRequired(): Promise<boolean> {
  const count = await prisma.localAdmin.count({ where: { accountKind: ACCOUNT_KIND_PASSWORD } });
  return count === 0;
}
