// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { SourcesPage } from "./Sources";
import { UIProviders } from "./ui-patterns/providers";
import { sourceRowAction } from "./test-support/source-row-actions";
import type { Source } from "./types";

const initial: Source = {
  id: "travel",
  name: "Travel source",
  kind: "text",
  enabled: true,
  applyMode: "manual",
  revision: "initial",
  content: "socks5://synthetic.example:1080#London",
  snapshot: {
    endpoints: [
      {
        id: "london",
        name: "London",
        connection: {
          protocol: "socks",
          host: "synthetic.example",
          port: 1080,
        },
      },
    ],
  },
};
const pending: Source = {
  ...initial,
  revision: "pending",
  candidate: {
    id: "candidate",
    createdAt: "2026-11-08T00:00:00Z",
    diff: {
      beforeCount: 1,
      afterCount: 1,
      added: [],
      removed: [],
      renamed: [],
      connectionChanged: [{ id: "london", name: "London", fields: ["port"] }],
    },
    affected: [],
  },
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
// Sonner's public active-notification API excludes dismissed notices immediately.
// Do not wait for expiry or exit animation to hide stale task feedback.
const activeNotices = () =>
  toast
    .getToasts()
    .map((notice) => ("title" in notice ? notice.title : undefined));

for (const origin of ["save", "refresh"] as const) {
  for (const path of ["row", "review", "recovery"] as const) {
    it(`${origin} pending notice follows ${path} application without clearing unrelated notices`, async () => {
      let current = initial;
      const writes: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (init?.method === "PUT" || url.endsWith("/refresh")) {
            writes.push(url);
            current = pending;
            return json(current);
          }
          if (url.endsWith("/apply")) {
            writes.push(url);
            if (path === "recovery")
              throw new TypeError("Response unavailable");
            current = {
              ...initial,
              revision: "applied",
              refreshStatus: "accepted",
            };
            return json({
              ...current,
              application: {
                candidateId: "candidate",
                sourceRevision: "applied",
                affected: [],
              },
            });
          }
          return json(url.endsWith("/me/sources") ? [current] : current);
        }),
      );
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
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
      if (origin === "save") {
        await user.click(await sourceRowAction("编辑", "Travel source"));
        const editor = within(
          await screen.findByRole("dialog", { name: "编辑来源" }),
        );
        const content = await editor.findByLabelText("节点链接或配置内容");
        await user.clear(content);
        await user.type(content, "socks5://synthetic.example:2080#London");
        await user.click(editor.getByRole("button", { name: "保存修改" }));
      } else {
        await user.click(await sourceRowAction("刷新", "Travel source"));
      }
      const pendingNotice =
        origin === "save"
          ? "来源已保存，有更新可手动应用"
          : "发现更新，可手动应用";
      await screen.findByText(pendingNotice, { exact: true });
      expect(activeNotices()).toContain(pendingNotice);
      await act(async () => {
        toast.info("Other source awaits application", {
          id: "source-application:other",
          duration: Infinity,
        });
        toast.error("Unrelated request failed", {
          id: "source-failure:other",
          duration: Infinity,
        });
      });
      const unrelatedRemain = () => {
        expect(activeNotices()).toContain("Other source awaits application");
        expect(activeNotices()).toContain("Unrelated request failed");
      };
      if (path === "review") {
        await user.click(
          await screen.findByRole("button", { name: "查看变化" }),
        );
        const review = within(
          await screen.findByRole("dialog", { name: "查看变化" }),
        );
        expect(activeNotices()).not.toContain(pendingNotice);
        unrelatedRemain();
        await user.click(review.getByRole("button", { name: "应用更新" }));
      } else {
        await user.click(
          await screen.findByRole("button", { name: "应用更新 Travel source" }),
        );
      }
      if (path === "recovery") {
        const review = within(
          await screen.findByRole("dialog", { name: "查看变化" }),
        );
        expect(
          review.getByRole("button", { name: "核对当前状态" }),
        ).toBeTruthy();
        expect(activeNotices()).not.toContain(pendingNotice);
        unrelatedRemain();
        expect(writes).toEqual([
          origin === "save"
            ? "/api/me/sources/travel"
            : "/api/me/sources/travel/refresh",
          "/api/me/sources/travel/apply",
        ]);
        return;
      }
      const appliedNotice = "「Travel source」已应用，已发布订阅未改变";
      await screen.findByText(appliedNotice, { exact: true });
      expect(activeNotices()).toContain(appliedNotice);
      expect(activeNotices()).not.toContain(pendingNotice);
      unrelatedRemain();
      await user.click(
        await screen.findByRole("button", {
          name: "查看上次应用结果 Travel source",
        }),
      );
      const receipt = within(
        await screen.findByRole("dialog", { name: "上次应用详情" }),
      );
      expect(
        receipt.getByText("来源已更新，已发布订阅未改变。", { exact: true }),
      ).toBeTruthy();
      expect(activeNotices()).not.toContain(appliedNotice);
      expect(activeNotices()).not.toContain(pendingNotice);
      unrelatedRemain();
      expect(writes).toEqual([
        origin === "save"
          ? "/api/me/sources/travel"
          : "/api/me/sources/travel/refresh",
        "/api/me/sources/travel/apply",
      ]);
    });
  }
}
