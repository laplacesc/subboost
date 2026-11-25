"use client";

// Fork extension: GitHub sign-in entry shown above the password form on /login.
import * as React from "react";
import { Button } from "@subboost/ui/components/ui/button";

export const GITHUB_LOGIN_ERROR_MESSAGE = "GitHub 登录失败，请重试。";

// lucide-react 1.x ships no brand icons; same mark as the shared footer.
function GithubMark() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 fill-current" focusable="false" viewBox="0 0 24 24">
      <path d="M12 .5C5.65 .5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18A10.93 10.93 0 0 1 12 5.54c.98 0 1.97.13 2.89.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export function GithubLoginEntry({ returnTo }: { returnTo: string }) {
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setFailed(new URLSearchParams(window.location.search).get("error") === "github");
  }, []);

  return (
    <div className="space-y-3">
      <Button asChild variant="outline" className="h-12 w-full">
        <a href={`/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`}>
          <GithubMark />
          使用 GitHub 登录
        </a>
      </Button>
      {failed ? (
        <p className="text-red-400 text-sm" aria-live="polite">
          {GITHUB_LOGIN_ERROR_MESSAGE}
        </p>
      ) : null}
      <div className="flex items-center gap-3 text-xs text-fg-50">
        <span className="h-px flex-1 bg-ink/10" />
        管理员账号登录
        <span className="h-px flex-1 bg-ink/10" />
      </div>
    </div>
  );
}
