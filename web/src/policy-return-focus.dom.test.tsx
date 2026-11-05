// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { UserPolicyEditor } from "./UserPolicyEditor";
import { GroupPolicyEditor } from "./GroupPolicyEditor";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import { entitlementEditFixture } from "./test-support/entitlement-edit-fixture";
import { groupEditFixture } from "./test-support/group-edit-fixture";
import type { EffectivePolicy } from "./access-policy-model";

const plan = {
  id: "plan",
  name: "办公方案",
  quotaBytes: 100 * 1024 ** 3,
  routeIds: [],
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  cycle: {
    mode: "monthly",
    day: 1,
    anchor: "2026-01-01T00:00:00Z",
    timezone: "UTC+8",
  },
};
const user = {
  id: "user",
  name: "林晓",
  enabled: true,
  quotaBytes: 0,
  usedBytes: 0,
};
const group = {
  id: "group",
  name: "办公组",
  serviceId: plan.id,
  priority: 1,
  memberIds: [],
};
const policy: EffectivePolicy = {
  userId: user.id,
  serviceId: plan.id,
  service: plan,
  groupIds: [],
  routeIds: [],
  quotaBytes: plan.quotaBytes,
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  status: "active",
  provenance: { service: "individual", quotaBytes: "service:plan" },
  entitlement: {
    userId: user.id,
    serviceId: plan.id,
    startsAt: "2026-01-01T00:00:00Z",
    paused: false,
    cycle: plan.cycle,
  },
};
const clients: QueryClient[] = [];
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
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
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

for (const kind of ["service", "user", "group"] as const) {
  it.each(["clean", "discard", "rebase", "apply"] as const)(
    `returns the ${kind} loading-to-editor task to its original opener (%s)`,
    async (mode) => {
      const discard = mode !== "clean";
      let release!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const context =
        kind === "service"
          ? serviceEditFixture(plan).context()
          : kind === "group"
            ? groupEditFixture(group).context()
            : entitlementEditFixture(policy).context();
      const path = `/api/access-policy/edit-context/${context.target.kind}/${context.target.id}`;
      const requests: string[] = [];
      let reads = 0;
      const closeWithConfirmation: boolean[] = [];
      const closeWithReview: boolean[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = init?.method || "GET";
          requests.push(`${method} ${url}`);
          if (method === "GET" && url === path) {
            reads++;
            return reads === 1
              ? pending
              : json({
                  ...context,
                  precondition: {
                    ...context.precondition,
                    revision: "latest-context",
                  },
                });
          }
          if (
            mode === "apply" &&
            method === "POST" &&
            url === "/api/access-policy/preview"
          ) {
            const { change } = JSON.parse(String(init?.body));
            const review = {
              revision: "apply-review",
              affected: [],
              blockers: [],
            };
            return json(
              kind === "service"
                ? serviceEditFixture(plan).preview(change.service, review)
                : kind === "group"
                  ? groupEditFixture(group).preview(change.group, review)
                  : entitlementEditFixture(policy).preview(
                      change.entitlement,
                      review,
                    ),
            );
          }
          if (
            mode === "apply" &&
            method === "POST" &&
            url === "/api/access-policy/apply"
          )
            return json({});
          if (
            mode === "rebase" &&
            method === "POST" &&
            url === "/api/access-policy/preview"
          )
            return new Response(
              JSON.stringify({ error: "保存版本已变化，请核对最新版本。" }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          if (
            method === "GET" &&
            url === `/api/users/${user.id}/admission-status`
          )
            return json({
              asOf: "2026-11-05T00:00:00Z",
              maxLeaseSeconds: 60,
              onlineIps: [],
              activeStreams: 0,
              entries: [],
            });
          throw new Error(`Unexpected request: ${method} ${url}`);
        }),
      );
      function Host() {
        const [open, setOpen] = useState(false);
        const props = {
          users: [user],
          services: [plan],
          routes: [],
          onClose: () => {
            closeWithConfirmation.push(
              !!document.querySelector('[role="alertdialog"]'),
            );
            closeWithReview.push(
              !!screen.queryByRole("dialog", { name: "确认授权变更" }),
            );
            setOpen(false);
          },
        };
        return (
          <>
            <button onClick={() => setOpen(true)}>编辑对象</button>
            {open &&
              (kind === "service" ? (
                <ServicePolicyEditor {...props} initial={plan} />
              ) : kind === "group" ? (
                <GroupPolicyEditor {...props} initial={group} />
              ) : (
                <UserPolicyEditor {...props} user={user} />
              ))}
          </>
        );
      }
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
            <Host />
          </UIProviders>
        </QueryClientProvider>,
      );
      const actor = userEvent.setup();
      const opener = screen.getByRole("button", { name: "编辑对象" });
      try {
        await actor.click(opener);
        const loading = await screen.findByRole("dialog");
        await waitFor(() =>
          expect(loading.contains(document.activeElement)).toBe(true),
        );
        expect(screen.queryByRole("button", { name: "预览影响" })).toBeNull();
        await act(async () => {
          release(json(context));
        });
        await screen.findByRole("button", { name: "预览影响" });
        let editor = screen.getByRole("dialog");
        if (discard) {
          if (kind === "user")
            await actor.click(
              within(editor).getByRole("switch", { name: "暂停平台服务" }),
            );
          else
            await actor.type(
              within(editor).getByRole("textbox", {
                name: kind === "service" ? "服务方案名称" : "用户组名称",
              }),
              "修改",
            );
        }
        if (mode === "rebase") {
          await actor.click(
            within(editor).getByRole("button", { name: "预览影响" }),
          );
          await actor.click(
            await screen.findByRole("button", { name: "查看最新版本" }),
          );
          await actor.click(
            await screen.findByRole("button", { name: "使用最新版本重新编辑" }),
          );
          const decision = await screen.findByRole("alertdialog");
          await actor.click(
            within(decision).getByRole("button", { name: "使用最新版本" }),
          );
          await waitFor(() =>
            expect(screen.queryByRole("alertdialog")).toBeNull(),
          );
          editor = screen.getByRole("dialog");
          await within(editor).findByRole("button", {
            name:
              kind === "user"
                ? "保留的草稿 1（未保存）"
                : "上一版草稿（未保存）",
          });
        }
        if (mode === "apply") {
          await actor.click(
            within(editor).getByRole("button", { name: "预览影响" }),
          );
          const review = await screen.findByRole("dialog", {
            name: "确认授权变更",
          });
          await actor.click(
            within(review).getByRole("checkbox", {
              name: "我已核对本次授权变更",
            }),
          );
          await actor.click(
            within(review).getByRole("button", { name: "更新授权" }),
          );
        } else {
          const cancel = within(editor).getByRole("button", { name: "取消" });
          await actor.click(cancel);
          if (discard) {
            let decision = await screen.findByRole("alertdialog");
            await actor.click(
              within(decision).getByRole("button", { name: "继续编辑" }),
            );
            await waitFor(() => expect(document.activeElement).toBe(cancel));
            await actor.click(cancel);
            decision = await screen.findByRole("alertdialog");
            await actor.click(
              within(decision).getByRole("button", { name: "放弃修改" }),
            );
          }
        }
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() =>
          expect(screen.queryByRole("alertdialog")).toBeNull(),
        );
        await waitFor(() => expect(document.activeElement).toBe(opener));
        expect(closeWithConfirmation).toEqual([false]);
        expect(closeWithReview).toEqual([false]);
        expect(
          requests.filter((request) => !request.startsWith("GET ")),
        ).toEqual(
          mode === "apply"
            ? [
                "POST /api/access-policy/preview",
                "POST /api/access-policy/apply",
              ]
            : mode === "rebase"
              ? ["POST /api/access-policy/preview"]
              : [],
        );
      } finally {
        await act(async () => {
          release(json(context));
        });
      }
    },
  );
}

