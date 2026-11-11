// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { setCSRF, setToken } from "./api";
import type { Service } from "./types";
import type { UserGroup, PolicyEditPrecondition } from "./access-policy-model";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const clients: QueryClient[] = [];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setCSRF("");
  setToken("");
});

const plan: Service = {
  id: "plan-a",
  name: "Team plan",
  quotaBytes: 0,
  routeIds: [],
  cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "UTC+8" },
};
for (const existing of [false, true])
  it(`recovers invalid group Preview in the users workspace without losing members or priority (existing=${existing})`, async (context) => {
    const owner = ownedClickScenario(context);
    vi.stubEnv("NODE_ENV", "development");
    setCSRF("");
    setToken("");
    history.replaceState(null, "", "#users");
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const unexpected: string[] = [];
    const saved: UserGroup = {
      id: "g1",
      name: "Saved team",
      serviceId: "plan-a",
      memberIds: [],
      priority: 1,
    };
    const precondition = {
      exists: existing,
      revision: existing ? "opened-group" : "absent-group",
    };
    const writes: {
      url: string;
      body: {
        change: { group: UserGroup };
        precondition: PolicyEditPrecondition;
      };
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input),
          method = init?.method || "GET";
        if (method !== "GET") {
          const body = JSON.parse(String(init?.body));
          writes.push({ url, body });
          if (url === "/api/access-policy/preview" && method === "POST")
            return json({
              guard: "opened-record",
              revision: "review-group",
              affected: [],
              blockers: [],
              resource: {
                target: { kind: "group", id: body.change.group.id },
                before: existing ? { group: saved } : null,
                after: { group: body.change.group },
              },
            });
          throw new Error("Unexpected write");
        }
        if (url === "/api/auth/me")
          return json({
            user: { id: "admin", name: "Admin", role: "admin" },
            csrfToken: "fixture",
          });
        if (url === "/api/state")
          return json({
            nodes: [],
            users: [
              {
                id: "u1",
                name: "Alice",
                enabled: true,
                quotaBytes: 0,
                usedBytes: 0,
              },
            ],
            routes: [],
            revisions: [],
            capabilities: [],
          });
        if (url === "/api/settings")
          return json({ name: "Policy fixture", registration: "invite" });
        if (url === "/api/services") return json([plan]);
        if (url === "/api/user-groups") return json(existing ? [saved] : []);
        if (
          ["/api/published-routes", "/api/invites", "/api/rates"].includes(url)
        )
          return json([]);
        if (url.startsWith("/api/access-policy/edit-context/group/"))
          return json({
            target: {
              kind: "group",
              id: decodeURIComponent(url.split("/").at(-1)!),
            },
            record: existing ? { group: saved } : null,
            precondition,
          });
        unexpected.push(`${method} ${url}`);
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    render(
      <UIProviders>
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>
      </UIProviders>,
    );
    await screen.findByRole("main");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await owner.click(() =>
      screen.findByRole("button", {
        name: existing ? "编辑 Saved team" : "新建用户组",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: existing ? "编辑 Saved team" : "新建用户组",
    });
    const ui = within(dialog);
    const name = await ui.findByRole("textbox", { name: "用户组名称" });
    owner.change(() => name, { target: { value: "" } });
    const priority = ui.getByRole("spinbutton", { name: "用户组优先级" });
    owner.change(() => priority, { target: { value: "42" } });
    await owner.click(() => ui.getByRole("combobox", { name: "组成员" }));
    await owner.click(() => screen.getByRole("option", { name: "Alice" }));
    await owner.click(() => ui.getByRole("combobox", { name: "组成员" }));
    const preview = ui.getByRole("button", { name: "预览影响" });
    await owner.click(() => preview);
    await ui.findByText("请输入用户组名称");
    expect(writes).toEqual([]);
    expect(priority).toHaveProperty("value", "42");
    expect(ui.getByRole("combobox", { name: "组成员" }).textContent).toContain(
      "已选择 1 项",
    );
    await waitFor(() => expect(document.activeElement).toBe(name));
    owner.change(() => name, { target: { value: "Team" } });
    if (!existing) {
      await owner.click(() => preview);
      await waitFor(() =>
        expect(document.activeElement).toBe(
          ui.getByRole("combobox", { name: "组服务方案" }),
        ),
      );
      await owner.click(() => ui.getByRole("combobox", { name: "组服务方案" }));
      await owner.click(() =>
        screen.getByRole("option", { name: "Team plan" }),
      );
    }
    owner.change(() => priority, { target: { value: "" } });
    await owner.click(() => preview);
    await waitFor(() => expect(document.activeElement).toBe(priority));
    expect(writes).toEqual([]);
    owner.change(() => priority, { target: { value: "42" } });
    await owner.click(() => preview);
    const review = await screen.findByRole("dialog", { name: "确认授权变更" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      url: "/api/access-policy/preview",
      body: {
        precondition,
        change: {
          group: {
            name: "Team",
            serviceId: "plan-a",
            memberIds: ["u1"],
            priority: 42,
          },
        },
      },
    });
    await owner.click(() =>
      within(review).getByRole("button", { name: "返回编辑" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull(),
    );
    expect(priority).toHaveProperty("value", "42");
    expect(writes).toHaveLength(1);
    await owner.click(() => ui.getByRole("button", { name: "取消" }));
    const discard = await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的授权修改？",
    });
    await owner.click(() =>
      within(discard).getByRole("button", { name: "放弃修改" }),
    );
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    await owner.click(() =>
      screen.findByRole("button", {
        name: existing ? "编辑 Saved team" : "新建用户组",
      }),
    );
    const fresh = within(
      await screen.findByRole("dialog", {
        name: existing ? "编辑 Saved team" : "新建用户组",
      }),
    );
    const freshName = await fresh.findByRole("textbox", { name: "用户组名称" });
    expect(freshName).toHaveProperty("value", existing ? "Saved team" : "");
    expect(
      fresh.getByRole("spinbutton", { name: "用户组优先级" }),
    ).toHaveProperty("value", existing ? "1" : "0");
    owner.change(() => freshName, { target: { value: "" } });
    await owner.click(() => fresh.getByRole("button", { name: "预览影响" }));
    await waitFor(() => expect(document.activeElement).toBe(freshName));
    expect(writes).toHaveLength(1);
    expect(unexpected).toEqual([]);
  });
