"use client";

// Fork extension: password-administrator account management.
import * as React from "react";
import { Lock, Trash2, UserRound, Users } from "lucide-react";

import type { AdminAccountView } from "@local/lib/account-admin";
import { Button } from "@subboost/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@subboost/ui/components/ui/card";
import { ChoiceChip, ChoiceGroup } from "@subboost/ui/components/ui/choice-group";
import { confirmDialog } from "@subboost/ui/components/ui/confirm-dialog";
import { toast } from "@subboost/ui/components/ui/toaster";
import { readJsonResponse } from "@subboost/ui/product/client-response";

type AccountsResponse = { currentAccountId: string; accounts: AdminAccountView[] };

type LoadState =
  | { status: "loading" }
  | { status: "denied"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; currentAccountId: string; accounts: AdminAccountView[] };

const GITHUB_LEVELS = [1, 2, 3] as const;

function accountName(account: AdminAccountView): string {
  return account.displayName || account.loginIdentifier;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "从未登录";
}

function AccountRow({
  account,
  isCurrent,
  pending,
  onLevelChange,
  onDelete,
}: {
  account: AdminAccountView;
  isCurrent: boolean;
  pending: boolean;
  onLevelChange: (account: AdminAccountView, level: 1 | 2 | 3) => void;
  onDelete: (account: AdminAccountView) => void;
}) {
  const isGithub = account.kind === "GITHUB";
  return (
    <li className="flex flex-col gap-4 py-4 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        {account.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote GitHub avatar, no image optimizer configured
          <img src={account.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full" />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink/10 text-fg-60">
            <UserRound className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate font-medium">
            {accountName(account)}
            {isCurrent ? <span className="ml-2 text-xs text-fg-50">（当前账户）</span> : null}
          </p>
          <p className="truncate text-sm text-fg-50">
            {isGithub ? `GitHub @${account.loginIdentifier}` : `密码登录 ${account.loginIdentifier}`}
          </p>
          <p className="text-xs text-fg-40">
            订阅 {account.subscriptionCount} · 模板 {account.templateCount} · 最近登录 {formatDate(account.lastLoginAt)}
          </p>
        </div>
      </div>
      {isGithub ? (
        <div className="flex flex-wrap items-center gap-3">
          <ChoiceGroup label={`${accountName(account)} 的等级`}>
            {GITHUB_LEVELS.map((level) => (
              <ChoiceChip
                key={level}
                label={`Level ${level}`}
                selected={account.level === level}
                disabled={pending}
                onClick={() => onLevelChange(account, level)}
              />
            ))}
          </ChoiceGroup>
          <Button variant="destructive" size="sm" disabled={pending} onClick={() => onDelete(account)}>
            <Trash2 className="h-4 w-4" />
            删除账户
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-fg-50">
          <Lock className="h-4 w-4" />
          Level {account.level} 管理员，不可调整或删除
        </p>
      )}
    </li>
  );
}

export default function AccountsPage() {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/accounts", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          if (!cancelled) {
            setState({
              status: "denied",
              message: response.status === 401 ? "请先登录管理员账户。" : "只有管理员可以管理账户。",
            });
          }
          return;
        }
        const data = await readJsonResponse<AccountsResponse>(response, "加载账户失败");
        if (!cancelled) setState({ status: "ready", currentAccountId: data.currentAccountId, accounts: data.accounts });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "加载账户失败" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function changeLevel(account: AdminAccountView, level: 1 | 2 | 3) {
    if (account.level === level) return;
    setPendingId(account.id);
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level }),
      });
      const data = await readJsonResponse<{ account: AdminAccountView }>(response, "调整等级失败");
      setState((current) =>
        current.status === "ready"
          ? { ...current, accounts: current.accounts.map((item) => (item.id === account.id ? data.account : item)) }
          : current
      );
      toast({ title: `已将 ${accountName(account)} 调整为 Level ${level}`, variant: "success" });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : "调整等级失败", variant: "destructive" });
    } finally {
      setPendingId(null);
    }
  }

  async function deleteAccount(account: AdminAccountView) {
    const confirmed = await confirmDialog({
      title: `删除 ${accountName(account)}？`,
      description: "将同时删除该账户的订阅、模板和设置，旧的登录会话和订阅链接立即失效。此操作无法撤销。",
      confirmText: "删除账户",
      cancelText: "取消",
      variant: "destructive",
    });
    if (!confirmed) return;

    setPendingId(account.id);
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      await readJsonResponse<{ success: true }>(response, "删除账户失败");
      setState((current) =>
        current.status === "ready"
          ? { ...current, accounts: current.accounts.filter((item) => item.id !== account.id) }
          : current
      );
      toast({ title: `已删除 ${accountName(account)}`, variant: "success" });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : "删除账户失败", variant: "destructive" });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 text-2xl font-bold">账户管理</h1>
        <p className="text-fg-50">调整 GitHub 账户等级，或删除账户及其数据</p>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="rounded-lg bg-indigo-500/20 p-2 text-indigo-300">
            <Users className="h-5 w-5" />
          </div>
          <CardTitle className="text-base">全部账户</CardTitle>
        </CardHeader>
        <CardContent>
          {state.status === "loading" ? <p className="text-fg-50">正在加载账户…</p> : null}
          {state.status === "denied" ? <p className="text-fg-50">{state.message}</p> : null}
          {state.status === "error" ? <p role="alert" className="text-sm text-red-300">{state.message}</p> : null}
          {state.status === "ready" ? (
            <ul className="divide-y divide-ink/10">
              {state.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  isCurrent={account.id === state.currentAccountId}
                  pending={pendingId === account.id}
                  onLevelChange={changeLevel}
                  onDelete={deleteAccount}
                />
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