it.each(["service", "group"] as const)(
  "keeps the original %s opener when restarting creation with a new identity",
  async (kind) => {
    const identities: string[] = [];
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method && init.method !== "GET")
          writes.push(`${init.method} ${url}`);
        const prefix = `/api/access-policy/edit-context/${kind}/`;
        if (!url.startsWith(prefix))
          throw new Error(`Unexpected request: ${url}`);
        const id = url.slice(prefix.length);
        identities.push(id);
        if (identities.length === 1)
          return json(
            kind === "service"
              ? serviceEditFixture({ ...plan, id }).context()
              : groupEditFixture({ ...group, id }).context(),
          );
        return json({
          target: { kind, id },
          record: null,
          precondition: { exists: false, revision: "new-identity-context" },
        });
      }),
    );
    function Host() {
      const [open, setOpen] = useState(false);
      const props = {
        initial: null,
        users: [user],
        services: [plan],
        routes: [],
        onClose: () => setOpen(false),
      };
      return (
        <>
          <button onClick={() => setOpen(true)}>新建对象</button>
          {open &&
            (kind === "service" ? (
              <ServicePolicyEditor {...props} />
            ) : (
              <GroupPolicyEditor {...props} />
            ))}
        </>
      );
    }
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
          <Host />
        </UIProviders>
      </QueryClientProvider>,
    );
    const actor = userEvent.setup();
    const opener = screen.getByRole("button", { name: "新建对象" });
    await actor.click(opener);
    await actor.click(
      await screen.findByRole("button", { name: "使用新标识重新新建" }),
    );
    await screen.findByRole("button", { name: "预览影响" });
    await actor.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(identities).toHaveLength(2);
    expect(identities[0]).not.toBe(identities[1]);
    expect(writes).toEqual([]);
  },
);
