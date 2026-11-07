// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionLifecycle } from "./SessionLifecycle";
import { fleetCreationStorageKey, type FleetCreationRequest } from "./fleet-creation";
import { useFleetCreation } from "./useFleetCreation";

const input: FleetCreationRequest = { action: "configure", deploymentId: "path-a",
  targetIds: ["core-a"], stages: [["core-a"]], continuousService: false,
  expectedFingerprint: "a".repeat(64), leaseSeconds: 300 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function owner(actor = "admin-a") {
  const lifecycle = new SessionLifecycle();
  lifecycle.accept({ user: { id: actor, name: actor, role: "admin" }, csrfToken: "synthetic-csrf" });
  lifecycle.commit(lifecycle.getSnapshot().generation);
  return lifecycle;
}
function accepted(body: Record<string, unknown>, actorId = "admin-a") {
  return { ...body, actorId, fingerprint: body.expectedFingerprint,
    createdAt: "2026-11-07T12:00:00Z", status: "planned",
    affectedUsers: 0, supported: true, diagnostics: [], disruption: "May restart",
    targets: [{ instanceId: "core-a", stage: 0, status: "planned", attempts: [],
      nodeId: "node", name: "Core", adapterId: "routeweaver/xray", coreVersion: "26.10.31",
      affectedRouteIds: [], affectedUsers: 0, supported: true, diagnostics: [], changes: [], configDiff: [] }] };
}
beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("persists before sending, restores across remount and retries only the exact guarded body", async () => {
  const lifecycle = owner();
  const writes: { body: string; condition: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "POST") {
      expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).not.toBeNull();
      writes.push({ body: String(init.body), condition: new Headers(init.headers).get("If-None-Match") });
      throw new Error("response lost after commit");
    }
    expect(String(url)).toBe(`/api/admin/fleet-batches/${JSON.parse(writes[0].body).id}`);
    return json({ detail: "not found" }, 404);
  }));
  const first = renderHook(() => useFleetCreation(lifecycle));
  await act(async () => { await first.result.current.start(input); });
  expect(first.result.current.envelope).not.toBeNull();
  first.unmount();
  const second = renderHook(() => useFleetCreation(lifecycle));
  expect(writes).toHaveLength(1);
  await act(async () => { await second.result.current.lookup(); });
  expect(second.result.current.error).toContain("仍未确认");
  await act(async () => { await second.result.current.start({ ...input, deploymentId: "another" }); });
  expect(writes).toHaveLength(1);
  await act(async () => { await second.result.current.retry(); });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0].condition).toBe("*");
  expect(second.result.current.result).toBeNull();
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).not.toContain("synthetic-csrf");
});

it.for([409, 412, 422, 401, 503])("keeps previous uncertainty after a later %i response", async (status) => {
  let first = true;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (first) { first = false; throw new Error("lost"); }
    return json({ code: "FLEET_REVIEW_CHANGED" }, status);
  }));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  await act(async () => { await view.result.current.start(input); });
  const raw = sessionStorage.getItem(fleetCreationStorageKey("admin-a"));
  await act(async () => { await view.result.current.retry(); });
  expect(view.result.current.result).toBeNull();
  expect(view.result.current.reviewChanged).toBe(false);
  expect(view.result.current.error).toContain("尚未确认");
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).toBe(raw);
});

it("only resolves an initial typed changed-review refusal as noncreation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ code: "FLEET_REVIEW_CHANGED" }, 409)));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  await act(async () => { await view.result.current.start(input); });
  expect(view.result.current.reviewChanged).toBe(true);
  expect(view.result.current.envelope).toBeNull();
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).toBeNull();
});

