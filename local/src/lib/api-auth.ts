import { isPasswordAdmin } from "@local/lib/account-identity";
import { getCurrentAdmin, type CurrentAdmin } from "@local/lib/auth";
import { apiError } from "@local/lib/http";

type AdminResponseHandler = (admin: CurrentAdmin) => Response | Promise<Response>;

export function localAdminRequiredResponse(): Response {
  return apiError("Authentication required.", "UNAUTHORIZED", 401);
}

export function localAdministratorRequiredResponse(): Response {
  return apiError("Administrator access required.", "FORBIDDEN", 403);
}

/** The logged-in account of any kind; resources are scoped to its id. */
export async function getOptionalCurrentAdmin(): Promise<CurrentAdmin | null> {
  return getCurrentAdmin();
}

export async function withCurrentAdmin(handler: AdminResponseHandler): Promise<Response> {
  const admin = await getCurrentAdmin();
  if (!admin) return localAdminRequiredResponse();
  return handler(admin);
}

/** Only the password administrator (Level 4) may pass. */
export async function withPasswordAdmin(handler: AdminResponseHandler): Promise<Response> {
  const account = await getCurrentAdmin();
  if (!account) return localAdminRequiredResponse();
  if (!isPasswordAdmin(account)) return localAdministratorRequiredResponse();
  return handler(account);
}
