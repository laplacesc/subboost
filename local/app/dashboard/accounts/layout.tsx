import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { isPasswordAdmin } from "@local/lib/account-identity";
import { getCurrentAdmin } from "@local/lib/auth";

export default async function AccountsLayout({ children }: { children: ReactNode }) {
  const account = await getCurrentAdmin();
  if (!account) redirect("/login");
  if (!isPasswordAdmin(account)) notFound();
  return children;
}
