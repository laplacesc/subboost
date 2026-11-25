"use client";

// Fork extension: account identity, level and quota usage on /dashboard/settings.
import { LogOut, Shield, UserRound } from "lucide-react";

import { Button } from "@subboost/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@subboost/ui/components/ui/card";
import type { User } from "@subboost/ui/store/user-store";

const UNLIMITED_THRESHOLD = 9999;

function formatLimit(value: number): string {
  return value >= UNLIMITED_THRESHOLD ? "不限" : String(value);
}

export function describeLoginAccount(user: User): string {
  const github = user.accounts?.find((account) => account.provider === "github");
  return github ? `GitHub · ${github.providerAccountId}` : `密码 · ${user.username}`;
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-ink/5 px-3 py-2">
      <p className="text-xs text-fg-40">{label}</p>
      <p className="mt-1 flex items-center gap-1 font-medium">
        {icon}
        {value}
      </p>
    </div>
  );
}

export function AccountProfileCard({ user, onLogout }: { user: User | null; onLogout: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="rounded-lg bg-indigo-500/20 p-2 text-indigo-300">
          <UserRound className="h-5 w-5" />
        </div>
        <CardTitle className="text-base">个人信息</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {user ? (
          <>
            <div className="flex items-center gap-3">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- remote GitHub avatar, no image optimizer configured
                <img src={user.avatarUrl} alt="" className="h-12 w-12 rounded-full" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink/10 text-fg-60">
                  <UserRound className="h-6 w-6" />
                </div>
              )}
              <div>
                <p className="font-medium">{user.name || user.username}</p>
                <p className="text-sm text-fg-50">@{user.username}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="登录账号" value={describeLoginAccount(user)} />
              <Stat
                label="信任等级"
                value={`Level ${user.trustLevel}${user.isAdmin ? " · 管理员" : ""}`}
                icon={<Shield className="h-4 w-4 text-indigo-400" />}
              />
              <Stat label="订阅配额" value={`${user.subscriptionCount}/${formatLimit(user.quota.maxSubscriptions)}`} />
              <Stat label="模板配额" value={`${user.templateCount}/${formatLimit(user.quota.maxCustomTemplates)}`} />
              <Stat label="节点上限/订阅" value={formatLimit(user.quota.maxNodesPerSubscription)} />
              <Stat label="导入源上限/类型" value={formatLimit(user.quota.maxImportSourcesPerType)} />
            </div>
          </>
        ) : (
          <p className="text-fg-50">未登录</p>
        )}
        <Button variant="destructive" className="gap-2" onClick={onLogout} disabled={!user}>
          <LogOut className="h-4 w-4" />
          退出登录
        </Button>
      </CardContent>
    </Card>
  );
}
