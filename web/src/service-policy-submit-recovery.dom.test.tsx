// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { setCSRF, setToken } from "./api";
import type { Service } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const clients: QueryClient[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), {
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

it("returns a new service plan's invalid preview to its name without losing the quota draft in the actual workspace", async (context) => {
  const owner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#services");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const unexpected: string[] = [];
  const writes: { url: string; body: { change: { service: Service }; precondition: { exists: boolean; revision: string } } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input), method = init?.method || "GET";
    if (method !== "GET") {
      const body = JSON.parse(String(init?.body));
      writes.push({ url, body });
      if (url === "/api/access-policy/preview" && method === "POST") return json({
        guard: "opened-record", revision: "review-new-plan", affected: [], blockers: [],
        resource: { target: { kind: "service", id: body.change.service.id }, before: null, after: { service: body.change.service } },
      });
      throw new Error("Unexpected write");
    }
    if (url === "/api/auth/me") return json({ user: { id: "admin", name: "Admin", role: "admin" }, csrfToken: "fixture" });
    if (url === "/api/state") return json({ nodes: [], users: [], routes: [], revisions: [], capabilities: [] });
    if (url === "/api/settings") return json({ name: "Policy fixture", registration: "invite" });
    if (["/api/published-routes", "/api/services", "/api/rates"].includes(url)) return json([]);
    if (url.startsWith("/api/access-policy/edit-context/service/")) return json({
      target: { kind: "service", id: decodeURIComponent(url.split("/").at(-1)!) },
      record: null, precondition: { exists: false, revision: "absent-plan" },
    });
    unexpected.push(`${method} ${url}`);
    throw new Error(`Unexpected request ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false },
  } });
  clients.push(client);
  render(<UIProviders><QueryClientProvider client={client}><App /></QueryClientProvider></UIProviders>);
  await screen.findByRole("main");
  await act(async () => { await vi.dynamicImportSettled(); });
  owner.assertActive();
  await owner.click(() => screen.getAllByRole("button", { name: "新建方案" })[0]);
  const dialog = await screen.findByRole("dialog", { name: "新建服务方案" });
  const ui = within(dialog);
  const name = await ui.findByRole("textbox", { name: "服务方案名称" }) as HTMLInputElement;
  owner.assertActive();
  const quota = ui.getByRole("spinbutton", { name: "周期额度（GiB，0 为不限额）" }) as HTMLInputElement;
  expect(name.value).toBe("");
  expect(name.required).toBe(false);
  owner.change(() => quota, { target: { value: "75" } });
  const preview = ui.getByRole("button", { name: "预览影响" }) as HTMLButtonElement;
  expect(preview.form?.checkValidity()).toBe(true);
  await owner.click(() => preview);
  await ui.findByText("请填写服务方案名称");
  owner.assertActive();
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(quota.value).toBe("75");
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(document.activeElement).toBe(name);
  // A settled retry must recover again, not only the first validation failure.
  await owner.click(() => preview);
  await waitFor(() => expect(document.activeElement).toBe(name));
  owner.assertActive();
  owner.change(() => name, { target: { value: "保留额度方案" } });
  const day = ui.getByRole("spinbutton", { name: "每月几号" }) as HTMLInputElement;
  owner.change(() => day, { target: { value: "" } });
  expect(preview.form?.checkValidity()).toBe(true);
  await owner.click(() => preview);
  await waitFor(() => expect(document.activeElement).toBe(day));
  owner.assertActive();
  expect(quota.value).toBe("75");
  expect(name.value).toBe("保留额度方案");
  expect(writes).toEqual([]);
  owner.change(() => day, { target: { value: "15" } });
  await owner.click(() => preview);
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ url: "/api/access-policy/preview", body: {
    precondition: { exists: false, revision: "absent-plan" },
    change: { service: { name: "保留额度方案", quotaBytes: 80530636800, cycle: { mode: "monthly", day: 15 } } },
  } });
  await owner.click(() => within(review).getByRole("button", { name: "返回编辑" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull());
  owner.assertActive();
  expect(quota.value).toBe("75");
  await owner.click(() => ui.getByRole("button", { name: "取消" }));
  const discard = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(discard).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建服务方案" })).toBeNull());
  owner.assertActive();
  await owner.click(() => screen.getAllByRole("button", { name: "新建方案" })[0]);
  const fresh = within(await screen.findByRole("dialog", { name: "新建服务方案" }));
  const freshName = await fresh.findByRole("textbox", { name: "服务方案名称" });
  owner.assertActive();
  expect((fresh.getByRole("spinbutton", { name: "周期额度（GiB，0 为不限额）" }) as HTMLInputElement).value).toBe("100");
  expect((freshName as HTMLInputElement).value).toBe("");
  await owner.click(() => fresh.getByRole("button", { name: "预览影响" }));
  await waitFor(() => expect(document.activeElement).toBe(freshName));
  owner.assertActive();
  expect(writes).toHaveLength(1);
  expect(unexpected).toEqual([]);
});
