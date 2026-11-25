import {
  deleteGithubAccount,
  parseGithubAccountLevel,
  setGithubAccountLevel,
  type AdminAccountMutationResult,
} from "@local/lib/account-admin";
import { withPasswordAdmin } from "@local/lib/api-auth";
import { getAppUrl } from "@local/lib/env";
import { apiError, json, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "@local/lib/http";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Runs an account mutation for the password administrator. Browsers always send
 * Origin on PATCH/DELETE, so anything other than this site's APP_URL origin is
 * rejected before authentication or body parsing.
 */
async function adminAccountMutation(
  request: Request,
  mutate: () => Promise<Response | AdminAccountMutationResult<unknown>>,
  okBody: (value: unknown) => unknown
): Promise<Response> {
  if (request.headers.get("origin") !== new URL(getAppUrl()).origin) {
    return apiError("Cross-origin request rejected.", "FORBIDDEN", 403);
  }
  return withPasswordAdmin(async () => {
    const result = await mutate();
    if (result instanceof Response) return result;
    if (result.status === "ok") return json(okBody(result.value));
    if (result.status === "not_found") return apiError("Account not found.", "NOT_FOUND", 404);
    return apiError("The password administrator account cannot be changed or deleted.", "FORBIDDEN", 403);
  });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  return adminAccountMutation(
    request,
    async () => {
      const body = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.small);
      if (!body.ok) return jsonBodyError(body);
      const level = parseGithubAccountLevel(body.value);
      if (level === null) return apiError("Level must be the integer 1, 2 or 3.", "VALIDATION_ERROR", 400);
      return setGithubAccountLevel((await params).id, level);
    },
    (account) => ({ account })
  );
}

export async function DELETE(request: Request, { params }: RouteContext) {
  return adminAccountMutation(request, async () => deleteGithubAccount((await params).id), () => ({ success: true }));
}
