// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import type { EffectivePolicy } from "./access-policy-model";
import type { Entitlement } from "./types";

let owner: ReturnType<typeof ownedClickScenario>;
const clients: QueryClient[] = [];
const user = {
  id: "recipient",
  name: "首次使用者",
  enabled: true,
  quotaBytes: 0,
  usedBytes: 0,
};
const legacy = {
  id: "invite-route",
  name: "受邀体验线路",
  hops: [],
  engine: "xray",
  userIds: [user.id],
};
const managed = {
  id: "managed-route",
  name: "已发布线路",
  status: "published",
};
const original: Entitlement = {
  userId: user.id,
  startsAt: "0001-01-01T00:00:00Z",
  paused: false,
  cycle: {
    mode: "none",
    anchor: "0001-01-01T00:00:00Z",
    timezone: "Asia/Shanghai",
  },
  routeIdsOverride: [legacy.id],
};
const effective = (entitlement: Entitlement): EffectivePolicy => ({
  userId: user.id,
  entitlement,
  groupIds: [],
  routeIds: entitlement.routeIdsOverride ?? [legacy.id],
  quotaBytes: 0,
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  status: entitlement.paused ? "paused" : "active",
  provenance: { routes: "individual" },
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
beforeEach((test) => {
  owner = ownedClickScenario(test);
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
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(collision = false) {
  const writes: { path: string; body: any }[] = [];
  const published = collision ? [{ ...managed, id: legacy.id }] : [managed];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path === "/api/state")
        return json({
          nodes: [],
          users: [user],
          routes: [legacy],
          capabilities: [],
          revisions: [],
        });
      if (path === "/api/published-routes") return json(published);
      if (path.endsWith("/admission-status"))
        return json({
          asOf: "2026-11-07T00:00:00Z",
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      if (path.includes("/edit-context/"))
        return json({
          target: { kind: "entitlement", id: user.id },
          record: { entitlement: original },
          precondition: { exists: true, revision: "opened" },
          effective: effective(original),
        });
      if (path.endsWith("/preview")) {
        const body = JSON.parse(init!.body as string);
        writes.push({ path, body });
        return json({
          guard: "opened-record",
          revision: "reviewed",
          blockers: [],
          resource: {
            target: { kind: "entitlement", id: user.id },
            before: { entitlement: original },
            after: body.change,
          },
          affected: [
            {
              userId: user.id,
              before: effective(original),
              after: effective(body.change.entitlement),
            },
          ],
        });
      }
      if (path.endsWith("/apply")) {
        writes.push({ path, body: JSON.parse(init!.body as string) });
        return json({});
      }
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AdminPage page="users" />
      </UIProviders>
    </QueryClientProvider>,
  );
  return writes;
}
async function openEditor() {
  await owner.click(() =>
    screen.findByRole("button", { name: `更多操作 ${user.name}` }),
  );
  await owner.click(() => screen.getByRole("menuitem", { name: "授权与续期" }));
  await screen.findByLabelText("个人授权线路");
  owner.assertActive();
}
async function preview() {
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  return screen.findByRole("dialog", { name: "确认授权变更" });
}
function routeCells(review: HTMLElement) {
  const table = within(review).getByRole("table", {
    name: user.name,
  });
  const row = within(table)
    .getByRole("rowheader", { name: "授权线路" })
    .closest("tr")!;
  return within(row).getAllByRole("cell");
}
it("names legacy grants in saved and paired review without adding them to managed choices or changing IDs", async () => {
  const writes = mount();
  await openEditor();
  expect(screen.getByText(legacy.name, { exact: true })).toBeTruthy();
  await owner.click(() => screen.getByLabelText("暂停平台服务"));
  let review = await preview();
  await owner.click(() =>
    within(review).getByRole("checkbox", { name: "显示完整授权" }),
  );
  routeCells(review).forEach((cell) =>
    expect(within(cell).getByText(legacy.name, { exact: true })).toBeTruthy(),
  );
  expect(writes[0].body.change.entitlement.routeIdsOverride).toEqual([
    "invite-route",
  ]);
  await owner.click(() =>
    within(review).getByRole("button", { name: "返回编辑" }),
  );
  await owner.click(() => screen.getByLabelText("个人授权线路"));
  expect(screen.queryByRole("option", { name: legacy.name })).toBeNull();
  await owner.click(() => screen.getByRole("option", { name: managed.name }));
  // Close the multi-picker without modifying either stored selection.
  await owner.click(() => screen.getByLabelText("个人授权线路"));
  review = await preview();
  const cells = routeCells(review);
  expect(cells[0].textContent).toContain(legacy.name);
  expect(cells[1].textContent).toContain(legacy.name);
  expect(cells[1].textContent).toContain(managed.name);
  expect(writes[1].body.change.entitlement.routeIdsOverride).toEqual([
    "invite-route",
    "managed-route",
  ]);
  await owner.click(() =>
    within(review).getByRole("checkbox", { name: "我已核对本次授权变更" }),
  );
  await owner.click(() =>
    within(review).getByRole("button", { name: "更新授权" }),
  );
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[2].body.change).toEqual(writes[1].body.change);
});
it("does not guess a label for a legacy and managed identity collision or overwrite the managed choice", async () => {
  const writes = mount(true);
  await openEditor();
  expect(screen.queryByText(legacy.name, { exact: true })).toBeNull();
  expect(
    screen.getByRole("button", { name: `移除 ${managed.name}` }),
  ).toBeTruthy();
  await owner.click(() => screen.getByLabelText("个人授权线路"));
  expect(screen.getByRole("option", { name: managed.name })).toBeTruthy();
  expect(screen.queryByRole("option", { name: legacy.name })).toBeNull();
  await owner.click(() => screen.getByLabelText("个人授权线路"));
  await owner.click(() => screen.getByLabelText("暂停平台服务"));
  const review = await preview();
  await owner.click(() =>
    within(review).getByRole("checkbox", { name: "显示完整授权" }),
  );
  routeCells(review).forEach((cell) => {
    expect(
      within(cell).getByText("invite-route", { exact: true }),
    ).toBeTruthy();
    expect(cell.textContent).not.toContain(legacy.name);
    expect(cell.textContent).not.toContain(managed.name);
  });
  expect(writes[0].body.change.entitlement.routeIdsOverride).toEqual([
    "invite-route",
  ]);
});
