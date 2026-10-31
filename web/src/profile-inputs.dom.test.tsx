// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  useEffectiveProfileInputs,
  type ProfileInputCatalog,
} from "./profile-inputs";
import { emptyProfile } from "./model";
import type { ClientNode, Collection, Profile, Source } from "./types";

const node = (id: string, name = id): ClientNode => ({
  id,
  name,
  origin: "imported",
  connection: { protocol: "socks", host: `${id}.example.test`, port: 1080 },
});
const source: Source = {
  id: "airport",
  name: "Airport",
  kind: "text",
  enabled: true,
  revision: "one",
  snapshot: { endpoints: [node("dropped"), node("london"), node("tokyo")] },
};
const collection: Collection = {
  id: "daily",
  name: "Daily",
  sources: [{ sourceId: "airport", steps: [] }],
  steps: [
    {
      id: "filter",
      kind: "drop",
      enabled: true,
      filter: { namePattern: "dropped" },
    },
    { id: "rename", kind: "rename", enabled: true, template: "Daily {name}" },
    {
      id: "sort",
      kind: "sort",
      enabled: true,
      sortBy: "name",
      descending: true,
    },
  ],
};
const catalog = <T,>(data: T[], dataUpdatedAt = 1): ProfileInputCatalog<T> => ({
  data,
  dataUpdatedAt,
  isPending: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(async () => undefined),
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
function mount(
  profile: Profile,
  sources = catalog([source]),
  collections = catalog([collection]),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ profile, sources, collections }) =>
      useEffectiveProfileInputs(profile, sources, collections),
    {
      wrapper,
      initialProps: { profile, sources, collections },
    },
  );
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

it("uses the authority's filtered, renamed, ordered collection result rather than raw snapshots or extra source IDs", async () => {
  const profile = {
    ...emptyProfile(),
    collectionId: "daily",
    sourceIds: ["ignored"],
  };
  const fetcher = vi.fn(async () =>
    json({
      endpoints: [node("tokyo", "Daily Tokyo"), node("london", "Daily London")],
      stages: [
        { scope: "aggregate", endpoints: [], diagnostics: ["Processing note"] },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { result } = mount(profile);
  expect(result.current.status).toBe("pending");
  expect(result.current.endpoints).toEqual([]);
  await waitFor(() => expect(result.current.status).toBe("success"));
  expect(result.current.mode).toBe("collection");
  expect(result.current.endpoints.map((n) => [n.id, n.name])).toEqual([
    ["tokyo", "Daily Tokyo"],
    ["london", "Daily London"],
  ]);
  expect(result.current.diagnostics).toEqual(["Processing note"]);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/me/collections/daily/preview");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({});
});

it("distinguishes unavailable inputs from an authoritative empty result and preserves existing group references through retry", async () => {
  const profile = { ...emptyProfile(), collectionId: "daily" };
  profile.ir.groups = [
    {
      id: "route",
      name: "Route",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "dropped" }],
    },
  ];
  profile.ir.endpoints = [node("stale-ir")];
  const original = structuredClone(profile);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({ error: "source has no enabled accepted snapshot" }, 400),
    )
    .mockResolvedValueOnce(json({ endpoints: [], stages: [] }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = mount(profile);
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.endpoints).toEqual([]);
  expect(result.current.error?.message).toBe(
    "source has no enabled accepted snapshot",
  );
  expect(result.current.diagnostics).toEqual([
    "source has no enabled accepted snapshot",
  ]);
  expect(profile).toEqual(original);
  await act(async () => {
    await result.current.retry();
  });
  await waitFor(() => expect(result.current.status).toBe("empty"));
  expect(result.current.endpoints).toEqual([]);
  expect(result.current.error).toBeNull();
  expect(profile).toEqual(original);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("never shows a late response for an earlier collection selection", async () => {
  const earlier = deferred<Response>(),
    later = deferred<Response>();
  const nextCollection = { ...collection, id: "travel" };
  const sources = catalog([source]),
    collections = catalog([collection, nextCollection]);
  const profile = { ...emptyProfile(), collectionId: "daily" };
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
    void init;
    return fetcher.mock.calls.length === 1 ? earlier.promise : later.promise;
  });
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = mount(profile, sources, collections);
  rerender({
    profile: { ...profile, collectionId: "travel" },
    sources,
    collections,
  });
  expect(result.current.status).toBe("pending");
  expect(result.current.endpoints).toEqual([]);
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => {
    later.resolve(json({ endpoints: [node("travel-choice")], stages: [] }));
  });
  await waitFor(() => expect(result.current.status).toBe("success"));
  await act(async () => {
    earlier.resolve(
      json({ endpoints: [node("wrong-daily-choice")], stages: [] }),
    );
  });
  expect(result.current.endpoints.map((n) => n.id)).toEqual(["travel-choice"]);
});

it("re-resolves after source and collection revisions and hides previous choices while either is pending", async () => {
  const second = deferred<Response>(),
    third = deferred<Response>();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({ endpoints: [node("before-refresh")], stages: [] }),
    )
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  vi.stubGlobal("fetch", fetcher);
  const profile = { ...emptyProfile(), collectionId: "daily" };
  const initialSources = catalog([source]),
    collections = catalog([collection]);
  const { result, rerender } = mount(profile, initialSources, collections);
  await waitFor(() => expect(result.current.status).toBe("success"));
  const newerSources = catalog([{ ...source, revision: "two" }]);
  rerender({ profile, sources: newerSources, collections });
  expect(result.current.status).toBe("pending");
  expect(result.current.endpoints).toEqual([]);
  const newerCollections = catalog([{ ...collection, steps: [] }]);
  rerender({ profile, sources: newerSources, collections: newerCollections });
  expect(result.current.status).toBe("pending");
  await act(async () => {
    third.resolve(json({ endpoints: [node("new-recipe-choice")], stages: [] }));
  });
  await waitFor(() => expect(result.current.status).toBe("success"));
  await act(async () => {
    second.resolve(
      json({ endpoints: [node("old-recipe-choice")], stages: [] }),
    );
  });
  expect(result.current.endpoints.map((n) => n.id)).toEqual([
    "new-recipe-choice",
  ]);
  // Catalog invalidation itself must also hide a previously resolved result.
  rerender({
    profile,
    sources: { ...newerSources, isFetching: true },
    collections: newerCollections,
  });
  expect(result.current.status).toBe("pending");
  expect(result.current.endpoints).toEqual([]);
});

