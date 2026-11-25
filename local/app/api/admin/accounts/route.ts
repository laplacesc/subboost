import { listAdminAccounts } from "@local/lib/account-admin";
import { withPasswordAdmin } from "@local/lib/api-auth";
import { json } from "@local/lib/http";

export async function GET() {
  return withPasswordAdmin(async (admin) => json({ currentAccountId: admin.id, accounts: await listAdminAccounts() }));
}