it("rejects malformed success and identity mismatch, then adopts an exact read-only recovery", async () => {
  let body: Record<string, unknown> = {};
  let mismatch = true;
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push({ path: String(url), method: init?.method || "GET" });
    if (init?.method === "POST") { body = JSON.parse(String(init.body)); return json({ id: body.id }, 201); }
    return json(accepted(body, mismatch ? "another-admin" : "admin-a"));
  }));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  await act(async () => { await view.result.current.start(input); });
  expect(view.result.current.result).toBeNull();
  await act(async () => { await view.result.current.lookup(); });
  expect(view.result.current.result).toBeNull();
  mismatch = false;
  await act(async () => { await view.result.current.lookup(); });
  expect(view.result.current.result?.id).toBe(body.id);
  expect(view.result.current.result?.status).toBe("planned");
  expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "GET"]);
  expect(calls.every((call) => !/execute|retry|start|apply/.test(call.path))).toBe(true);
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).not.toBeNull();
  act(() => { expect(view.result.current.prepareClear()!()).toBe(true); });
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).toBeNull();
});

it("fails closed before sending when session storage cannot retain the request", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
  await act(async () => { await view.result.current.start(input); });
  expect(fetcher).not.toHaveBeenCalled();
  expect(view.result.current.error).toContain("尚未发送");
  expect(view.result.current.blocked).toBe(true);
});

it("retains a confirmed result if storage cleanup fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_, init) => json(accepted(JSON.parse(String(init?.body))), 201)));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  await act(async () => { await view.result.current.start(input); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage denied"); });
  act(() => { expect(view.result.current.prepareClear()!()).toBe(false); });
  expect(view.result.current.result?.status).toBe("planned");
  expect(view.result.current.envelope).not.toBeNull();
  expect(view.result.current.error).toContain("不会因此删除");
});

it("ignores stale actor responses and preserves each actor's request", async () => {
  let finish!: (response: Response) => void;
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (_, init) => {
    body = JSON.parse(String(init?.body));
    return new Promise<Response>((resolve) => { finish = resolve; });
  }));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.start(input); });
  act(() => {
    lifecycle.accept({ user: { id: "admin-b", name: "B", role: "admin" }, csrfToken: "other" });
    lifecycle.commit(lifecycle.getSnapshot().generation);
  });
  expect(view.result.current.envelope).toBeNull();
  await act(async () => { finish(json(accepted(body), 201)); await pending; });
  expect(view.result.current.result).toBeNull();
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).not.toBeNull();
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-b"))).toBeNull();
  view.unmount();
  const originalOwner = owner();
  const restored = renderHook(() => useFleetCreation(originalOwner));
  expect(restored.result.current.envelope?.actorId).toBe("admin-a");
  expect(restored.result.current.result).toBeNull();
});

it.for(["unmount", "session-change"] as const)("ignores a delayed accepted response after %s without deleting recovery", async (change) => {
  let finish!: (response: Response) => void;
  let body: Record<string, unknown> = {};
  const fetcher = vi.fn(async (_: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  vi.stubGlobal("fetch", fetcher);
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.start(input); });
  if (change === "unmount") view.unmount();
  else act(() => {
    lifecycle.accept({ user: { id: "admin-a", name: "A", role: "admin" }, csrfToken: "new-session" });
    lifecycle.commit(lifecycle.getSnapshot().generation);
  });
  await act(async () => { finish(json(accepted(body), 201)); await pending; });
  if (change === "session-change") {
    expect(view.result.current.result).toBeNull();
    view.unmount();
  }
  const restored = renderHook(() => useFleetCreation(lifecycle));
  expect(restored.result.current.envelope?.batchId).toBe(body.id);
  expect(restored.result.current.result).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not adopt a late response or clear storage owned by a newer request", async () => {
  let finish!: (response: Response) => void;
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (_, init) => {
    body = JSON.parse(String(init?.body));
    return new Promise<Response>((resolve) => { finish = resolve; });
  }));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.start(input); });
  const key = fleetCreationStorageKey("admin-a");
  const newer = JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)!), batchId: "batch_newer" });
  sessionStorage.setItem(key, newer);
  await act(async () => { finish(json(accepted(body), 201)); await pending; });
  expect(view.result.current.result).toBeNull();
  act(() => { expect(view.result.current.prepareClear()!()).toBe(false); });
  expect(sessionStorage.getItem(key)).toBe(newer);
});

