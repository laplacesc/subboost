import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const header = vi.hoisted(() => vi.fn((_props: unknown) => null));

vi.mock("@subboost/ui/components/layout/header", () => ({ Header: header }));

import { LocalHeader } from "./local-header";

it("adds the account management link to the privileged menu slot", () => {
  renderToStaticMarkup(React.createElement(LocalHeader));

  expect(header.mock.calls[0]?.[0]).toMatchObject({
    mode: "local",
    privilegedMenuItem: { href: "/dashboard/accounts", label: "账户管理" },
  });
});
