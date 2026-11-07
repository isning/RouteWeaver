// @vitest-environment jsdom
// Source-only reconstruction: these regression scenarios have NOT been executed.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "./components";
import { usePolicyChange } from "./AccessPolicy";
import { request } from "./api";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import type { PolicyChange } from "./access-policy-model";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

type Owner = ReturnType<typeof ownedClickScenario>;
let currentOwner: Owner;
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const detail = "policy applied; audit could not be recorded";
const warning = "平台授权已更新，但审计记录未能保存。请核对最新授权和审计记录，不要重复提交本次变更。当前输入和保留的草稿未清除。";
const retained = [{ name: "Earlier draft" }];
const policyKeys = ["admin-state", "user-groups", "effective-policy", "entitlement", "overview", "platform-entries"];
const changes: PolicyChange[] = [
  { service: { id: "s1", name: "Service draft", quotaBytes: 0, routeIds: [], onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0, cycle: { mode: "none", anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" } } },
  { group: { id: "g1", name: "Group draft", serviceId: "s1", priority: 1, memberIds: [] } },
  { entitlement: { userId: "u1", serviceId: "s1", startsAt: "2026-01-01T00:00:00Z", cycle: { mode: "none", anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" } } },
];
beforeEach((context) => {
  currentOwner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  vi.unstubAllEnvs();
});
function mount(owner: Owner, children: ReactNode) {
  owner.assertActive();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const wrap = (value: ReactNode) => (
    <QueryClientProvider client={client}>

        <UIProviders>{value}</UIProviders>

    </QueryClientProvider>
  );
  const result = render(wrap(children));
  return {
    unmount: result.unmount,
    rerender: (value: ReactNode) => {
      owner.assertActive();
      result.rerender(wrap(value));
    },
  };
}

function Observation({ name }: { name: string }) {
  const query = useQuery({ queryKey: [name], queryFn: () => request<{ value: string }>(`/observations/${name}`), staleTime: Infinity });
  return <p>{name}: {query.data?.value || "loading"}</p>;
}
function Editor({ change = changes[0] }: { change?: PolicyChange }) {
  const [draft, setDraft] = useState("Current draft");
  const [closed, setClosed] = useState(false);
  const policy = usePolicyChange({ mode: "legacy-replacement", retainedDrafts: retained, users: [{ id: "u1", name: "Alice" }], services: [], routes: [], onApplied: () => setClosed(true) });
  if (closed) return <p>Editor closed</p>;
  return <>
    <label>Draft<input value={draft} onChange={event => { setDraft(event.target.value); policy.clearError(); }} /></label>
    <p>{retained[0].name}</p>
    <ErrorNotice error={policy.error} focusRef={policy.errorFocusRef} />
    <Button onClick={() => policy.propose(change)}>预览影响</Button>
    {policy.dialog}
  </>;
}
function Observations() {
  return <>{policyKeys.map(name => <Observation key={name} name={name} />)}</>;
}
// Preserve visibility assertions without an undeclared jest-dom matcher.
// jsdom observes these DOM/CSS states, not rendered pixels or layout.
function expectVisible(element: HTMLElement) {
  expect(element.ownerDocument.documentElement.contains(element)).toBe(true);
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    expect(style.display).not.toBe("none");
    expect(["hidden", "collapse"]).not.toContain(style.visibility);
    expect(style.opacity).not.toBe("0");
    expect(node.hidden).toBe(false);
    if (node instanceof HTMLDetailsElement && !node.open) {
      const summary = node.querySelector(":scope > summary");
      expect(summary?.contains(element)).toBe(true);
    }
  }
}
async function apply(owner: Owner) {
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  const dialog = within(await screen.findByRole("dialog", { name: "确认授权变更" }));
  owner.assertActive();
  await owner.click(() => dialog.getByRole("checkbox", { name: "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃保留的未保存草稿副本" }));
  await owner.click(() => dialog.getByRole("button", { name: "更新授权" }));
}
function transport(reply: () => Response | Promise<Response>) {
  let saved = false;
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    if (path.startsWith("/api/observations/")) return json({ value: saved ? "updated" : "before" });
    if (path === "/api/access-policy/preview") return json({ revision: "review-v1", affected: [], blockers: [] });
    if (path === "/api/access-policy/apply") {
      writes.push(init!.body as string);
      const response = await reply();
      saved = response.status === 500 || response.ok;
      return response;
    }
    throw new Error(`Unexpected request: ${path}`);
  }));
  return writes;
}

it.each(changes)("retires the committed review and preserves drafts after audit failure: %j", async change => {
  const owner = currentOwner;
  const writes = transport(() => json({ detail }, 500));
  mount(owner, <><Editor change={change} /><Observations /></>);
  await screen.findByText("admin-state: before");
  owner.change(() => screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Edited draft" } });
  await apply(owner);
  await screen.findByText(warning);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull());
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLInputElement).value).toBe("Edited draft");
  expectVisible(screen.getByText("Earlier draft"));
  expect(screen.queryByText("Editor closed")).toBeNull();
  expect(screen.queryByRole("button", { name: "更新授权" })).toBeNull();
  for (const key of policyKeys) await screen.findByText(`${key}: updated`);
  expect(writes).toEqual([JSON.stringify({ change, revision: "review-v1" })]);
  // A deliberate new review needs fresh consent; the consumed apply is gone.
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  const dialog = within(await screen.findByRole("dialog", { name: "确认授权变更" }));
  expect(dialog.getByRole("button", { name: "更新授权" }).matches(":disabled")).toBe(true);
  expect(writes).toHaveLength(1);
});