it("binds delayed abandonment to the envelope and session shown at confirmation opening", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("lost"); }));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  await act(async () => { await view.result.current.start(input); });
  const oldDecision = view.result.current.prepareClear()!;
  const oldId = view.result.current.envelope!.batchId;
  act(() => { expect(view.result.current.prepareClear()!()).toBe(true); });
  await act(async () => { await view.result.current.start(input); });
  const newId = view.result.current.envelope!.batchId;
  expect(newId).not.toBe(oldId);
  act(() => { expect(oldDecision()).toBe(false); });
  expect(view.result.current.envelope!.batchId).toBe(newId);
  const sessionDecision = view.result.current.prepareClear()!;
  act(() => {
    lifecycle.accept({ user: { id: "admin-a", name: "A", role: "admin" }, csrfToken: "renewed" });
    lifecycle.commit(lifecycle.getSnapshot().generation);
  });
  act(() => { expect(sessionDecision()).toBe(false); });
  expect(JSON.parse(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))!).batchId).toBe(newId);
});

it("invalidates an open abandonment decision when another operation refreshes the same request", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (_, init) => {
    if (init?.method === "POST") { body = JSON.parse(String(init.body)); throw new Error("lost"); }
    return json(accepted(body));
  }));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  await act(async () => { await view.result.current.start(input); });
  const oldDecision = view.result.current.prepareClear()!;
  await act(async () => { await view.result.current.lookup(); });
  act(() => { expect(oldDecision()).toBe(false); });
  expect(view.result.current.result?.id).toBe(body.id);
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).not.toBeNull();
});

it("releases a hung old-session send for exact lookup and ignores its later catch/finally", async () => {
  let finishPost!: (response: Response) => void;
  let finishLookup!: (response: Response) => void;
  let body: Record<string, unknown> = {};
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    calls.push(`${init?.method || "GET"} ${url}`);
    if (init?.method === "POST") {
      body = JSON.parse(String(init.body));
      return new Promise<Response>((resolve) => { finishPost = resolve; });
    }
    return new Promise<Response>((resolve) => { finishLookup = resolve; });
  }));
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  let post!: Promise<void>;
  act(() => { post = view.result.current.start(input); });
  const raw = sessionStorage.getItem(fleetCreationStorageKey("admin-a"));
  expect(view.result.current.busy).toBe(true);
  act(() => {
    lifecycle.accept({ user: { id: "admin-a", name: "A", role: "admin" }, csrfToken: "renewed" });
    lifecycle.commit(lifecycle.getSnapshot().generation);
  });
  expect(view.result.current.busy).toBe(false);
  expect(view.result.current.envelope?.batchId).toBe(body.id);
  let lookup!: Promise<void> | undefined;
  act(() => { lookup = view.result.current.lookup(); });
  expect(calls).toEqual(["POST /api/admin/fleet-batches", `GET /api/admin/fleet-batches/${body.id}`]);
  expect(view.result.current.busy).toBe(true);
  // Even a typed first-send rejection is stale after the new session took over.
  await act(async () => { finishPost(json({ code: "FLEET_REVIEW_CHANGED" }, 409)); await post; });
  expect(view.result.current.busy).toBe(true);
  expect(view.result.current.reviewChanged).toBe(false);
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).toBe(raw);
  await act(async () => { finishLookup(json(accepted(body))); await lookup; });
  expect(view.result.current.busy).toBe(false);
  expect(view.result.current.result?.id).toBe(body.id);
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).toBe(raw);
});

it.for(["{broken", ""])("blocks malformed saved intent %j and never sends without a verified administrator", async (raw) => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  sessionStorage.setItem(fleetCreationStorageKey("admin-a"), raw);
  const lifecycle = owner();
  const view = renderHook(() => useFleetCreation(lifecycle));
  await act(async () => { await view.result.current.start(input); });
  expect(view.result.current.storageReady).toBe(false);
  expect(sessionStorage.getItem(fleetCreationStorageKey("admin-a"))).toBe(raw);
  const missing = renderHook(() => useFleetCreation(undefined));
  await act(async () => { await missing.result.current.start(input); });
  expect(fetcher).not.toHaveBeenCalled();
});
