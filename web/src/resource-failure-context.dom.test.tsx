// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResourcesPage } from "./Resources";
import { UIProviders } from "./ui-patterns/providers";

const clients: QueryClient[] = [];
const reason = "刷新失败，保留已接纳文件。新发布前请重试或替换。";
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.unstubAllGlobals();
});

it("keeps one current refresh error, restores row context, and clears failure after a successful retry", async () => {
  const user = userEvent.setup();
  const requestFailure = "远程文件暂时无法读取，请稍后重试。";
  let state = "accepted";
  let refreshes = 0;
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      requests.push(`${method} ${url}`);
      if (method === "GET" && url === "/api/me/resources")
        return new Response(
          JSON.stringify([
            {
              id: "retained-rules",
              name: "已接纳的规则文件",
              revision: "1",
              format: "mihomo-yaml",
              behavior: "domain",
              location: "remote",
              updatePolicy: "pinned",
              acceptedVersion: "accepted-1",
              revisionToken: `rw1_retained_refresh_${refreshes}`,
              sizeBytes: 2450,
              canRefresh: true,
              refreshStatus: state,
              visibility: "private",
            },
          ]),
          { headers: { "Content-Type": "application/json" } },
        );
      if (
        method === "POST" &&
        url === "/api/me/resources/retained-rules/refresh"
      ) {
        refreshes++;
        state = refreshes === 1 ? "failed" : "accepted";
        return new Response(
          JSON.stringify(refreshes === 1 ? { error: requestFailure } : {}),
          {
            status: refreshes === 1 ? 503 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ResourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const actions = await screen.findByRole("group", {
    name: "已接纳的规则文件 的操作",
  });
  const refresh = within(actions).getByRole("button", { name: "刷新文件" });
  await user.click(refresh);
  const decision = await screen.findByRole("alertdialog");
  await user.click(
    within(decision).getByRole("button", { name: "读取并接纳" }),
  );
  await within(decision).findByText(requestFailure);
  await waitFor(() =>
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1),
  );
  expect(within(decision).getByRole("alert").textContent).toBe(requestFailure);
  await user.click(within(decision).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(refresh));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain(requestFailure);
  const fullReason = screen.getByText(
    (_, node) => node?.tagName === "P" && node.textContent === reason,
  );
  expect(fullReason.getAttribute("role")).toBeNull();
  expect(refresh.getAttribute("aria-describedby")).toBe(fullReason.id);
  await user.click(refresh);
  const reconsider = await screen.findByRole("alertdialog");
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  await user.click(within(reconsider).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(refresh));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain(requestFailure);
  expect(refreshes).toBe(1);
  const replace = within(actions).getByRole("button", {
    name: "替换文件",
    description: reason,
  });
  await user.click(replace);
  const replacement = await screen.findByRole("dialog", {
    name: "替换 已接纳的规则文件",
  });
  await user.click(within(replacement).getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "替换 已接纳的规则文件" }),
    ).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(replace));
  expect(screen.getByRole("alert").textContent).toContain(requestFailure);
  await user.click(refresh);
  const retry = await screen.findByRole("alertdialog");
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  await user.click(within(retry).getByRole("button", { name: "读取并接纳" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(refresh));
  expect(screen.queryByText(requestFailure)).toBeNull();
  expect(screen.queryByText("刷新失败", { exact: true })).toBeNull();
  expect(refresh.getAttribute("aria-describedby")).toBeNull();
  expect(replace.getAttribute("aria-describedby")).toBeNull();
  expect(refreshes).toBe(2);
  expect(requests.filter((request) => request.startsWith("POST"))).toEqual([
    "POST /api/me/resources/retained-rules/refresh",
    "POST /api/me/resources/retained-rules/refresh",
  ]);
});

it("associates failed resource actions with the complete original reason without another live region", async () => {
  const fetcher = vi.fn(
    async (_input: string) =>
      new Response(
        JSON.stringify([
          {
            id: "failed",
            name: "待刷新规则",
            acceptedVersion: "accepted-1",
            refreshStatus: "failed",
            canRefresh: true,
            format: "mihomo-yaml",
            updatePolicy: "pinned",
            sizeBytes: 2450,
            visibility: "private",
          },
          {
            id: "healthy",
            name: "已接纳规则",
            acceptedVersion: "accepted-2",
            refreshStatus: "accepted",
            canRefresh: true,
            format: "mihomo-yaml",
            updatePolicy: "pinned",
            sizeBytes: 2450,
            visibility: "private",
          },
        ]),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ResourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const failed = await screen.findByRole("group", {
    name: "待刷新规则 的操作",
  });
  const alert = screen.getByText(
    (_, node) => node?.tagName === "P" && node.textContent === reason,
  );
  expect(alert.getAttribute("role")).toBeNull();
  for (const name of ["替换文件", "刷新文件"]) {
    const action = within(failed).getByRole("button", {
      name,
      description: reason,
    });
    expect(action.getAttribute("aria-describedby")).toBe(alert.id);
    action.focus();
    expect(document.activeElement).toBe(action);
    expect(
      document.getElementById(action.getAttribute("aria-describedby")!),
    ).toBe(alert);
  }
  const visualStatus = within(failed).getByText("刷新失败", { exact: true });
  expect(visualStatus.getAttribute("aria-hidden")).toBe("true");
  expect(visualStatus.getAttribute("role")).toBeNull();
  expect(visualStatus.getAttribute("aria-live")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  const healthy = screen.getByRole("group", { name: "已接纳规则 的操作" });
  expect(within(healthy).queryByText("刷新失败", { exact: true })).toBeNull();
  for (const action of within(healthy).getAllByRole("button"))
    expect(action.getAttribute("aria-describedby")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/me/resources");
});