it.each([
  [500, { message: detail }],
  [500, { error: detail }],
  [503, { detail }],
  [500, { detail: `${detail}.` }],
  [500, { detail: "database unavailable" }],
] as const)("does not infer a commit from status %s and payload %j", async (status, payload) => {
  const owner = currentOwner;
  transport(() => json(payload, status));
  mount(owner, <Editor />);
  await apply(owner);
  await waitFor(() => expect(screen.getByRole("dialog", { name: "确认授权变更" }).querySelector('[role="alert"]')).not.toBeNull());
  expect(screen.queryByText(warning)).toBeNull();
  expect(screen.queryByText("Editor closed")).toBeNull();
});

it("does not infer a commit from a network exception containing the same words", async () => {
  const owner = currentOwner;
  transport(() => { throw new Error(detail); });
  mount(owner, <Editor />);
  await apply(owner);
  await screen.findByText(detail);
  expect(screen.queryByText(warning)).toBeNull();
  expectVisible(screen.getByRole("dialog", { name: "确认授权变更" }));
});

it("refreshes committed policy without disturbing a replacement editor after the old owner unmounts", async () => {
  const owner = currentOwner;
  let settle!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { settle = resolve; });
  const writes = transport(() => pending);
  const view = mount(owner, <><Editor key="old" /><Observations /></>);
  await screen.findByText("admin-state: before");
  await apply(owner);
  view.rerender(<><Editor key="new" /><Observations /></>);
  await act(async () => { settle(json({ detail }, 500)); await pending; });
  for (const key of policyKeys) await screen.findByText(`${key}: updated`);
  expect(screen.queryByText(warning)).toBeNull();
  expect(screen.queryByText("Editor closed")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLInputElement).value).toBe("Current draft");
  expect(writes).toHaveLength(1);
});

it("still closes the editor after a complete successful apply", async () => {
  const owner = currentOwner;
  transport(() => json({ revision: "applied-v2", affected: [], blockers: [] }));
  mount(owner, <Editor />);
  await apply(owner);
  await screen.findByText("Editor closed");
  expect(screen.queryByText(warning)).toBeNull();
});


it("returns the guarded service editor to its audit warning without clearing input or closing", async () => {
  const owner = currentOwner;
  const service = changes[0].service!;
  const fixture = serviceEditFixture(service);
  let closed = false;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    if (path === "/api/access-policy/edit-context/service/s1") return json(fixture.context());
    if (path === "/api/access-policy/preview") {
      const body = JSON.parse(init!.body as string);
      return json(fixture.preview(body.change.service, { revision: "guarded-review", affected: [], blockers: [] }));
    }
    if (path === "/api/access-policy/apply") return json({ detail }, 500);
    throw new Error(`Unexpected request: ${path}`);
  }));
  mount(owner, <ServicePolicyEditor initial={service} services={[service]} users={[]} routes={[]} onClose={() => { closed = true; }} />);
  await screen.findByRole("textbox", { name: "服务方案名称" });
  owner.change(() => screen.getByRole("textbox", { name: "服务方案名称" }), { target: { value: "Preserved service name" } });
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  const review = within(await screen.findByRole("dialog", { name: "确认授权变更" }));
  await owner.click(() => review.getByRole("checkbox", { name: "我已核对本次授权变更" }));
  await owner.click(() => review.getByRole("button", { name: "更新授权" }));
  await screen.findByText(warning);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull());
  expect((screen.getByRole("textbox", { name: "服务方案名称" }) as HTMLInputElement).value).toBe("Preserved service name");
  expect(closed).toBe(false);
  const summary = screen.getByRole("group", { name: "操作未完成", description: warning });
  await waitFor(() => expect(document.activeElement).toBe(summary));
});


it("refreshes policy without overwriting a newer draft owned by the same mounted caller", async () => {
  const owner = currentOwner;
  let settle!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { settle = resolve; });
  const writes = transport(() => pending);
  mount(owner, <><Editor /><Observations /></>);
  await screen.findByText("admin-state: before");
  await apply(owner);
  // Exercise the exported hook's consumer-driven draft invalidation while an
  // apply is in flight. This is not a claim that a modal permits background typing.
  owner.change(() => screen.getByLabelText("Draft"), { target: { value: "Newer local draft" } });
  await act(async () => { settle(json({ detail }, 500)); await pending; });
  for (const key of policyKeys) await screen.findByText(`${key}: updated`);
  expect(screen.queryByText(warning)).toBeNull();
  expect(screen.queryByText("Editor closed")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLInputElement).value).toBe("Newer local draft");
  expect(writes).toHaveLength(1);
});
