// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionBoundary } from "./SessionBoundary";
import { setCSRF, setToken } from "./api";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const session = (id = "A", role = "user", csrfToken = "csrf-A") => ({ user: { id, name: `Account ${id}`, role }, csrfToken });
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development"); setToken(""); setCSRF("");
  vi.stubGlobal("BroadcastChannel", class { addEventListener() {} postMessage() {} close() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(async () => { await act(async () => { cleanup(); clients.splice(0).forEach(c => c.clear()); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
type OwnerState = { removed?: boolean; hidden?: boolean; disabled?: boolean; idle?: boolean };
async function task(kind: "button" | "status" = "status") {
  let focused = true, hold = false; const replies: ((r: Response) => void)[] = []; const reads: string[] = [];
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.stubGlobal("fetch", vi.fn(async (url) => { reads.push(String(url)); if (!String(url).endsWith("/auth/me")) throw new Error("Unexpected request"); return hold ? new Promise<Response>(resolve => replies.push(resolve)) : json(session()); }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  const tree = (state: OwnerState = {}) => <StrictMode><QueryClientProvider client={client}><UIProviders><button>Outside safe action</button><SessionBoundary login={() => <p>Sign in again</p>}><div>
    {!state.removed && (kind === "button" ? <button hidden={state.hidden} disabled={state.disabled} tabIndex={state.idle ? -1 : 0}>Continue task</button> : <div role="status" hidden={state.hidden} aria-disabled={state.disabled || undefined} tabIndex={state.idle ? -1 : 0}>{state.idle ? "" : "正在创建待执行批次…"}</div>)}
    <label>Draft name<input defaultValue="Keep my place" /></label>
  </div></SessionBoundary></UIProviders></QueryClientProvider></StrictMode>;
  const view = render(tree());
  const owner = kind === "button" ? await screen.findByRole("button", { name: "Continue task" }) : await screen.findByText("正在创建待执行批次…");
  await waitFor(() => expect(owner.closest("[inert]")).toBeNull());
  const workspace = owner.closest("[data-session-workspace]")!;
  const outside = screen.getByRole("button", { name: "Outside safe action" });
  act(() => owner.focus());
  return { owner, workspace, outside, reads, view,
    update: (state: OwnerState) => view.rerender(tree(state)),
    depart: (options: { actualBlur?: boolean; interrupt?: boolean; keyUpBeforeBlur?: boolean } = {}) => act(() => {
      // JSDOM has no browser chrome. Replay the measured public event order and
      // document-focus boundary; the separate Chromium task proves real trusted events.
      fireEvent.keyDown(owner, { key: "Tab" }); owner.blur();
      if (options.interrupt) fireEvent.pointerDown(outside);
      if (options.keyUpBeforeBlur) fireEvent.keyUp(document.body, { key: "Tab" });
      if (options.actualBlur !== false) { focused = false; fireEvent(window, new Event("blur")); }
      fireEvent.keyUp(document.body, { key: "Tab" });
    }),
    returnForCheck: async () => { hold = true; act(() => { focused = true; fireEvent(window, new Event("focus")); }); await waitFor(() => expect(workspace.hasAttribute("inert")).toBe(true)); },
    reply: async (response = json(session())) => { await act(async () => replies.shift()!(response)); },
    active: async () => { await waitFor(() => expect(document.querySelector("[data-session-workspace]")?.getAttribute("aria-busy")).toBe("false")); },
    retry: async () => { hold = false; act(() => fireEvent(window, new Event("focus"))); await waitFor(() => expect(document.querySelector("[data-session-workspace]")?.getAttribute("aria-busy")).toBe("false")); },
  };
}
it.for(["status", "button"] as const)("continues the exact departed %s after same-session BODY return", async kind => {
  const t = await task(kind); t.depart(); expect(document.activeElement).toBe(document.body);
  await t.returnForCheck(); expect(t.owner.closest("[inert]")).not.toBeNull(); await t.reply(); await t.active();
  expect(t.owner.closest("[data-session-workspace]")).toBe(t.workspace); await waitFor(() => expect(document.activeElement).toBe(t.owner));
});
it.for(["account", "role", "csrf"] as const)("does not restore a departed owner after changed %s", async change => {
  const t = await task(); t.depart(); await t.returnForCheck();
  await t.reply(json(change === "account" ? session("B") : change === "role" ? session("A", "admin") : session("A", "user", "csrf-new"))); await t.active();
  expect(document.activeElement).not.toBe(t.owner);
});
it.for(["removed", "hidden", "disabled", "idle"] as const)("does not restore a %s departed owner", async change => {
  const t = await task(); t.depart(); await t.returnForCheck(); t.update({ [change]: true }); await t.reply(); await t.active();
  expect(document.activeElement).not.toBe(t.owner);
});
it.for([false, true])("does not steal newer focus even when it later returns BODY: %s", async returnToBody => {
  const t = await task(); t.depart(); await t.returnForCheck(); act(() => { t.outside.focus(); if (returnToBody) t.outside.blur(); }); await t.reply(); await t.active(); expect(document.activeElement).toBe(returnToBody ? document.body : t.outside);
});
it("does not restore after a newer pointer intent while verification is pending", async () => {
  const t = await task(); t.depart(); await t.returnForCheck(); fireEvent.pointerDown(t.outside); await t.reply(); await t.active(); expect(document.activeElement).toBe(document.body);
});
it("does not promote a completed Tab gesture into a later window departure", async () => {
  const t = await task(); t.depart({ keyUpBeforeBlur: true }); await t.returnForCheck(); await t.reply(); await t.active(); expect(document.activeElement).not.toBe(t.owner);
});
it.for(["no-window-departure", "intervening-pointer"] as const)("does not revive %s as departure ownership", async reason => {
  const t = await task(); t.depart(reason === "no-window-departure" ? { actualBlur: false } : { interrupt: true }); await t.returnForCheck(); await t.reply(); await t.active(); expect(document.activeElement).not.toBe(t.owner);
});
it.for(["offline", "failed-check"] as const)("discards departure ownership on %s before later recovery", async reason => {
  const t = await task(); t.depart(); await t.returnForCheck();
  if (reason === "offline") act(() => fireEvent(window, new Event("offline")));
  else await t.reply(json({ error: "Unavailable" }, 503));
  await waitFor(() => expect(t.workspace.hasAttribute("hidden")).toBe(true)); await t.retry(); expect(document.activeElement).not.toBe(t.owner);
});
it("does not restore an unmounted workspace after verification completes", async () => {
  const t = await task(); t.depart(); await t.returnForCheck(); t.view.unmount(); await t.reply(); expect(t.owner.isConnected).toBe(false); expect(document.activeElement).not.toBe(t.owner);
});
it("preserves direct in-workspace input focus and selection during routine verification", async () => {
  const t = await task("button"), input = screen.getByLabelText("Draft name") as HTMLInputElement;
  act(() => { input.focus(); input.setSelectionRange(2, 5); }); await t.returnForCheck(); act(() => input.blur()); await t.reply(); await t.active();
  expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
});
