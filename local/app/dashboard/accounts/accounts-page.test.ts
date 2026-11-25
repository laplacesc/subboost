import { setImmediate } from "node:timers/promises";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ReactModule = typeof React;
type ButtonProps = { children?: React.ReactNode; variant?: string; disabled?: boolean; onClick: () => Promise<void> };
type ChipProps = { label: string; selected: boolean; onClick: () => Promise<void> };

const mocks = vi.hoisted(() => ({
  buttons: [] as ButtonProps[],
  chips: [] as ChipProps[],
  confirmDialog: vi.fn(),
  toast: vi.fn(),
  stateValues: [] as unknown[],
  setters: [vi.fn(), vi.fn()],
  stateIndex: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<ReactModule>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useState: (initial: unknown) => {
      const index = mocks.stateIndex++;
      return [index in mocks.stateValues ? mocks.stateValues[index] : initial, mocks.setters[index]];
    },
  };
});

vi.mock("@subboost/ui/components/ui/button", async () => {
  const actualReact = await vi.importActual<ReactModule>("react");
  return {
    Button: (props: ButtonProps) => {
      mocks.buttons.push(props);
      return actualReact.createElement("button", { disabled: props.disabled }, props.children);
    },
  };
});

vi.mock("@subboost/ui/components/ui/choice-group", async () => {
  const actualReact = await vi.importActual<ReactModule>("react");
  return {
    ChoiceGroup: ({ label, children }: { label: string; children: React.ReactNode }) =>
      actualReact.createElement("div", { role: "group", "aria-label": label }, children),
    ChoiceChip: (props: ChipProps) => {
      mocks.chips.push(props);
      return actualReact.createElement("button", { "aria-pressed": props.selected }, props.label);
    },
  };
});

vi.mock("@subboost/ui/components/ui/confirm-dialog", () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock("@subboost/ui/components/ui/toaster", () => ({ toast: mocks.toast }));

import AccountsPage from "./page";

const ADMIN = {
  id: "admin-1",
  kind: "PASSWORD",
  level: 4,
  loginIdentifier: "admin",
  githubId: null,
  displayName: null,
  avatarUrl: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastLoginAt: null,
  subscriptionCount: 1,
  templateCount: 0,
};
const MEMBER = {
  ...ADMIN,
  id: "github-1",
  kind: "GITHUB",
  level: 1,
  loginIdentifier: "octo",
  githubId: "1001",
  displayName: "Octo Cat",
};
const READY = { status: "ready", currentAccountId: "admin-1", accounts: [ADMIN, MEMBER] };

function render(state?: unknown) {
  mocks.stateIndex = 0;
  mocks.stateValues = state === undefined ? [] : [state, null];
  return renderToStaticMarkup(React.createElement(AccountsPage));
}

async function flushAsyncWork() {
  await setImmediate();
}

function pendingResponse() {
  return Promise.withResolvers<Response>().promise;
}

function lastStateUpdate(current: unknown) {
  const update = mocks.setters[0].mock.calls.at(-1)?.[0];
  return typeof update === "function" ? update(current) : update;
}

describe("AccountsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.buttons = [];
    mocks.chips = [];
  });

  it("loads the account list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ currentAccountId: "admin-1", accounts: [ADMIN, MEMBER] })))
    );

    expect(render()).toContain("正在加载账户");
    await flushAsyncWork();

    expect(fetch).toHaveBeenCalledWith("/api/admin/accounts", { cache: "no-store" });
    expect(mocks.setters[0]).toHaveBeenCalledWith(READY);
  });

  it.each([
    [401, "请先登录管理员账户。"],
    [403, "只有管理员可以管理账户。"],
  ])("shows access denial for HTTP %s without listing accounts", async (status, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "denied" }), { status })));

    render();
    await flushAsyncWork();

    expect(mocks.setters[0]).toHaveBeenCalledWith({ status: "denied", message });
    expect(render({ status: "denied", message })).toContain(message);
  });

  it("offers level and delete controls only on GitHub rows", () => {
    vi.stubGlobal("fetch", vi.fn(pendingResponse));

    const html = render(READY);

    expect(html).toContain("（当前账户）");
    expect(html).toContain("Level 4 管理员，不可调整或删除");
    expect(html).toContain("GitHub @octo");
    expect(mocks.chips.map((chip) => [chip.label, chip.selected])).toEqual([
      ["Level 1", true],
      ["Level 2", false],
      ["Level 3", false],
    ]);
    expect(mocks.buttons.map((button) => button.variant)).toEqual(["destructive"]);
  });

  it("changes a GitHub account level through the admin API", async () => {
    const updated = { ...MEMBER, level: 3 };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(pendingResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify({ account: updated })))
    );
    render(READY);

    await mocks.chips.find((chip) => chip.label === "Level 3")!.onClick();

    expect(fetch).toHaveBeenLastCalledWith("/api/admin/accounts/github-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: 3 }),
    });
    expect(lastStateUpdate(READY)).toEqual({ ...READY, accounts: [ADMIN, updated] });
    expect(mocks.setters[1]).toHaveBeenNthCalledWith(1, "github-1");
    expect(mocks.setters[1]).toHaveBeenLastCalledWith(null);
  });

  it("keeps the account when deletion is cancelled", async () => {
    vi.stubGlobal("fetch", vi.fn(pendingResponse));
    mocks.confirmDialog.mockResolvedValue(false);
    render(READY);

    await mocks.buttons[0].onClick();

    expect(mocks.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.setters[0]).not.toHaveBeenCalled();
  });

  it("deletes the account after confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(pendingResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })))
    );
    mocks.confirmDialog.mockResolvedValue(true);
    render(READY);

    await mocks.buttons[0].onClick();

    expect(fetch).toHaveBeenLastCalledWith("/api/admin/accounts/github-1", { method: "DELETE" });
    expect(lastStateUpdate(READY)).toEqual({ ...READY, accounts: [ADMIN] });
    expect(mocks.toast).toHaveBeenCalledWith({ title: "已删除 Octo Cat", variant: "success" });
  });

  it("reports a failed deletion and keeps the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(pendingResponse())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "The password administrator account cannot be changed or deleted." }), {
            status: 403,
          })
        )
    );
    mocks.confirmDialog.mockResolvedValue(true);
    render(READY);

    await mocks.buttons[0].onClick();

    expect(mocks.setters[0]).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "The password administrator account cannot be changed or deleted.",
      variant: "destructive",
    });
  });
});