it("resolves direct sources in selection order without collection processing or stale IR fallback", async () => {
  const fetcher = vi.fn(async () =>
    json({
      endpoints: [node("second-choice"), node("first-choice")],
      stages: [],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const profile = { ...emptyProfile(), sourceIds: ["second", "first"] };
  profile.ir.endpoints = [node("obsolete-materialization")];
  const collections = {
    ...catalog<Collection>([]),
    error: new Error("unrelated collection request failed"),
  };
  const { result } = mount(
    profile,
    catalog([
      { ...source, id: "first" },
      { ...source, id: "second" },
    ]),
    collections,
  );
  await waitFor(() => expect(result.current.status).toBe("success"));
  expect(result.current.mode).toBe("sources");
  expect(result.current.endpoints.map((n) => n.id)).toEqual([
    "second-choice",
    "first-choice",
  ]);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/me/collections/preview");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({
    id: "profile-sources",
    name: "Profile sources",
    sources: [
      { sourceId: "second", steps: [] },
      { sourceId: "first", steps: [] },
    ],
    steps: [],
  });
  expect(profile.ir.endpoints.map((n) => n.id)).toEqual([
    "obsolete-materialization",
  ]);
});

it("keeps manual IR inputs local and does not confuse catalog failures with manual-input emptiness", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const profile = emptyProfile();
  profile.ir.endpoints = [node("manual", "My manual connection")];
  const sources = {
    ...catalog<Source>([]),
    error: new Error("catalog unavailable"),
  };
  const collections = { ...catalog<Collection>([]), isPending: true };
  const { result, rerender } = mount(profile, sources, collections);
  expect(result.current.mode).toBe("manual");
  expect(result.current.status).toBe("success");
  expect(result.current.endpoints).toEqual([
    node("manual", "My manual connection"),
  ]);
  rerender({
    profile: { ...profile, ir: { ...profile.ir, endpoints: [] } },
    sources,
    collections,
  });
  expect(result.current.status).toBe("empty");
  expect(result.current.error).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it("shows catalog loading and failure explicitly, retries catalogs, and never substitutes raw nodes for a missing collection", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const profile = { ...emptyProfile(), collectionId: "daily" };
  const sources = { ...catalog([source]), isPending: true };
  const collections = catalog<Collection>([]);
  const { result, rerender } = mount(profile, sources, collections);
  expect(result.current.status).toBe("pending");
  const failedSources = {
    ...sources,
    isPending: false,
    error: new Error("Cannot load sources"),
  };
  rerender({ profile, sources: failedSources, collections });
  expect(result.current.status).toBe("error");
  expect(result.current.error?.message).toBe("Cannot load sources");
  await act(async () => {
    await result.current.retry();
  });
  expect(sources.refetch).toHaveBeenCalled();
  expect(collections.refetch).toHaveBeenCalled();
  rerender({ profile, sources: { ...sources, isPending: false }, collections });
  expect(result.current.status).toBe("error");
  expect(result.current.error?.message).toContain("集合已不可用");
  expect(result.current.endpoints).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects a missing endpoint result rather than labelling an unavailable preview as zero connections", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ stages: [] })),
  );
  const { result } = mount({ ...emptyProfile(), collectionId: "daily" });
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.error?.message).toContain("未返回有效的连接结果");
  expect(result.current.endpoints).toEqual([]);
});

it("rechecks the authority when the source catalog is refreshed even without explicit source revision fields", async () => {
  const refreshed = deferred<Response>();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({ endpoints: [node("old-snapshot")], stages: [] }),
    )
    .mockReturnValueOnce(refreshed.promise);
  vi.stubGlobal("fetch", fetcher);
  const noRevision = { ...source, revision: undefined };
  const profile = { ...emptyProfile(), sourceIds: ["airport"] };
  const collections = catalog([collection]);
  const { result, rerender } = mount(
    profile,
    catalog([noRevision], 1),
    collections,
  );
  await waitFor(() => expect(result.current.status).toBe("success"));
  rerender({ profile, sources: catalog([noRevision], 2), collections });
  expect(result.current.status).toBe("pending");
  expect(result.current.endpoints).toEqual([]);
  await act(async () => {
    refreshed.resolve(json({ endpoints: [node("new-snapshot")], stages: [] }));
  });
  await waitFor(() => expect(result.current.status).toBe("success"));
  expect(result.current.endpoints.map((n) => n.id)).toEqual(["new-snapshot"]);
});
