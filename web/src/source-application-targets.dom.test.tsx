// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourcesPage } from "./Sources";
import { UIProviders } from "./ui-patterns/providers";
import type { Source } from "./types";

const pending: Source = {
  id: "source",
  name: "Travel source",
  kind: "text",
  enabled: true,
  applyMode: "manual",
  revision: "pending-revision",
  snapshot: {
    endpoints: [
      {
        id: "endpoint",
        name: "London",
        connection: {
          protocol: "socks",
          host: "synthetic.example",
          port: 1080,
        },
      },
    ],
  },
  candidate: {
    id: "candidate",
    createdAt: "2026-11-07T10:00:00Z",
    diff: {
      beforeCount: 1,
      afterCount: 1,
      added: [],
      removed: [],
      renamed: [],
      connectionChanged: [
        { id: "endpoint", name: "London", fields: ["password"] },
      ],
    },
    affected: [
      {
        kind: "profile",
        id: "renamed",
        name: "Former profile name",
        reason: "draft-inputs-changed",
      },
      {
        kind: "subscription",
        id: "removed",
        name: "Removed subscription",
        reason: "published-unchanged",
      },
    ],
  },
};
const currentTargets = [
  {
    kind: "profile",
    id: "renamed",
    name: "Current profile name",
    reason: "draft-inputs-changed",
  },
  {
    kind: "profile",
    id: "added",
    name: "Added profile",
    reason: "draft-inputs-changed",
  },
  {
    kind: "subscription",
    id: "added-output",
    name: "Added subscription",
    reason: "published-unchanged",
  },
];
const application = {
  candidateId: "candidate",
  sourceRevision: "applied-revision",
  affected: currentTargets,
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function applyAndInspect(
  path: "row" | "review",
  receipt: unknown,
  responseRevision: unknown = "applied-revision",
) {
  let current = pending;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        writes.push(url);
        expect(JSON.parse(String(init.body))).toEqual({
          candidateId: "candidate",
          sourceRevision: "pending-revision",
        });
        current = {
          ...pending,
          candidate: undefined,
          revision: "applied-revision",
          refreshStatus: "accepted",
        };
        return json({
          ...current,
          revision: responseRevision,
          application: receipt,
        });
      }
      return json(url.endsWith("/me/sources") ? [current] : []);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  if (path === "row") {
    await user.click(
      await screen.findByRole("button", { name: "应用更新 Travel source" }),
    );
  } else {
    await user.click(await screen.findByRole("button", { name: "查看变化" }));
    const review = await screen.findByRole("dialog", { name: "查看变化" });
    await user.click(within(review).getByRole("button", { name: "应用更新" }));
  }
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(
    await screen.findByRole("button", {
      name: "查看上次应用结果 Travel source",
    }),
  );
  const dialog = within(
    await screen.findByRole("dialog", { name: "上次应用详情" }),
  );
  return { dialog, writes, user };
}

for (const path of ["row", "review"] as const) {
  it(`${path} application continues to added and renamed current targets, never removed candidate targets`, async () => {
    const { dialog, writes, user } = await applyAndInspect(path, application);
    expect(
      dialog
        .getByRole("link", { name: "查看配置 Current profile name" })
        .getAttribute("href"),
    ).toBe("#subscriptions?profile=renamed");
    expect(
      dialog
        .getByRole("link", { name: "查看配置 Added profile" })
        .getAttribute("href"),
    ).toBe("#subscriptions?profile=added");
    expect(
      dialog
        .getByRole("link", { name: "查看订阅 Added subscription" })
        .getAttribute("href"),
    ).toBe("#subscriptions?output=added-output");
    expect(
      dialog.queryByText("Former profile name", { exact: true }),
    ).toBeNull();
    expect(
      dialog.queryByText("Removed subscription", { exact: true }),
    ).toBeNull();
    await user.click(dialog.getByRole("button", { name: "查看本次更新" }));
    expect(dialog.getByText("London", { exact: true })).toBeTruthy();
    expect(dialog.getByText("登录密码", { exact: true })).toBeTruthy();
    expect(writes).toEqual(["/api/me/sources/source/apply"]);
  });

  for (const [problem, invalid, responseRevision] of [
    ["missing", undefined],
    ["another candidate", { ...application, candidateId: "other-candidate" }],
    [
      "another committed revision",
      { ...application, sourceRevision: "other-revision" },
    ],
    [
      "malformed targets",
      { ...application, affected: [currentTargets[0], null] },
    ],
    [
      "uncommitted revision",
      { ...application, sourceRevision: "pending-revision" },
      "pending-revision",
    ],
    ["non-string revision", { ...application, sourceRevision: 7 }, 7],
  ] as const) {
    it(`${path} application with ${problem} receipt remains successful without inventing target links or retrying`, async () => {
      const { dialog, writes } = await applyAndInspect(
        path,
        invalid,
        responseRevision,
      );
      expect(
        dialog.getByText("来源已更新，已发布订阅未改变。", { exact: true }),
      ).toBeTruthy();
      expect(
        dialog.getByText("相关配置暂无法核对", { exact: true }),
      ).toBeTruthy();
      expect(
        dialog.getByRole("link", { name: "查看我的订阅" }).getAttribute("href"),
      ).toBe("#subscriptions");
      expect(dialog.getAllByRole("link")).toHaveLength(1);
      expect(dialog.queryByRole("button", { name: "应用更新" })).toBeNull();
      expect(
        dialog.queryByText("Former profile name", { exact: true }),
      ).toBeNull();
      expect(
        dialog.queryByText("Removed subscription", { exact: true }),
      ).toBeNull();
      expect(writes).toEqual(["/api/me/sources/source/apply"]);
    });
  }

  it(`${path} application distinguishes a confirmed empty target list from an unavailable receipt`, async () => {
    const { dialog } = await applyAndInspect(path, {
      ...application,
      affected: [],
    });
    expect(
      dialog.queryByText("相关配置暂无法核对", { exact: true }),
    ).toBeNull();
    expect(dialog.queryByRole("link")).toBeNull();
  });
}
