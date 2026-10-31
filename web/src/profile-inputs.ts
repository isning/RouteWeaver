import { useQuery } from "@tanstack/react-query";
import { request } from "./api";
import type { ClientNode, Collection, Preview, Profile, Source } from "./types";

/** The existing source/collection queries supply both records and freshness. */
export interface ProfileInputCatalog<T> {
  data?: T[];
  dataUpdatedAt: number;
  isPending: boolean;
  isFetching: boolean;
  isPaused?: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export interface EffectiveProfileInputs {
  mode: "collection" | "sources" | "manual";
  status: "pending" | "error" | "empty" | "success";
  /** A requested inventory check is waiting for connectivity, not running. */
  paused?: boolean;
  /** Empty while unresolved, never an approximation from raw source snapshots. */
  endpoints: ClientNode[];
  diagnostics: string[];
  error: Error | null;
  retry: () => Promise<unknown>;
}

/**
 * Resolve imported input choices using the same collection processor as profile
 * materialization. Collection takes precedence over sourceIds; without either,
 * manual IR endpoints remain local. Platform grants are resolved by the caller.
 *
 * This hook never changes the profile, including references that are unavailable
 * in the current result. Callers must retain and label those references instead
 * of filtering them out when inputs are pending, empty or unavailable.
 */
export function useEffectiveProfileInputs(
  profile: Pick<Profile, "collectionId" | "sourceIds"> & {
    ir: Pick<Profile["ir"], "endpoints">;
  },
  sources: ProfileInputCatalog<Source>,
  collections: ProfileInputCatalog<Collection>,
): EffectiveProfileInputs {
  const mode = profile.collectionId
    ? "collection"
    : profile.sourceIds?.length
      ? "sources"
      : "manual";
  const collection = collections.data?.find(
    (c) => c.id === profile.collectionId,
  );
  const sourceIds =
    mode === "collection"
      ? collection?.sources.map((s) => s.sourceId) || []
      : profile.sourceIds || [];
  const catalogs: ProfileInputCatalog<Source | Collection>[] =
    mode === "manual"
      ? []
      : mode === "collection"
        ? [sources, collections]
        : [sources];
  const catalogPaused = catalogs.some((q) => q.isPaused);
  const catalogPending = catalogs.some(
    (q) => q.isPending || q.isFetching || q.isPaused,
  );
  const catalogError = catalogs.find((q) => q.error)?.error || null;
  const catalogMissing = catalogs.some((q) => !q.data);
  const selectionError =
    mode === "collection" && !collection && !catalogMissing
      ? new Error("所选连接集合已不可用，请重新选择或重试。")
      : null;
  const dependencyError = catalogError || selectionError;
  const dependencyPending =
    catalogPending || (!dependencyError && catalogMissing);
  const query = useQuery({
    queryKey: [
      "profile-inputs",
      {
        mode,
        collectionId: profile.collectionId || null,
        // Collection has no revision field: its ordered recipe is its identity.
        collection: mode === "collection" ? collection : null,
        collectionsUpdatedAt:
          mode === "collection" ? collections.dataUpdatedAt : null,
        sourceIds,
        sourcesUpdatedAt: mode !== "manual" ? sources.dataUpdatedAt : null,
        sourceRevisions: sourceIds.map((id) => {
          const source = sources.data?.find((s) => s.id === id);
          return [
            id,
            source?.revision,
            source?.enabled,
            source?.updatedAt,
            source?.lastSuccessAt,
          ];
        }),
      },
    ],
    enabled: mode !== "manual" && !dependencyPending && !dependencyError,
    // Do not inherit a global keepPreviousData policy for authority-derived choices.
    placeholderData: () => undefined,
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const path =
        mode === "collection"
          ? `/me/collections/${encodeURIComponent(profile.collectionId!)}/preview`
          : "/me/collections/preview";
      const body =
        mode === "collection"
          ? {}
          : {
              id: "profile-sources",
              name: "Profile sources",
              sources: sourceIds.map((sourceId) => ({ sourceId, steps: [] })),
              steps: [],
            };
      // This POST only processes accepted snapshots; it does not fetch or save.
      const result = await request<Preview>(path, {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      });
      if (!result || !Array.isArray(result.endpoints))
        throw new Error("服务未返回有效的连接结果，请重试。");
      return {
        endpoints: result.endpoints,
        diagnostics: [
          ...new Set([
            ...(result.diagnostics || []),
            ...(result.stages || []).flatMap(
              (stage) => stage.diagnostics || [],
            ),
          ]),
        ],
      };
    },
  });
  const retry = async () => {
    if (mode === "manual") return;
    if (dependencyError || dependencyPending)
      return Promise.all(catalogs.map((q) => q.refetch()));
    return query.refetch();
  };
  const unresolved = (
    status: "pending" | "error",
    error: Error | null = null,
    paused = false,
  ): EffectiveProfileInputs => ({
    mode,
    status,
    paused,
    endpoints: [],
    diagnostics: error ? [error.message] : [],
    error,
    retry,
  });
  if (mode === "manual") {
    return {
      mode,
      status: profile.ir.endpoints.length ? "success" : "empty",
      endpoints: profile.ir.endpoints,
      diagnostics: [],
      error: null,
      retry,
    };
  }
  if (dependencyPending) return unresolved("pending", null, catalogPaused);
  if (dependencyError) return unresolved("error", dependencyError);
  // A refetch is not permission to keep showing choices from the old result.
  if (query.isFetching || query.isPending || query.isPaused)
    return unresolved("pending", null, query.isPaused);
  if (query.error) return unresolved("error", query.error);
  return {
    mode,
    status: query.data.endpoints.length ? "success" : "empty",
    ...query.data,
    error: null,
    retry,
  };
}
