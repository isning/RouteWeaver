import { Metadata, MetadataItem } from "@/ui-patterns/metadata";
import { WorkspaceFrame } from "@/ui-patterns/workspace-frame";
import { useSubscriptionRotationState } from "./subscription-rotation-state";
import { groupSubscriptionInventory } from "./subscription-inventory";
import { ResourceToolbar, SearchField } from "@/ui-patterns/resource-toolbar";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SubscriptionQRCode } from "./ui-patterns/qr-code";
import { LoadingState } from "./ui-patterns/loading-state";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { PageNavigation } from "@/ui-patterns/page-navigation";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { useForm, useWatch, AppField, AppForm } from "@/ui-patterns/form";
import { Input } from "@/components/ui/input";
import { Notice } from "@/ui-patterns/notice";
import { useConfirm } from "@/ui-patterns/confirmations";
import { toast } from "sonner";
import { ActionButton } from "@/ui-patterns/actions";
import { Badge } from "@/components/ui/badge";
import {
  Copy,
  Download,
  Ellipsis,
  Link,
  LoaderCircle,
  Plus,
  Search,
} from "lucide-react";
import { revealFocusedPolicyModalControl } from "./drawer-control-visibility";
import { policyStatus } from "./access-policy-model";
import { WORKSPACE_NAVIGATION_EVENT } from "./workspace-history";
import { useWorkspaceViewEntry } from "./useWorkspaceViewEntry";
import {
  invalidateOutputComparison,
  invalidateOutputPublication,
  outputInputSequence,
  rememberOutputComparison,
  useOutputComparison,
  useOutputComparisonChecks,
} from "./output-comparison";
import {
  useSubscriptionContext,
  WorkspaceHistoryContext,
} from "./SubscriptionContext";
import {
  ProfileValidationNotice,
  type MissingActionReference,
} from "./profile-validation";
import { clientTarget, clientTargets } from "./client-targets";
import {
  Suspense,
  type ComponentRef,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { lazyPage } from "./PageBoundary";
import { RoutingReview, RoutingSummaryView } from "./RoutingSummary";
import { NodeChanges } from "./NodeChanges";
import { SemanticOutputChanges } from "./SemanticOutputChanges";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  APIError,
  list,
  post,
  request,
  requestOutputBundle,
  usesTokenAuthentication,
} from "./api";
import type {
  Output,
  OutputCreation,
  OutputStatus,
  Overview,
  Profile,
  Preview,
} from "./types";
import type { Page } from "./App";
import {
  bytesLabel,
  dateLabel,
  emptyProfile,
  newID,
  resetCountdown,
  redact,
} from "./model";
import {
  CodePreview,
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
  Status,
} from "./components";
const SubscriptionEditor = lazyPage(() =>
  import("./Profiles").then((module) => ({ default: module.ProfileEditor })),
);
export type SubscriptionView = "overview" | "profiles" | "outputs";
export type SourceProfileEntry = {
  token: string;
  sourceId: string;
};
// Account authorization is not a client subscription's publication lifecycle.
function OverviewPolicyStatus({ value }: { value?: string }) {
  if (!value || !Object.hasOwn(policyStatus, value))
    return <Status value={value} />;
  const colors: Record<string, string> = {
    active: "success",
    paused: "default",
    disabled: "default",
    expired: "warning",
    "not-started": "default",
    ambiguous: "error",
    "service-missing": "error",
  };
  return <Badge variant="secondary">{policyStatus[value]}</Badge>;
}
function OutputComparisonLine({
  output,
  pending,
}: {
  output: Output;
  pending: boolean;
}) {
  const comparison = useOutputComparison(output);
  if (output.status !== "published") return null;
  return (
    <p
      className="subscription-comparison-state text-sm text-muted-foreground"
      role="status"
    >
      {pending && comparison.kind !== "checking" ? (
        "等待检查更新"
      ) : comparison.outcome ? (
        <>
          {comparison.kind === "changed" || comparison.kind === "repair" ? (
            <strong className="subscription-comparison-outcome flex items-center gap-2">
              {comparison.outcome}
            </strong>
          ) : (
            <span>{comparison.outcome}</span>
          )}{" "}
          <span className="subscription-comparison-date text-xs text-muted-foreground">
            {comparison.checkedAtLabel}
          </span>
        </>
      ) : (
        comparison.text
      )}
    </p>
  );
}
function OutputUpdateButton({
  output,
  pending,
  busy,
  disabled,
  onClick,
}: {
  output: Output;
  pending: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const comparison = useOutputComparison(output);
  const label =
    output.status === "revoked"
      ? "检查重新发布"
      : !pending && comparison.kind === "changed"
        ? "查看修改"
        : "检查更新";
  return (
    <ActionButton
      aria-label={label}
      aria-busy={busy}
      disabled={disabled}
      onClick={onClick}
      variant="outline"
      pending={!!(busy && { icon: <LoaderCircle aria-hidden="true" /> })}
    >
      {label}
    </ActionButton>
  );
}
// One relational inventory: saved configuration first, its independent links second.
// Ordinary inventory uses frozen metadata; comparisons are explicit scoped reads.
export function SubscriptionsPage({
  view = "overview",
  sourceDraft,
  onSourceDraftConsumed,
}: {
  navigate?: (page: Page) => void;
  view?: SubscriptionView;
  sourceDraft?: SourceProfileEntry;
  onSourceDraftConsumed?: (token: string) => void;
}) {
  const usageDetailsId = useId();
  const availableRoutesId = useId();
  const workspaceHistory = useContext(WorkspaceHistoryContext);
  const scope = new URLSearchParams(location.hash.split("?")[1] || "");
  const sourceDraftToken = scope.get("sourceDraft");
  const replaceView = useWorkspaceViewEntry();
  const [profileScope, setProfileScope] = useState<string | undefined>(
    scope.get("profile") || scope.get("profileId") || undefined,
  );
  const [selectedID, setSelectedID] = useState<string | undefined>(
    scope.get("output") || scope.get("outputId") || undefined,
  );
  const [listContext, updateListContext] = useSubscriptionContext(profileScope);
  const { search, page, linkPages } = listContext;
  const setSearch = (search: string) =>
    updateListContext({ search, page: 1, linkPages: {} });
  const setPage = (page: number) => updateListContext({ page });
  const setLinkPages = (
    update: (pages: Record<string, number>) => Record<string, number>,
  ) =>
    updateListContext((current) => ({ linkPages: update(current.linkPages) }));
  const inventoryRoot = useRef<HTMLDivElement>(null);
  const previousDetail = useRef(selectedID);
  const restoredScope = useRef<string | null>(null);
  const editorReturnPending = useRef(false);
  const focusLabel = (element: HTMLElement) =>
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.textContent ||
    "";
  useLayoutEffect(() => {
    let scrollY = listContext.scrollY;
    const rememberScroll = () => {
      if (
        !["", "#", "#subscriptions", "#profiles", "#outputs"].includes(
          location.hash.split("?")[0],
        )
      )
        return;
      scrollY = window.scrollY;
    };
    window.addEventListener("scroll", rememberScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", rememberScroll);
      // Persist once on leaving this scope, not by rendering on every scroll.
      updateListContext({ scrollY });
    };
  }, [updateListContext]);
  const [accessID, setAccessID] = useState<string | null>(null);
  const [completedAccess, setCompletedAccess] = useState<{
    output: Output;
    replacement?: "rotation" | "publication";
  } | null>(null);
  const [publication, setPublication] = useState<{
    id: string;
    profile: Profile;
  } | null>(null);
  const [updating, setUpdating] = useState<Output | null>(null);
  const updateOpeningTrigger = useRef<HTMLElement | null>(null);
  const [checkingID, setCheckingID] = useState<string | null>(null);
  const checkSequence = useRef(0);
  const [editError, setEditError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [opening, setOpening] = useState(false);
  const editSequence = useRef(0);
  const recoveryReturn = useRef<string | null>(null);
  const detailReady = useRef(false);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const updateButton = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      editSequence.current++;
    },
    [],
  );
  const [editor, setEditor] = useState<{
    profile: Profile;
    isNew: boolean;
    dirty: boolean;
    output?: Output;
    recovery?: boolean;
    focusName?: boolean;
  } | null>(null);
  const client = useQueryClient();
  const rotation = useSubscriptionRotationState(client);
  const message = toast,
    confirm = useConfirm();
  useEffect(() => {
    if (!sourceDraftToken) return;
    const params = new URLSearchParams(location.hash.split("?")[1]);
    params.delete("sourceDraft");
    const destination = `${location.hash.split("?")[0]}${params.size ? `?${params}` : ""}`;
    // An unmatched/reloaded token is only an inventory visit. Completion requires
    // the current active view lease; a stale or concealed owner cannot open a draft.
    replaceView(destination, () => {
      editSequence.current++;
      detailReady.current = false;
      setEditor(
        sourceDraft?.token === sourceDraftToken
          ? {
              profile: { ...emptyProfile(), sourceIds: [sourceDraft.sourceId] },
              isNew: true,
              dirty: true,
              focusName: true,
            }
          : null,
      );
      onSourceDraftConsumed?.(sourceDraftToken);
    });
  }, [sourceDraftToken, sourceDraft, onSourceDraftConsumed, replaceView]);
  const query = useQuery({
    refetchInterval: 60000,
    queryKey: ["overview"],
    queryFn: () => request<Overview>("/me/overview"),
  });
  const outputs = useQuery({
    queryKey: ["outputs"],
    queryFn: () => list<Output>("/me/outputs"),
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: () => list<Profile>("/me/profiles"),
  });
  const comparisons = useOutputComparisonChecks(
    JSON.stringify([
      profileScope,
      search,
      page,
      linkPages,
      selectedID,
      !!editor,
      !!updating,
      accessID,
      !!completedAccess,
    ]),
  );
  const checkVisibleOutputs = async (visible: Output[]) => {
    setActionError(null);
    try {
      await comparisons.run(visible, async () => {
        const refreshed = await outputs.refetch();
        if (refreshed.isError) throw refreshed.error;
        return refreshed.data || [];
      });
    } catch (error) {
      setActionError(error as Error);
    }
  };
  useLayoutEffect(() => {
    const closed = previousDetail.current;
    previousDetail.current = selectedID;
    if (
      !closed ||
      selectedID ||
      listContext.focus?.anchor !== `output:${closed}`
    )
      return;
    // Conditional modal unmount skips the dialog's open=false focus restoration.
    // Return only to the exact remembered trigger; direct links invent no target.
    Array.from(
      inventoryRoot.current?.querySelectorAll<HTMLElement>(
        "[data-return-focus]",
      ) || [],
    )
      .find(
        (element) =>
          element.dataset.returnFocus === `output:${closed}` &&
          !element.hasAttribute("disabled"),
      )
      ?.focus({ preventScroll: true });
  }, [selectedID, listContext.focus]);
  useLayoutEffect(() => {
    const scopeKey =
      profileScope === undefined ? "all" : `profile:${profileScope}`;
    const restoringScope = restoredScope.current !== scopeKey;
    if (
      (!restoringScope && !editorReturnPending.current) ||
      editor ||
      sourceDraftToken ||
      !profiles.isSuccess ||
      !outputs.isSuccess
    )
      return;
    restoredScope.current = scopeKey;
    editorReturnPending.current = false;
    // Detail dialogs own focus; restoring the underlying list must not steal it.
    if (!selectedID && listContext.focus) {
      const { anchor, label, tag } = listContext.focus;
      const marker = Array.from(
        inventoryRoot.current?.querySelectorAll<HTMLElement>(
          "[data-return-focus]",
        ) || [],
      ).find((element) => element.dataset.returnFocus === anchor);
      const targets = marker
        ? [
            marker,
            ...marker.querySelectorAll<HTMLElement>(
              "input,button,a,[tabindex]",
            ),
          ]
        : [];
      targets
        .find(
          (element) =>
            element.tagName === tag &&
            focusLabel(element) === label &&
            !element.hasAttribute("disabled"),
        )
        ?.focus({ preventScroll: true });
    }
    if (restoringScope)
      window.scrollTo({ top: listContext.scrollY, behavior: "instant" });
  });
  const updateScope = (key: "profile" | "output", value?: string) => {
    editSequence.current++;
    setOpening(false);
    setEditError(null);
    recoveryReturn.current = null;
    checkSequence.current++;
    setCheckingID(null);
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    params.delete(`${key}Id`);
    if (value) params.set(key, value);
    else params.delete(key);
    if (key === "profile") {
      params.delete("output");
      params.delete("outputId");
    }
    const destination = `${location.hash.split("?")[0] || "#subscriptions"}${params.size ? `?${params}` : ""}`;
    if (workspaceHistory?.current) {
      if (key === "output" && !value) workspaceHistory.current.closeDetail();
      else workspaceHistory.current.navigate(destination);
      return;
    }
    // Standalone embedding has no workspace lifetime or proven predecessor.
    if (key === "profile") {
      setProfileScope(value);
      setSelectedID(undefined);
    } else setSelectedID(value);
    history.replaceState(null, "", destination);
  };
  useEffect(() => {
    const syncScope = () => {
      // App's early guard allows only accepted navigation to reach this listener.
      editSequence.current++;
      recoveryReturn.current = null;
      setEditor(null);
      setOpening(false);
      setAccessID(null);
      setCompletedAccess(null);
      setPublication(null);
      checkSequence.current++;
      setCheckingID(null);
      setUpdating(null);
      setEditError(null);
      const params = new URLSearchParams(location.hash.split("?")[1] || "");
      setProfileScope(
        params.get("profile") || params.get("profileId") || undefined,
      );
      setSelectedID(
        params.get("output") || params.get("outputId") || undefined,
      );
    };
    if (!workspaceHistory) window.addEventListener("hashchange", syncScope);
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, syncScope);
    return () => {
      window.removeEventListener("hashchange", syncScope);
      window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, syncScope);
    };
  }, []);
  const edit = async (
    output?: Output,
    savedProfile?: Profile,
    copy = false,
    recovery = false,
  ) => {
    const trigger = document.activeElement;
    const returnToInventory =
      trigger instanceof HTMLElement &&
      !!inventoryRoot.current?.contains(trigger) &&
      !!trigger.closest("[data-return-focus]");
    checkSequence.current++;
    setCheckingID(null);
    const sequence = ++editSequence.current;
    setOpening(true);
    setEditError(null);
    try {
      const profileId = output?.profileId || savedProfile?.id;
      const profile = profileId
        ? await request<Profile>(`/me/profiles/${profileId}/reveal`)
        : emptyProfile();
      if (sequence === editSequence.current) {
        if (copy) {
          profile.id = newID("profile");
          profile.ir.id = profile.id;
          profile.name += " 副本";
        }
        detailReady.current = false;
        // Only an explicit inventory opener owns this same-scope return.
        editorReturnPending.current = returnToInventory;
        setEditor({
          profile,
          isNew: !profileId || copy,
          dirty: copy,
          output: copy ? undefined : output,
          recovery,
        });
      }
    } catch (error) {
      if (sequence === editSequence.current) setEditError(error as Error);
    } finally {
      if (sequence === editSequence.current) setOpening(false);
    }
  };
  const action = useMutation({
    retry: false,
    networkMode: "always",
    onMutate: ({ id }) => invalidateOutputPublication(client, id),
    onSettled: (_result, _error, { id }) => {
      invalidateOutputPublication(client, id);
      client.invalidateQueries({ queryKey: ["outputs"], exact: true });
      client.invalidateQueries({ queryKey: ["outputs", id, "status"], exact: true });
    },
    mutationFn: async ({
      id,
      operation,
      output,
      accessRevision,
      own,
    }: {
      id: string;
      operation: "rotate" | "revoke";
      output: Output;
      accessRevision: string;
      sequence: number;
      own: (complete?: () => void) => boolean;
    }) => {
      // Recheck the captured view/account lease AFTER onMutate's async boundary.
      if (!own())
        throw new Error("此操作已离开当前订阅，请重新打开订阅。");
      if (!hasAccessRevision(accessRevision))
        throw new Error("无法确认当前订阅访问版本。请刷新订阅后重新打开确认。");
      const init = { method: "POST", headers: { "If-Match": accessRevision } };
      if (operation !== "rotate") {
        const result = await request<Output>(`/me/outputs/${id}/${operation}`, init);
        return accessMetadata(result);
      }
      if (rotation.scope.snapshot().has(id))
        throw new Error("链接更换结果尚未确认。");
      rotation.scope.set(id, "pending");
      try {
        const result = await request<Output>(`/me/outputs/${id}/rotate`, init);
        if (
          !result ||
          result.id !== id ||
          result.profileId !== output.profileId ||
          result.target?.adapterId !== output.target.adapterId ||
          result.target?.version !== output.target.version ||
          result.mode !== output.mode ||
          result.status !== "published" ||
          !hasAccessRevision(result.accessRevision) ||
          result.accessRevision === accessRevision
        )
          throw new Error("无法确认更换结果。");
        rotation.scope.set(id);
        // Rotation only changes credentials. Do not retain returned secret paths.
        return accessMetadata(result);
      } catch (error) {
        if (accessChanged(error)) {
          rotation.scope.set(id);
          throw error;
        }
        rotation.scope.set(id, "unknown");
        throw new Error(
          "链接更换结果尚未确认，旧链接可能已失效。请查看当前访问方式，不要重复更换。",
        );
      }
    },
    onSuccess: (result, variables) => {
      client.removeQueries({ queryKey: ["output-access", variables.id] });
      variables.own(() => {
        setActionError(null);
        if (
          variables.operation === "rotate" &&
          variables.sequence === checkSequence.current
        )
          setCompletedAccess({ output: result, replacement: "rotation" });
        message.success(
          variables.operation === "revoke" ? "订阅已撤销" : "订阅链接已更新",
        );
      });
    },
    onError: (error, variables) => {
      if (accessChanged(error)) {
        client.removeQueries({ queryKey: ["output-access", variables.id] });
        variables.own(() =>
          setActionError(new Error(
            "订阅访问方式已变化，本次操作未执行。请刷新订阅后重新打开确认。",
          )),
        );
      } else if (variables.operation !== "rotate")
        variables.own(() => setActionError(error));
    },
  });
  const manage = (output: Output, operation: "rotate" | "revoke") => {
    if (operation === "rotate" && rotation.scope.snapshot().has(output.id))
      return;
    // Capture a primitive at opening, never substitute background-refreshed consent.
    const accessRevision = output.accessRevision;
    if (!hasAccessRevision(accessRevision)) {
      setActionError(new Error("无法确认当前订阅访问版本。请刷新订阅后重新打开确认。"));
      void client.invalidateQueries({ queryKey: ["outputs"], exact: true });
      void client.invalidateQueries({ queryKey: ["outputs", output.id, "status"], exact: true });
      return;
    }
    const approvedOutput = accessMetadata(output);
    const origin = location.hash;
    const sequence = checkSequence.current;
    const own = (complete?: () => void) =>
      sequence === checkSequence.current && replaceView(origin, complete);
    confirm({
      title: operation === "revoke" ? `撤销「${output.name}」？` : `更换「${output.name}」的订阅链接？`,
      description: operation === "revoke"
        ? "此链接将停止获取更新。已下载的配置不会被收回，其他订阅保留原状。"
        : output.delivery === "bundle"
          ? "旧下载链接将失效。配置包内容不变，无需因此重新导入；已下载的配置无法收回。"
          : "旧链接将停止获取更新，需要在客户端替换链接。已经下载的配置无法收回。",
      confirmLabel: operation === "revoke" ? "撤销订阅" : "更换链接",
      cancelLabel: operation === "revoke" ? "保留" : "保留旧链接",
      destructive: true,
      onConfirm: async () => {
        if (!own()) return;
        try {
          await action.mutateAsync({
            id: output.id,
            output: approvedOutput,
            accessRevision,
            operation,
            sequence,
            own,
          });
        } catch (error) {
          // A known conflict expires consent; an unknown rotation cannot be
          // replayed. Both close this decision, for different reasons.
          if (operation !== "rotate" && !accessChanged(error)) throw error;
        }
      },
    });
  };
  const allOutputs = Array.isArray(outputs.data) ? outputs.data : [];
  const allProfiles =
    !profiles.isError && Array.isArray(profiles.data) ? profiles.data : [];
  const currentOutput = selectedID
    ? allOutputs.find(
        (output) =>
          output.id === selectedID &&
          (!profileScope || output.profileId === profileScope),
      )
    : undefined;
  const outputStatus = useQuery({
    queryKey: ["outputs", currentOutput?.id, "status"],
    queryFn: async ({ signal }) => {
      const output = currentOutput!;
      const checkedInputs = outputInputSequence(client, output.profileId);
      invalidateOutputComparison(client, output.id);
      try {
        const result = await request<OutputStatus>(
          `/me/outputs/${output.id}/status`,
          { signal },
        );
        if (checkedInputs !== outputInputSequence(client, output.profileId))
          throw new Error("已保存输入已变化，请重新核对。");
        return { ...result, checkedInputs };
      } catch (error) {
        if (!signal.aborted)
          rememberOutputComparison(
            client,
            output,
            {
              id: output.id,
              profileId: output.profileId,
              target: output.target,
              mode: output.mode,
              status: output.status,
              revision: output.revision,
              draftComparison: { state: "unavailable" },
            },
            Date.now(),
            checkedInputs,
          );
        throw error;
      }
    },
    enabled:
      !!currentOutput && !editor && !updating && !accessID && !completedAccess,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (
      !currentOutput ||
      !outputStatus.data ||
      outputStatus.isFetching ||
      outputStatus.isError ||
      client.getQueryState(["outputs", currentOutput.id, "status"])
        ?.isInvalidated
    )
      return;
    rememberOutputComparison(
      client,
      currentOutput,
      outputStatus.data,
      outputStatus.dataUpdatedAt,
      outputStatus.data.checkedInputs,
    );
  }, [
    client,
    currentOutput,
    outputStatus.data,
    outputStatus.dataUpdatedAt,
    outputStatus.isFetching,
    outputStatus.isError,
  ]);
  const repairCause =
    !outputStatus.isError &&
    outputStatus.data?.id === currentOutput?.id &&
    outputStatus.data?.draftComparison?.state === "unavailable" &&
    outputStatus.data.draftComparison.reason === "missing-action-reference"
      ? outputStatus.data.draftComparison.location === "default"
        ? "已保存配置的默认流量去向不可用"
        : outputStatus.data.draftComparison.location === "group"
          ? "已保存配置的策略组成员不可用"
          : outputStatus.data.draftComparison.location === "rule"
            ? "已保存配置的规则流量去向不可用"
            : undefined
      : undefined;
  const recoveryProfileName = allProfiles.find(
    (profile) => profile.id === currentOutput?.profileId,
  )?.name;
  const recoveryLabel = recoveryProfileName
    ? `修复「${recoveryProfileName}」配置`
    : "修复关联配置";
  const restoreRecoveryFocus = () => {
    if (
      detailReady.current &&
      !editor &&
      !outputStatus.isFetching &&
      recoveryReturn.current === selectedID
    ) {
      const target = recoveryButton.current || updateButton.current;
      if (target) {
        target.focus({ preventScroll: true });
        recoveryReturn.current = null;
      }
    }
  };
  useLayoutEffect(restoreRecoveryFocus, [
    editor,
    selectedID,
    outputStatus.isFetching,
  ]);
  const detailOutput =
    !outputStatus.isError && outputStatus.data?.id === currentOutput?.id
      ? outputStatus.data
      : currentOutput;
  const requestedOutput = allOutputs.find((output) => output.id === selectedID);
  const scopeMismatch =
    !!profileScope &&
    !!requestedOutput &&
    requestedOutput.profileId !== profileScope;
  const scopedProfile = allProfiles.find(
    (profile) => profile.id === profileScope,
  );
  const needle = search.trim().toLocaleLowerCase();
  const groups = groupSubscriptionInventory(
    allProfiles,
    allOutputs,
    profileScope,
    search,
  );
  const pageCount = Math.max(1, Math.ceil(groups.length / 10));
  const currentPage = Math.min(page, pageCount);
  const visibleGroups = groups.slice((currentPage - 1) * 10, currentPage * 10);
  useEffect(() => {
    // A partial/failed inventory is not evidence that a remembered page vanished.
    if (!profiles.isSuccess || !outputs.isSuccess) return;
    updateListContext((current) => {
      const nextPages: Record<string, number> = {};
      for (const group of groups) {
        const remembered = current.linkPages[group.id];
        if (remembered)
          nextPages[group.id] = Math.min(
            remembered,
            Math.max(1, Math.ceil(group.links.length / 5)),
          );
      }
      const unchanged =
        Object.keys(nextPages).length ===
          Object.keys(current.linkPages).length &&
        Object.entries(nextPages).every(
          ([id, value]) => current.linkPages[id] === value,
        );
      return {
        page: Math.min(current.page, pageCount),
        ...(unchanged ? {} : { linkPages: nextPages }),
      };
    });
  });
  // Resolve the chosen link again at the action boundary. A cached inventory
  // must not promise an old token or resurrect an externally removed Output.
  const inspectOutput = async (requested: Output) => {
    // Capture before the async boundary disables the inventory action.
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const sequence = ++checkSequence.current;
    setCheckingID(requested.id);
    setActionError(null);
    try {
      const refreshed = await outputs.refetch();
      if (sequence !== checkSequence.current) return;
      if (refreshed.isError) throw refreshed.error;
      const fresh = refreshed.data?.find(
        (output) => output.id === requested.id,
      );
      if (!fresh || fresh.profileId !== requested.profileId)
        throw new Error(
          `「${requested.name}」已不在当前可访问范围。未检查、发布或切换到其他订阅。`,
        );
      updateOpeningTrigger.current = trigger;
      setUpdating(fresh);
    } catch (error) {
      if (sequence === checkSequence.current) setActionError(error as Error);
    } finally {
      if (sequence === checkSequence.current) setCheckingID(null);
    }
  };
  const access =
    detailOutput?.id === accessID
      ? detailOutput
      : allOutputs.find((output) => output.id === accessID);
  const publish = allProfiles.find(
    (profile) => profile.id === publication?.profile.id,
  );
  const updatingProfile = allProfiles.find(
    (profile) => profile.id === updating?.profileId,
  );
  const publicationReadState: PublicationProfileRead["state"] =
    profiles.fetchStatus === "paused"
      ? "paused"
      : profiles.isFetching || profiles.isPending
        ? "pending"
        : profiles.isError
          ? "error"
          : profiles.isSuccess && publish
            ? "ready"
            : "missing";
  const data = query.data;
  const quota = data?.quotaBytes ?? data?.user?.quotaBytes;
  const used = data?.accountingPending ? undefined : data?.usage?.weightedBytes;
  const remaining =
    quota && used !== undefined ? Math.max(0, quota - used) : undefined;
  const percent =
    quota && used !== undefined
      ? Math.min(100, Math.round((used / quota) * 100))
      : undefined;
  const reset = resetCountdown(data?.cycle?.nextReset);
  const hasInventory = allProfiles.length > 0 || allOutputs.length > 0;
  const detailUpdateLabel =
    detailOutput?.status === "revoked" ? "检查重新发布" : "检查更新";
  const outputMenu = (output: Output, profile?: Profile) => [
    {
      key: "view",
      label: "查看已发布内容",
      onClick: () => updateScope("output", output.id),
    },
    {
      key: "edit",
      label: "编辑关联分流配置",
      disabled: !profile,
      onClick: () => edit(output),
    },
    {
      key: "rotate",
      label: "更换订阅链接",
      disabled:
        output.status === "revoked" ||
        !!checkingID ||
        rotation.states.has(output.id),
      onClick: () => manage(output, "rotate"),
    },
    {
      key: "revoke",
      label: "撤销订阅",
      danger: true,
      disabled: output.status === "revoked" || !!checkingID,
      onClick: () => manage(output, "revoke"),
    },
  ];
  if (editor)
    return (
      <Suspense fallback={<LoadingState layout="form" label="正在打开配置" />}>
        <SubscriptionEditor
          initial={editor.profile}
          isNew={editor.isNew}
          initialDirty={editor.dirty}
          focusNameOnOpen={editor.focusName}
          output={editor.output}
          onClose={() => {
            if (editor.recovery)
              recoveryReturn.current = editor.output?.id || null;
            setEditor(null);
          }}
        />
      </Suspense>
    );
  const serviceContext = (
      <div className="subscription-service-context grid items-start gap-4 @min-[42rem]/rail:has-[.available-routes]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <QueryState
          loading={query.isPending}
          paused={query.isPaused}
          loadingLayout="summary"
          error={query.error}
          retry={() => query.refetch()}
        >
          {data && (
            <Card className={view === "overview" ? "subscription-usage gap-3 rounded-none bg-transparent py-0 ring-0" : "subscription-usage gap-3 py-4"}>
              <CardHeader className={`flex min-w-0 flex-col gap-2 @min-[42rem]/rail:grid ${view === "overview" ? "px-0" : ""}`}>
                <CardTitle
                  className="text-sm font-medium"
                  role="heading"
                  aria-level={2}
                >
                  平台服务用量
                </CardTitle>
                {data.service?.name && (
                  <CardDescription className="min-w-0 wrap-anywhere">{data.service.name}</CardDescription>
                )}
                <CardAction>
                  <OverviewPolicyStatus value={data.status} />
                </CardAction>
              </CardHeader>
              <CardContent className={`min-w-0 space-y-3 wrap-anywhere ${view === "overview" ? "px-0" : ""}`}>
                {data.status === "paused" && (
                  <p className="muted text-sm text-muted-foreground">
                    如需恢复平台服务，请联系管理员检查服务授权。
                  </p>
                )}
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                  <dl className="space-y-1">
                    <dt className="text-xs text-muted-foreground">剩余额度</dt>
                    <dd className="text-xl font-semibold tracking-tight tabular-nums">
                      {quota === 0 ? "不限额" : bytesLabel(remaining)}
                    </dd>
                  </dl>
                  <dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <div className="flex items-baseline gap-2">
                      <dt className="text-muted-foreground">已用额度</dt>
                      <dd className="font-medium tabular-nums">
                        {bytesLabel(used)}
                      </dd>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <dt className="text-muted-foreground">总额度</dt>
                      <dd className="font-medium tabular-nums">
                        {quota === 0 ? "不限额" : bytesLabel(quota)}
                      </dd>
                    </div>
                  </dl>
                </div>
                {percent !== undefined && (
                  <Progress value={percent} aria-label="本周期额度使用比例" />
                )}
                {data.accountingPending && (
                  <p
                    className="muted text-sm text-muted-foreground"
                    role="status"
                  >
                    额度正在核对，稍后更新。
                  </p>
                )}
                <section aria-labelledby={usageDetailsId} className="usage-details border-t border-border pt-4">
                  <h3 id={usageDetailsId} className="text-sm font-medium">用量与周期明细</h3>
                  <dl className="mt-2 divide-y divide-border text-sm">
                    {[
                      ["本周期实际流量", bytesLabel(data.usage?.rawBytes)],
                      ["下次重置", <><span className="usage-reset-date block wrap-normal">{data.cycle?.nextReset
                        ? dateLabel(data.cycle.nextReset, data.cycle.timezone)
                        : data.cycle ? "不自动重置" : "尚未设置"}</span>{reset && <span className="usage-reset-countdown mt-1 block text-xs leading-relaxed text-muted-foreground wrap-normal">{`（还有 ${reset}）`}</span>}</>],
                      ["周期时区", data.cycle?.timezone || "\u2014"],
                      ["服务到期", dateLabel(data.entitlement?.expiresAt || data.user?.expiresAt)],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="usage-detail-row grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-baseline gap-3 py-3">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="min-w-0 text-right tabular-nums wrap-anywhere">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    实际流量按所用线路的倍率扣除额度。
                  </p>
                </section>
              </CardContent>
            </Card>
          )}
        </QueryState>
        {!!data?.routes?.length && (
          <section aria-labelledby={availableRoutesId} className="available-routes min-w-0 border-t border-border pt-4">
            <h2 id={availableRoutesId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm font-medium">平台提供的线路 <span className="font-normal tabular-nums text-muted-foreground">{data.routes.length} 条</span></h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">已为你的账号开通</p>
            <ul className="route-options mt-2 divide-y divide-border">
              {data.routes.map((route) => (
                <li className="route-option grid min-w-0 gap-2 py-3" key={route.id}>
                  <h3 className="min-w-0 text-sm leading-relaxed wrap-anywhere">
                    {/* Keep the original name intact while allowing long compound names to wrap at word boundaries. */}
                    {route.name.split(/(?<=[a-z0-9])(?=[A-Z])/).flatMap((part, index) =>
                      index === 0 ? [part] : [<wbr key={index} />, part],
                    )}
                  </h3>
                  <Badge variant="secondary" className="justify-self-start tabular-nums" aria-label={`额度倍率 ${((route.rateMicros ?? 1000000) / 1000000).toLocaleString()} 倍`}>
                    {((route.rateMicros ?? 1000000) / 1000000).toLocaleString()}×
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
  );
  return (
    <div
      className="subscription-workspace space-y-6"
      ref={inventoryRoot}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        const marker = target.closest<HTMLElement>("[data-return-focus]");
        if (marker && inventoryRoot.current?.contains(marker))
          updateListContext({
            focus: {
              anchor: marker.dataset.returnFocus!,
              label: focusLabel(target),
              tag: target.tagName,
            },
          });
      }}
    >
      <WorkspaceFrame
        contentKind="list"
        contextKind="data"
        contained={view !== "overview"}
        context={serviceContext}
        header={<PageHeader
          title="我的订阅"
          action={
            <ActionButton
              className="subscription-create-action"
              data-return-focus="new-profile"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => edit()}
              variant="default"
              pending={!!opening}
            >
              新建分流配置
            </ActionButton>
          }
        />}
      >
      <ErrorNotice error={detailOutput ? null : editError || actionError} />
      {profileScope && (
        <div className="subscription-scope space-y-4" role="status">
          <span>
            当前配置：
            <strong>
              {scopedProfile?.name ||
                (profiles.isPending ? "正在核对…" : "不可用的分流配置")}
            </strong>
          </span>
          <ActionButton
            onClick={() => updateScope("profile", undefined)}
            variant="outline"
          >
            查看全部配置
          </ActionButton>
        </div>
      )}
      {profileScope &&
        !profiles.isPending &&
        !profiles.isError &&
        !scopedProfile && (
          <Notice tone="warning" title="此分流配置不可用">
            {"保留所请求的范围；仍可访问的客户端订阅列在下方。"}
          </Notice>
        )}
      {selectedID &&
        !outputs.isPending &&
        !outputs.isError &&
        !currentOutput && (
          <Notice
            tone="warning"
            title={
              scopeMismatch
                ? "客户端订阅不属于当前分流配置"
                : "所选客户端订阅不在当前可访问范围"
            }
            action={
              <ActionButton
                onClick={() => updateScope("output", undefined)}
                variant="outline"
              >
                清除订阅选择
              </ActionButton>
            }
          >
            {"没有自动切换到其他订阅。清除订阅选择后，仍保留当前配置范围。"}
          </Notice>
        )}
      {(profiles.isError || outputs.isError) && (
        <div className="subscription-load-errors space-y-3">
          {profiles.isError && !publication && (
            <Notice
              tone="error"
              title="暂时无法加载分流配置"
              action={
                <ActionButton
                  onClick={() => profiles.refetch()}
                  variant="outline"
                >
                  重试配置
                </ActionButton>
              }
            />
          )}
          {outputs.isError && (
            <Notice
              tone="error"
              title="暂时无法加载客户端订阅"
              action={
                <ActionButton
                  onClick={() => outputs.refetch()}
                  variant="outline"
                >
                  重新核对订阅
                </ActionButton>
              }
            />
          )}
        </div>
      )}
      {hasInventory && (
        <ResourceToolbar className="subscription-inventory-tools" label="查找配置与订阅" search={
          <SearchField
            data-return-focus="search"
            aria-label="搜索配置或客户端订阅"
            placeholder="搜索配置或客户端订阅"
            value={search}
            onValueChange={setSearch}
          />
          } summary={<span role="status">
            <Metadata>
              <MetadataItem>{groups.length} 组配置</MetadataItem>
              <MetadataItem>{outputs.isPending || outputs.isError
                ? "订阅待核对"
                : `${groups.reduce((total, group) => total + group.links.length, 0)} 个客户端订阅`}</MetadataItem>
            </Metadata>
          </span>} />
      )}
      {(profiles.isPending || outputs.isPending) && (
        profiles.isPaused || outputs.isPaused ? (
          <Notice tone="info" title="等待网络连接">连接恢复后将继续核对配置与客户端订阅。</Notice>
        ) : hasInventory ? (
          <p role="status" aria-label="正在加载配置与客户端订阅" className="text-sm text-muted-foreground">正在核对尚未返回的配置与客户端订阅…</p>
        ) : (
          <LoadingState layout="subscriptions" label="正在加载配置与客户端订阅" />
        )
      )}
      <section
        aria-label={
          view === "outputs" ? "客户端订阅清单" : "分流配置与客户端订阅"
        }
        className="subscription-inventory space-y-4"
      >
        {visibleGroups.map((group) => {
          const { profile, links, id } = group;
          const linkPage = Math.min(
            linkPages[id] || 1,
            Math.max(1, Math.ceil(links.length / 5)),
          );
          const visibleLinks = links.slice((linkPage - 1) * 5, linkPage * 5);
          const checkableLinks = visibleLinks.filter(
            (output) => output.status === "published",
          );
          return (
            <article
              className="surface subscription-configuration overflow-hidden rounded-xl border bg-card"
              key={id}
              aria-label={
                profile ? `分流配置 ${profile.name}` : `关联配置不可用 ${id}`
              }
            >
              <header className="subscription-configuration-heading flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
                <div className="subscription-info min-w-0 space-y-1">
                  <h2 className="text-base font-semibold tracking-tight text-foreground wrap-anywhere">
                    {profile?.name ||
                      (profiles.isPending
                        ? "正在核对关联配置…"
                        : "关联配置不可用")}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    <Metadata>
                      <MetadataItem>{profile
                        ? "已保存的分流配置"
                        : "配置暂不可编辑；保留独立订阅的访问与管理"}</MetadataItem>
                      <MetadataItem>{outputs.isPending || outputs.isError
                        ? "关联订阅待核对"
                        : `${group.totalLinks} 个客户端订阅`}</MetadataItem>
                    </Metadata>
                  </p>
                </div>
                {profile && (
                  <div className={"flex flex-wrap items-center gap-2"}>
                    <ActionButton
                      onClick={() => edit(undefined, profile)}
                      variant="outline"
                      pending={!!opening}
                    >
                      {!outputs.isPending &&
                      !outputs.isError &&
                      group.totalLinks === 0
                        ? "继续配置"
                        : "编辑配置"}
                    </ActionButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <ActionButton
                          aria-label={`管理配置 ${profile.name}`}
                          leadingIcon={<Ellipsis aria-hidden="true" />}
                          variant="ghost"
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        onCloseAutoFocus={(event) => {
                          if (
                            document.activeElement?.closest(
                              '[role="dialog"],[role="alertdialog"]',
                            )
                          )
                            event.preventDefault();
                        }}
                      >
                        {checkableLinks.length === 1 && (
                          <DropdownMenuItem
                            disabled={
                              comparisons.running ||
                              outputs.isError ||
                              !!checkingID ||
                              !!opening
                            }
                            aria-label={`检查 ${profile.name} 的 1 个订阅更新`}
                            onSelect={() =>
                              void checkVisibleOutputs(checkableLinks)
                            }
                          >
                            后台检查订阅更新
                          </DropdownMenuItem>
                        )}
                        {[
                          {
                            key: "copy",
                            label: "\u590D\u5236\u4E3A\u72EC\u7ACB\u914D\u7F6E",
                            icon: <Copy aria-hidden="true" />,
                            onClick: () => edit(undefined, profile, true),
                          },
                          {
                            key: "scope",
                            label: "\u4EC5\u67E5\u770B\u6B64\u914D\u7F6E",
                            onClick: () => updateScope("profile", id),
                          },
                        ].map((item) => (
                          <DropdownMenuItem
                            key={item.key}
                            disabled={"disabled" in item && !!item.disabled}
                            variant={
                              "danger" in item && item.danger
                                ? "destructive"
                                : "default"
                            }
                            onSelect={() => {
                              item.onClick?.();
                            }}
                          >
                            {"icon" in item ? (item.icon as ReactNode) : null}
                            {item.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </header>
              <div className="subscription-owned-links divide-y border-t">
                {visibleLinks.map((output) => (
                  <div
                    className="subscription-client-row flex flex-wrap items-center justify-between gap-x-5 gap-y-3 px-4 py-4 sm:px-5"
                    key={output.id}
                    role="group"
                    aria-label={`客户端订阅 ${output.name}`}
                  >
                    <div className="subscription-info min-w-0 max-w-full text-sm text-muted-foreground">
                      <ActionButton
                        className="subscription-name-button h-auto max-w-full justify-start whitespace-normal wrap-anywhere p-0 text-left text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-ring"
                        data-return-focus={`output:${output.id}`}
                        aria-label={`查看订阅 ${output.name}`}
                        onClick={() => updateScope("output", output.id)}
                        variant="link"
                      >
                        {output.name}
                      </ActionButton>
                      <div className="subscription-client-meta mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        {output.status === "published" ? (
                          <span className="subscription-publication-state text-xs text-muted-foreground">
                            已发布
                          </span>
                        ) : (
                          <Status value={output.status} />
                        )}
                        <p>
                          <Metadata>
                            <MetadataItem>{output.target.adapterId}</MetadataItem>
                            <MetadataItem>{output.mode === "nodes-only" ? "纯节点" : "完整配置"}</MetadataItem>
                            <MetadataItem>{output.publishedAt
                              ? `最近发布 ${dateLabel(output.publishedAt)}`
                              : "尚未发布"}</MetadataItem>
                          </Metadata>
                        </p>
                      </div>
                    </div>
                    <OutputComparisonLine
                      output={output}
                      pending={comparisons.pendingIds.has(output.id)}
                    />
                    <div className={"flex flex-wrap items-center gap-2"}>
                      <ActionButton
                        disabled={
                          output.status === "revoked" ||
                          outputs.isError ||
                          !!checkingID
                        }
                        onClick={() => setAccessID(output.id)}
                        variant="outline"
                      >
                        获取订阅
                      </ActionButton>
                      <OutputUpdateButton
                        output={output}
                        pending={comparisons.pendingIds.has(output.id)}
                        disabled={!profile || outputs.isError || !!checkingID}
                        busy={checkingID === output.id}
                        onClick={() => inspectOutput(output)}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <ActionButton
                            aria-label={`管理 ${output.name}`}
                            leadingIcon={<Ellipsis aria-hidden="true" />}
                            variant="ghost"
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onCloseAutoFocus={(event) => {
                            if (
                              document.activeElement?.closest(
                                '[role="dialog"],[role="alertdialog"]',
                              )
                            )
                              event.preventDefault();
                          }}
                        >
                          {outputMenu(output, profile).map((item) => (
                            <DropdownMenuItem
                              key={item.key}
                              disabled={"disabled" in item && !!item.disabled}
                              variant={
                                "danger" in item && item.danger
                                  ? "destructive"
                                  : "default"
                              }
                              onSelect={() => {
                                item.onClick?.();
                              }}
                            >
                              {"icon" in item ? (item.icon as ReactNode) : null}
                              {item.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
                {!links.length && !outputs.isPending && !outputs.isError && (
                  <p className="subscription-no-links p-4 text-sm text-muted-foreground">
                    {group.totalLinks
                      ? "没有匹配的客户端订阅。"
                      : "尚未关联客户端订阅。继续配置，或将已保存内容发布到客户端。"}
                  </p>
                )}
                {links.length > 5 && (
                  <nav
                    aria-label={`${profile?.name || "关联配置不可用"}的客户端订阅分页`}
                    data-return-focus={`links:${id}`}
                    className="subscription-link-pagination"
                  >
                    <PageNavigation
                      page={linkPage}
                      total={links.length}
                      pageSize={5}
                      onPageChange={(next) =>
                        setLinkPages((pages) => ({ ...pages, [id]: next }))
                      }
                    />
                  </nav>
                )}
              </div>
              {profile && (
                <footer className="subscription-configuration-footer flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-2 sm:px-5">
                  {checkableLinks.length > 1 && (
                    <ActionButton
                      disabled={
                        comparisons.running ||
                        outputs.isError ||
                        !!checkingID ||
                        opening
                      }
                      aria-label={`检查 ${profile.name} 的 ${checkableLinks.length} 个订阅更新`}
                      aria-busy={checkableLinks.some((output) =>
                        comparisons.pendingIds.has(output.id),
                      )}
                      onClick={() => void checkVisibleOutputs(checkableLinks)}
                      variant="outline"
                    >
                      检查 {checkableLinks.length} 个订阅的更新
                    </ActionButton>
                  )}
                  <ActionButton
                    leadingIcon={<Plus aria-hidden="true" />}
                    aria-label={`为 ${profile.name} 新增客户端订阅`}
                    disabled={!!checkingID}
                    onClick={() =>
                      setPublication({ id: newID("publication"), profile })
                    }
                    variant="link"
                  >
                    新增客户端订阅
                  </ActionButton>
                </footer>
              )}
            </article>
          );
        })}
        {!groups.length &&
          !profiles.isPending &&
          !outputs.isPending &&
          !profiles.isError &&
          !outputs.isError && (
            <Section>
              <EmptyState
                title={
                  needle
                    ? "没有匹配的配置或客户端订阅"
                    : profileScope
                      ? "当前范围内没有可访问的配置或订阅"
                      : "暂无订阅"
                }
                description={
                  needle
                    ? "试试配置名、客户端订阅名或目标客户端。"
                    : profileScope
                      ? "未切换到其他配置，可返回全部配置继续查找。"
                      : undefined
                }
                action={
                  needle ? (
                    <ActionButton
                      onClick={() => setSearch("")}
                      variant="outline"
                    >
                      清除搜索
                    </ActionButton>
                  ) : undefined
                }
              />
            </Section>
          )}
      </section>
      {groups.length > 10 && (
        <nav
          data-return-focus="profile-pages"
          aria-label="配置清单分页"
          className="subscription-inventory-pagination"
        >
          <PageNavigation
            page={currentPage}
            total={groups.length}
            pageSize={10}
            onPageChange={setPage}
          />
        </nav>
      )}
      {detailOutput && !updating && !access && !completedAccess && (
        <TaskDialog
          title={`${detailOutput.name} 的订阅详情`}
          open
          footer={null}
          className="subscription-detail"
          bodyProps={{ className: "space-y-5" }}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) (() => updateScope("output", undefined))();
          }}
          onReady={() =>
            ((open) => {
              detailReady.current = open;
              if (open) restoreRecoveryFocus();
            })(true)
          }
          onClosed={() =>
            ((open) => {
              detailReady.current = open;
              if (open) restoreRecoveryFocus();
            })(false)
          }
          size="lg"
        >
          <ErrorNotice error={editError || actionError} />
          {rotation.states.has(detailOutput.id) && (
            <Notice tone="warning" title={rotation.states.get(detailOutput.id) === "pending"
              ? "正在更换订阅链接" : "链接更换结果尚未确认"}>
              旧链接可能已失效。查看当前访问方式只能获取当前订阅，不能确认上次更换是否完成；请勿重复更换。
            </Notice>
          )}
          <div className="space-y-3 rounded-lg bg-muted/50 p-4">
            <p className="text-sm text-muted-foreground">
              分流配置：
              {allProfiles.find(
                (profile) => profile.id === detailOutput.profileId,
              )?.name || "关联配置不可用"}
            </p>
            <div className="subscription-detail-meta flex flex-wrap gap-2 text-sm text-muted-foreground">
              <span>
                <Metadata>
                  <MetadataItem>{detailOutput.target.adapterId}</MetadataItem>
                  <MetadataItem>{detailOutput.mode === "nodes-only" ? "纯节点" : "完整配置"}</MetadataItem>
                </Metadata>
              </span>
              {detailOutput.status === "published" ? (
                <span className="subscription-publication-state text-xs text-muted-foreground">
                  已发布
                </span>
              ) : (
                <Status value={detailOutput.status} />
              )}
            </div>
            <p className="muted text-sm text-muted-foreground">
              {detailOutput.publishedAt
                ? `最近发布 ${dateLabel(detailOutput.publishedAt)}`
                : "尚未发布"}
            </p>
          </div>
          <section
            aria-label="已发布分流"
            className="subscription-frozen-detail space-y-4 border-t pt-5 [&>h3]:font-semibold"
          >
            <h3>已发布分流</h3>
            <RoutingSummaryView
              summary={detailOutput.routingSummary}
              intent={
                !outputStatus.isError &&
                outputStatus.data?.id === detailOutput.id
                  ? outputStatus.data.routingIntent
                  : undefined
              }
            />
            {!outputStatus.isError &&
              outputStatus.data?.id === detailOutput.id &&
              !outputStatus.data.routingIntent &&
              (detailOutput.routingSummary?.kind === "basic" ||
                detailOutput.routingSummary?.kind === "advanced") && (
                <p>此版本未保存具体规则明细，无法逐条比较。</p>
              )}
          </section>
          <div className="subscription-draft-comparison space-y-3 rounded-lg bg-muted/50 p-4">
            {outputStatus.isFetching ? (
              <p role="status">正在核对已保存的修改…</p>
            ) : repairCause ? (
              <>
                <p role="status">{repairCause}。已发布内容未因此改变。</p>
                <ActionButton
                  ref={recoveryButton}
                  aria-label={recoveryLabel}
                  aria-busy={opening}
                  disabled={opening}
                  onClick={() => edit(detailOutput, undefined, false, true)}
                  variant="outline"
                  pending={!!opening}
                >
                  {recoveryLabel}
                </ActionButton>
              </>
            ) : outputStatus.isError ||
              outputStatus.data?.draftComparison?.state === "unavailable" ||
              !outputStatus.data?.draftComparison ? (
              <>
                <p role="status">
                  暂时无法比较已保存的修改。已发布内容未因此改变。
                </p>
                <ActionButton
                  onClick={() => outputStatus.refetch()}
                  variant="outline"
                >
                  重新检查更新
                </ActionButton>
              </>
            ) : (
              <p role="status">
                {outputStatus.data.draftComparison.state === "changed"
                  ? "已保存的修改尚未发布"
                  : "与已保存草稿一致"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t pt-5">
            <ActionButton
              disabled={
                detailOutput.status === "revoked" ||
                !!checkingID ||
                opening ||
                rotation.states.get(detailOutput.id) === "pending"
              }
              onClick={() => setAccessID(detailOutput.id)}
              variant="default"
            >
              {rotation.states.has(detailOutput.id) ? "查看当前访问方式" : "获取订阅"}
            </ActionButton>
            <ActionButton
              ref={updateButton}
              disabled={
                opening ||
                !!checkingID ||
                !allProfiles.some(
                  (profile) => profile.id === detailOutput.profileId,
                )
              }
              aria-label={detailUpdateLabel}
              aria-busy={checkingID === detailOutput.id}
              onClick={() => inspectOutput(detailOutput)}
              variant="outline"
              pending={
                !!(
                  checkingID === detailOutput.id && {
                    icon: <LoaderCircle aria-hidden="true" />,
                  }
                )
              }
            >
              {detailUpdateLabel}
            </ActionButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ActionButton disabled={opening} variant="outline">
                  更多操作
                </ActionButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  if (
                    document.activeElement?.closest(
                      '[role="dialog"],[role="alertdialog"]',
                    )
                  )
                    event.preventDefault();
                }}
              >
                {outputMenu(
                  detailOutput,
                  allProfiles.find(
                    (profile) => profile.id === detailOutput.profileId,
                  ),
                )
                  .filter((item) => item.key !== "view")
                  .map((item) => (
                    <DropdownMenuItem
                      key={item.key}
                      disabled={"disabled" in item && !!item.disabled}
                      variant={
                        "danger" in item && item.danger
                          ? "destructive"
                          : "default"
                      }
                      onSelect={() => {
                        item.onClick?.();
                      }}
                    >
                      {"icon" in item ? (item.icon as ReactNode) : null}
                      {item.label}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TaskDialog>
      )}
      <PublishOutput
        profile={publication ? publish || publication.profile : null}
        sessionId={publication?.id}
        profileRead={{
          state: publicationReadState,
          retry: () => {
            void profiles.refetch();
          },
        }}
        onClose={() => setPublication(null)}
      />
      {updating && (
        <UpdateOutput
          key={updating.id}
          output={updating}
          openingTrigger={updateOpeningTrigger.current}
          autoInspect
          profileName={updatingProfile?.name}
          usesAcceptedSources={
            !!(
              updatingProfile?.sourceIds?.length ||
              updatingProfile?.collectionId
            )
          }
          onPublished={(result, replaced) => {
            if (replaced || result.delivery === "bundle")
              setCompletedAccess({ output: result, replacement: replaced ? "publication" : undefined });
          }}
          onClose={() => setUpdating(null)}
        />
      )}
      <AccessSubscription
        output={completedAccess?.output || access || null}
        rotationUncertain={rotation.states.get((completedAccess?.output || access)?.id || "") === "unknown"}
        replacement={completedAccess?.replacement}
        onClose={() => {
          setAccessID(null);
          setCompletedAccess(null);
        }}
      />

      </WorkspaceFrame>
    </div>
  );
}
// Historical entrypoints retain scope and enter the same relational workspace.
export function OutputsPage() {
  return <SubscriptionsPage view="outputs" />;
}
// Delivery is derived from the checked candidate, never the cached Output or
// the mere presence of a remote rule-file reference.
function previewUsesBundle(preview?: Preview | null) {
  return (
    preview?.valid === true &&
    typeof preview.previewDigest === "string" &&
    preview.previewDigest.length > 0 &&
    Array.isArray(preview.resources) &&
    preview.resources.some(
      (resource) =>
        resource?.location === "local" &&
        typeof resource.acceptedVersion === "string" &&
        resource.acceptedVersion.length > 0,
    )
  );
}
function PublicationTechnicalPreview({
  artifacts,
  label = "技术配置（可选查看）",
}: {
  artifacts: Preview["artifacts"];
  label?: string;
}) {
  if (!artifacts?.length) return null;
  return (
    <Accordion type="multiple">
      {[
        {
          key: "technical",
          label,
          children: artifacts.map((artifact) => (
            <div key={artifact.path}>
              <h4>{artifact.path}</h4>
              <CodePreview content={redact(artifact.content)} />
            </div>
          )),
        },
      ].map((section) => (
        <AccordionItem
          key={section.key}
          value={String(section.key)}
          disabled={
            "collapsible" in section && section.collapsible === "disabled"
          }
        >
          <AccordionTrigger>{section.label}</AccordionTrigger>
          <AccordionContent forceMount className="data-[state=closed]:hidden">
            {section.children}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
type PublicationProfileRead = {
  state: "ready" | "pending" | "paused" | "error" | "missing";
  retry: () => void;
};
type PublicationFocusTicket = {
  request: number;
  owner: number;
  profileId?: string;
  sessionId?: string;
  revision: number;
  intent: number;
  origin: HTMLElement | null;
};
export function PublishOutput({
  profile,
  onClose,
  onPublished,
  onRepair,
  suspended = false,
  sessionId,
  profileRead,
}: {
  profile: Profile | null;
  sessionId?: string;
  profileRead?: PublicationProfileRead;
  onClose: () => void;
  onPublished?: (output: Output) => void;
  onRepair?: (issue: MissingActionReference) => void;
  suspended?: boolean;
}) {
  const [form] = useForm();
  const client = useQueryClient();
  const message = toast;
  const [created, setCreated] = useState<Output | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const creationWasUncertain = useRef(false);
  const [pendingCreation, setPendingCreation] = useState<
    | (OutputCreation & {
        previewDigest: string;
      })
    | null
  >(null);
  const [reviewedCreation, setReviewedCreation] =
    useState<OutputCreation | null>(null);
  const revision = useRef(0);
  const reviewStatus = useRef<HTMLParagraphElement>(null);
  const reviewFocusVersion = useRef<number | null>(null);
  const outputID = useRef(newID("output"));
  const opening = useRef(0);
  const publicationSurface = useRef<HTMLDivElement>(null);
  const recoverySummary = useRef<HTMLElement>(null);
  const recoveryOutcomeId = useId();
  const presentationRequest = useRef(0);
  const presentationIntent = useRef(0);
  const publicationFocus = useRef<{
    owner: number;
    node: HTMLElement;
  } | null>(null);
  const revealedRecovery = useRef<string | null>(null);
  const [settledPresentation, setSettledPresentation] =
    useState<PublicationFocusTicket | null>(null);
  const mode = useWatch("mode", form);
  const writeReady =
    !!profile && !suspended && (!profileRead || profileRead.state === "ready");
  // Preserve only this task's display identity/read state during its inert exit.
  // Live authority below continues to use the actual props, never this snapshot.
  const lastPresentation = useRef({ profile, profileRead, writeReady });
  if (profile && !suspended)
    lastPresentation.current = { profile, profileRead, writeReady };
  const presentation =
    profile && !suspended
      ? { profile, profileRead, writeReady }
      : lastPresentation.current;
  const displayProfile = presentation.profile;
  const displayRead = presentation.profileRead;
  // Read availability suspends actions, not the opening or its reviewed payload.
  // Read these latest values after asynchronous field validation as well.
  const latestAuthority = useRef({
    writeReady,
    profileId: profile?.id,
    sessionId,
  });
  latestAuthority.current = { writeReady, profileId: profile?.id, sessionId };
  const requireAuthority = (owner: typeof latestAuthority.current) => {
    const current = latestAuthority.current;
    if (
      !current.writeReady ||
      current.profileId !== owner.profileId ||
      current.sessionId !== owner.sessionId
    )
      throw new Error("请先核对分流配置，再继续发布。");
  };
  const ownsOpening = (owner: number) =>
    opening.current === owner && !!latestAuthority.current.profileId;
  useLayoutEffect(
    () => () => {
      opening.current++;
    },
    [],
  );
  const selection = (): OutputCreation => ({
    id: outputID.current,
    name: form.getFieldValue("name"),
    profileId: profile!.id,
    target: clientTarget(form.getFieldValue("adapterId")),
    mode: form.getFieldValue("mode"),
  });
  const inspect = useMutation({
    mutationFn: async () => {
      const owner = latestAuthority.current;
      const version = revision.current;
      requireAuthority(owner);
      await form.validateFields();
      requireAuthority(owner);
      if (version !== revision.current)
        throw new Error("配置或发布选项已变化，请重新检查发布内容。");
      const creation = selection();
      const value = await post<Preview>("/me/outputs/preview", creation);
      if (
        value.valid !== true ||
        !value.artifacts?.length ||
        !value.previewDigest ||
        value.previewScope !== "new-output" ||
        value.outputId !== creation.id
      )
        throw new Error("这份订阅未通过检查，请检查配置和客户端选择。");
      return { value, creation, version };
    },
    onSuccess: ({ value, creation, version }) => {
      if (version === revision.current) {
        reviewFocusVersion.current = version;
        setPreview(value);
        setReviewedCreation(creation);
      }
    },
  });
  const finishPublication = (output: Output) => {
    setPendingCreation(null);
    client.invalidateQueries({ queryKey: ["outputs"] });
    setCreated(output);
    message.success("订阅已发布");
    onPublished?.(output);
    onClose();
  };
  const recover = useMutation({
    mutationFn: async (owner: number) => {
      if (!ownsOpening(owner)) throw new Error("此发布任务已关闭。");
      const existing = await list<Output>("/me/outputs");
      const found = existing.find(
        (item) =>
          pendingCreation &&
          item.id === pendingCreation.id &&
          item.profileId === pendingCreation.profileId &&
          item.status === "published" &&
          item.creationReviewDigest === pendingCreation.previewDigest,
      );
      if (!found) throw new Error("尚未确认上次发布结果，请稍后继续核对。");
      return found;
    },
    onSuccess: (output, owner) => {
      if (ownsOpening(owner)) finishPublication(output);
    },
  });
  const mutation = useMutation({
    onMutate: ({ owner }): PublicationFocusTicket => {
      const active = document.activeElement;
      return {
        request: ++presentationRequest.current,
        owner,
        profileId: latestAuthority.current.profileId,
        sessionId: latestAuthority.current.sessionId,
        revision: revision.current,
        intent: presentationIntent.current,
        origin:
          active instanceof HTMLElement &&
          publicationSurface.current?.contains(active)
            ? active
            : (active === document.body ||
                  active === document.documentElement) &&
                publicationFocus.current?.owner === owner
              ? publicationFocus.current.node
              : null,
      };
    },
    mutationFn: async ({
      retry,
      owner,
    }: {
      retry?: OutputCreation & {
        previewDigest: string;
      };
      owner: number;
    }) => {
      if (!ownsOpening(owner)) throw new Error("此发布任务已关闭。");
      requireAuthority(latestAuthority.current);
      let attempt = retry;
      if (!attempt) {
        if (
          !preview?.previewDigest ||
          !reviewedCreation ||
          JSON.stringify(selection()) !== JSON.stringify(reviewedCreation)
        )
          throw new Error("配置或发布选项已变化，请重新检查发布内容。");
        attempt = { ...reviewedCreation, previewDigest: preview.previewDigest };
      }
      try {
        return await post<Output>("/me/outputs", attempt);
      } catch (failure) {
        if (!ownsOpening(owner)) throw failure;
        const rejected =
          failure instanceof APIError &&
          failure.status >= 400 &&
          failure.status < 500;
        // A definitive rejection is not made uncertain by a later read failure.
        // Only a prior uncertain attempt may still have an accepted receipt.
        if (rejected && !creationWasUncertain.current) throw failure;
        if (!rejected) creationWasUncertain.current = true;
        setPendingCreation(attempt);
        const existing = await list<Output>("/me/outputs").catch(() => {
          if (rejected) throw failure;
          // A lost response followed by an unavailable lookup is still unknown.
          // Preserve the same reviewed attempt so retry can recover its receipt.
          throw new APIError(
            "无法确认订阅是否已发布。请重试以核对同一份订阅，当前选择已保留。",
            0,
          );
        });
        if (!ownsOpening(owner)) throw failure;
        const found = existing?.find(
          (item) =>
            item.id === attempt.id &&
            item.profileId === attempt.profileId &&
            item.status === "published" &&
            item.creationReviewDigest === attempt.previewDigest,
        );
        if (found) return found;
        // A rejected replay with a completed lookup permits a fresh review of
        // this same identity. Keep its uncertainty history: an older receipt
        // may still appear later, but cannot prove a revised digest succeeded.
        if (rejected) setPendingCreation(null);
        throw failure;
      }
    },
    onSuccess: (output, attempt) => {
      if (ownsOpening(attempt.owner)) finishPublication(output);
    },
    onError: (failure, attempt, presentation) => {
      if (!ownsOpening(attempt.owner)) return;
      if (failure instanceof APIError && failure.status === 409)
        setPreview(null);
      // Schedule from the operation's lifecycle, not an intermediate pending
      // render: a fast POST failure and automatic GET can settle in one batch.
      if (presentation) setSettledPresentation(presentation);
    },
  });
  useLayoutEffect(() => {
    if (!suspended) return;
    // Preserve explicit creation choices while repairing the shared Profile,
    // but never carry a checked digest across that edit.
    revision.current++;
    inspect.reset();
    mutation.reset();
    setPreview(null);
    setReviewedCreation(null);
  }, [suspended]);
  const busy = inspect.isPending || mutation.isPending || recover.isPending;
  const bundlePreview = previewUsesBundle(preview);
  const locked = busy || !!pendingCreation;
  const pendingTransportError =
    !!pendingCreation &&
    mutation.error instanceof APIError &&
    mutation.error.status >= 500 &&
    mutation.error.status < 600;
  const publicationNoticeError = pendingTransportError
    ? inspect.error
    : mutation.error || inspect.error;
  useLayoutEffect(() => {
    if (
      !pendingCreation ||
      mutation.isPending ||
      recover.isPending ||
      !settledPresentation
    )
      return;
    const ticket = settledPresentation;
    if (
      ticket.request !== presentationRequest.current ||
      !ownsOpening(ticket.owner) ||
      ticket.profileId !== latestAuthority.current.profileId ||
      ticket.sessionId !== latestAuthority.current.sessionId ||
      ticket.revision !== revision.current
    )
      return;
    const key = JSON.stringify([
      ticket.owner,
      pendingCreation.id,
      pendingCreation.profileId,
      pendingCreation.previewDigest,
    ]);
    if (revealedRecovery.current === key) return;
    // Consume this first settlement even when newer intent or a hidden context
    // prevents the handoff. A later GET/rerender must not steal it back.
    revealedRecovery.current = key;
    const summary = recoverySummary.current;
    const surface = publicationSurface.current;
    if (
      suspended ||
      !profile ||
      !summary?.isConnected ||
      !surface?.isConnected ||
      ticket.intent !== presentationIntent.current ||
      document.visibilityState === "hidden" ||
      !document.hasFocus() ||
      summary.closest('[hidden], [inert], [aria-hidden="true"]') ||
      summary.checkVisibility?.() === false ||
      ["hidden", "collapse"].includes(getComputedStyle(summary).visibility)
    )
      return;
    const active = document.activeElement;
    const origin = ticket.origin;
    const lostUnavailableOrigin =
      origin &&
      (!origin.isConnected ||
        origin.matches(":disabled, [aria-disabled='true']")) &&
      (active === document.body ||
        active === document.documentElement ||
        active === surface);
    if (!origin || (active !== origin && !lostUnavailableOrigin)) return;
    // Focus the named summary, never its passive live status or an action.
    summary.focus({ preventScroll: true });
    const body = summary.closest<HTMLElement>("[data-task-overlay-body]");
    if (!body) return;
    const target = summary.getBoundingClientRect();
    const viewport = body.getBoundingClientRect();
    if (target.top < viewport.top || target.bottom > viewport.bottom)
      body.scrollTop = Math.max(
        0,
        body.scrollTop + target.top - viewport.top - 8,
      );
  }, [
    settledPresentation,
    pendingCreation,
    mutation.isPending,
    recover.isPending,
    profile?.id,
    sessionId,
    suspended,
  ]);
  useLayoutEffect(() => {
    // Opening a profile starts a creation session, not finishing its animation.
    // Background refreshes of the same profile must not overwrite user choices.
    opening.current++;
    revision.current++;
    if (!profile) return;
    outputID.current = newID("output");
    creationWasUncertain.current = false;
    mutation.reset();
    inspect.reset();
    recover.reset();
    setPreview(null);
    setReviewedCreation(null);
    setPendingCreation(null);
    form.setFieldsValue({
      name: profile.name,
      mode: "full",
      adapterId: profile.target.adapterId,
    });
  }, [profile?.id, sessionId, form]);
  useLayoutEffect(() => {
    // A completed check must not turn held Enter into a publication gesture.
    // Only its still-open creation session owns this focus change.
    if (
      preview &&
      profile &&
      !suspended &&
      latestAuthority.current.writeReady &&
      reviewFocusVersion.current === revision.current
    )
      reviewStatus.current?.focus();
  }, [preview, profile?.id, suspended]);
  const checkPublication = () => {
    setPreview(null);
    mutation.reset();
    inspect.mutate();
  };
  const publicationReadNotice = displayRead &&
    displayRead.state !== "ready" && (
      <div
        className="subscription-comparison-state text-sm text-muted-foreground"
        role="status"
      >
        <span>
          {displayRead.state === "pending"
            ? "正在核对分流配置…"
            : displayRead.state === "paused"
              ? "当前离线，恢复网络后继续核对。"
              : displayRead.state === "error"
                ? "暂时无法读取分流配置，当前选择已保留。"
                : "此分流配置已不在当前可访问范围。"}
        </span>
        {(displayRead.state === "error" || displayRead.state === "missing") && (
          <ActionButton onClick={displayRead.retry} variant="outline">
            重试配置
          </ActionButton>
        )}
      </div>
    );
  const publicationErrorNotice = displayProfile ? (
    <ProfileValidationNotice
      error={publicationNoticeError}
      ir={displayProfile.ir}
      onRepair={onRepair}
    />
  ) : (
    <ErrorNotice error={publicationNoticeError} />
  );
  const recoveryTitle = recover.isPending
    ? "正在核对发布结果"
    : mutation.isPending
      ? "正在处理本次发布"
      : "上次发布待确认";
  return (
    <>
      <TaskDialog
        title="新增客户端订阅"
        open={!!profile && !suspended}
        footer={
          <div className="w-full space-y-3">
            <p className="text-left text-sm text-muted-foreground">
              {pendingCreation
                ? "核对或重试均沿用上次发布请求。"
                : !preview
                  ? "创建独立的客户端订阅，其他订阅保留原版本。"
                  : bundlePreview
                    ? "新建独立订阅，其他订阅保留原版本。"
                    : "新建独立链接，其他订阅保留原版本。"}
            </p>
            {bundlePreview && (
              <p className="text-left text-sm text-muted-foreground">
                发布后仅提供配置与规则文件包，请下载并导入客户端。
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <ActionButton
                className="min-h-11"
                disabled={busy}
                onClick={onClose}
                variant="outline"
              >
                取消
              </ActionButton>
              {preview?.previewDigest && !pendingCreation && (
                <ActionButton
                  className="min-h-11"
                  disabled={locked || !presentation.writeReady}
                  onClick={checkPublication}
                  variant="outline"
                >
                  重新检查
                </ActionButton>
              )}
              {pendingCreation ? (
                <ActionButton
                  key="retry-publication"
                  className="min-h-11"
                  disabled={busy || !presentation.writeReady}
                  aria-label="重试上次发布"
                  aria-busy={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({
                      retry: pendingCreation,
                      owner: opening.current,
                    })
                  }
                  variant="default"
                  pending={!!mutation.isPending}
                >
                  重试上次发布
                </ActionButton>
              ) : preview?.previewDigest ? (
                <ActionButton
                  key="confirm-publication"
                  onClick={(event) => {
                    // Ignore the continuation of a double-click on Check.
                    if (event.detail <= 1) form.submit();
                  }}
                  className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere"
                  aria-label={`创建并发布「${reviewedCreation?.name || "新订阅"}」`}
                  aria-busy={mutation.isPending}
                  disabled={
                    !preview?.previewDigest || busy || !presentation.writeReady
                  }
                  variant="default"
                  pending={!!mutation.isPending}
                >
                  创建并发布「
                  {reviewedCreation?.name || "新订阅"}」
                </ActionButton>
              ) : (
                <ActionButton
                  key="check-publication"
                  className="min-h-11"
                  aria-label="检查发布内容"
                  aria-busy={inspect.isPending}
                  disabled={locked || !presentation.writeReady}
                  onClick={checkPublication}
                  variant={pendingCreation ? "outline" : "default"}
                  pending={!!inspect.isPending}
                >
                  检查发布内容
                </ActionButton>
              )}
            </div>
          </div>
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen)
            (() => {
              if (!busy) onClose();
            })();
        }}
        size="lg"
        contentRef={publicationSurface}
        contentProps={{
          inert: !profile || suspended,
          onPointerDownCapture: () => {
            presentationIntent.current++;
          },
          onWheelCapture: () => {
            presentationIntent.current++;
          },
          onFocusCapture: (event) => {
            if (event.target === event.currentTarget) return;
            presentationIntent.current++;
            if (
              event.target instanceof HTMLElement &&
              event.currentTarget.contains(event.target)
            )
              publicationFocus.current = {
                owner: opening.current,
                node: event.target,
              };
          },
          onKeyDownCapture: (event) => {
            if (!event.repeat) presentationIntent.current++;
          },
        }}
      >
        <AppForm
          form={form}
          disabled={busy}
          onValuesChange={() => {
            revision.current++;
            setPreview(null);
          }}
          onFinish={() =>
            mutation.mutate({
              retry: pendingCreation || undefined,
              owner: opening.current,
            })
          }
        >
          <p>
            分流配置：<strong>{displayProfile?.name}</strong>
          </p>
          {pendingCreation ? (
            <section
              ref={recoverySummary}
              className="surface output-access-state rounded-lg border bg-card p-5 space-y-4"
              aria-label="发布结果与恢复"
              aria-describedby={recoveryOutcomeId}
              tabIndex={-1}
            >
              <div className="section-heading mb-4 flex flex-wrap items-center justify-between gap-3 [&>h3]:font-semibold">
                <h2>{recoveryTitle}</h2>
              </div>
              <p role="status" aria-label={recoveryTitle}>
                <span id={recoveryOutcomeId}>
                  {recover.isPending
                    ? `正在查询「${pendingCreation.name}」上次提交的发布结果。`
                    : mutation.isPending
                      ? `正在处理「${pendingCreation.name}」的发布，结果尚未确认。`
                      : `尚未确认「${pendingCreation.name}」是否已发布。核对或重试只使用上次提交的内容。`}
                </span>
              </p>
              {publicationReadNotice}
              {publicationErrorNotice}
              <ErrorNotice error={recover.error} />
              <ActionButton
                aria-label="核对上次发布结果"
                aria-busy={recover.isPending}
                disabled={busy}
                onClick={() => recover.mutate(opening.current)}
                variant="outline"
                pending={
                  !!(
                    recover.isPending && {
                      icon: <LoaderCircle aria-hidden="true" />,
                    }
                  )
                }
              >
                核对上次发布结果
              </ActionButton>
            </section>
          ) : (
            <>
              {publicationReadNotice}
              {publicationErrorNotice}
            </>
          )}
          {pendingCreation && (
            <h2 className="mb-4 font-medium">本次发布的选项</h2>
          )}
          <AppField
            name="name"
            label="订阅名称"
            rules={[
              { required: true, whitespace: true, message: "请输入订阅名称" },
            ]}
          >
            <Input disabled={locked} />
          </AppField>
          <AppField
            name="adapterId"
            label="目标客户端"
            rules={[{ required: true }]}
            trigger="onValueChange"
          >
            <ChoiceSelect disabled={locked} options={clientTargets} />
          </AppField>
          <AppField
            name="mode"
            label="输出内容"
            rules={[{ required: true }]}
            trigger="onValueChange"
          >
            <ChoiceSelect
              disabled={locked}
              options={[
                { value: "full", label: "完整客户端配置" },
                { value: "nodes-only", label: "纯节点输出" },
              ]}
            />
          </AppField>
          <p className="muted text-sm text-muted-foreground">
            {mode === "nodes-only"
              ? "仅包含节点连接。"
              : "包含连接、策略组、分流规则和运行设置。"}
          </p>
          {preview && (
            <Section
              title={pendingCreation ? "发布前的检查结果" : "待发布内容"}
            >
              <p
                ref={reviewStatus}
                tabIndex={pendingCreation ? undefined : -1}
                role={pendingCreation ? undefined : "status"}
              >
                {pendingCreation
                  ? "发布前的兼容检查已通过。"
                  : "兼容检查通过。"}
              </p>
              {!(
                mode === "nodes-only" &&
                preview.routingSummary?.version === 1 &&
                preview.routingSummary.kind === "nodes-only"
              ) && (
                <RoutingSummaryView
                  summary={preview.routingSummary}
                  intent={preview.routingIntent}
                />
              )}
              {preview.diagnostics?.map((d, i) => (
                <Notice
                  key={i}
                  tone={preview.valid === false ? "warning" : "info"}
                  title={d}
                />
              ))}
              <PublicationTechnicalPreview artifacts={preview.artifacts} />
            </Section>
          )}
        </AppForm>
      </TaskDialog>
      <AccessSubscription output={created} onClose={() => setCreated(null)} />
    </>
  );
}
function accessChanged(error: unknown) {
  return (
    error instanceof APIError &&
    error.status === 409 &&
    typeof error.details === "object" &&
    error.details !== null &&
    "code" in error.details &&
    error.details.code === "OUTPUT_ACCESS_CHANGED"
  );
}
function hasAccessRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value);
}
// Allowlist metadata: mutation responses must never retain bearer access paths.
function accessMetadata(output: Output): Output {
  return {
    id: output.id,
    name: output.name,
    profileId: output.profileId,
    target: { adapterId: output.target.adapterId, version: output.target.version },
    mode: output.mode,
    status: output.status,
    revision: output.revision,
    accessRevision: output.accessRevision,
    delivery: output.delivery,
    createdAt: output.createdAt,
    updatedAt: output.updatedAt,
    publishedAt: output.publishedAt,
  };
}
function accessOutputIdentity(output: Output) {
  return JSON.stringify([
    output.id,
    output.revision,
    output.accessRevision,
    output.profileId,
    output.target.adapterId,
    output.target.version,
    output.mode,
    output.status,
  ]);
}
export function AccessSubscription(props: {
  output: Output | null;
  onClose: () => void;
  replacement?: "rotation" | "publication";
  rotationUncertain?: boolean;
}) {
  // Task ownership ends immediately, while AntD retains its supported exit
  // lifecycle to restore the trigger. A reopened task gets fresh read ownership.
  const [surface, setSurface] = useState({
    output: props.output,
    open: !!props.output,
    generation: 0,
  });
  let current = surface;
  if (
    props.output &&
    (!surface.open || props.output.id !== surface.output?.id)
  ) {
    current = {
      output: props.output,
      open: true,
      generation: surface.generation + 1,
    };
    setSurface(current);
  } else if (props.output && props.output !== surface.output) {
    current = { ...surface, output: props.output };
    setSurface(current);
  } else if (!props.output && surface.open) {
    current = { ...surface, open: false };
    setSurface(current);
  }
  if (!current.output) return null;
  return (
    <OutputAccessTask
      key={current.generation}
      {...props}
      output={props.output || current.output}
      open={current.open}
      onExited={() =>
        setSurface((latest) =>
          latest.generation === current.generation && !latest.open
            ? { ...latest, output: null }
            : latest,
        )
      }
    />
  );
}
function OutputAccessTask({
  output: initialOutput,
  open,
  onExited,
  onClose,
  replacement,
  rotationUncertain = false,
}: {
  output: Output;
  open: boolean;
  onExited: () => void;
  onClose: () => void;
  replacement?: "rotation" | "publication";
  rotationUncertain?: boolean;
}) {
  const [output, setOutput] = useState(initialOutput);
  const [readOwner] = useState(() => newID("output-access"));
  const [readGeneration, setReadGeneration] = useState(0);
  const [review, setReview] = useState(false);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  // A nested review hides/reopens this surface. rc-dialog would recapture the
  // detached review button as its trigger; keep this task's original trigger.
  const [openingTrigger] = useState(() =>
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const surfaceContent = useRef<HTMLDivElement>(null);
  const accessState = useRef<HTMLDivElement>(null);
  const returnToRecovery = useRef(false);
  const published = useRef(false);
  const [contentPublished, setContentPublished] = useState(false);
  const active = useRef(open);
  active.current = open;
  const surfaceShown = useRef(false);
  const inputIdentity = accessOutputIdentity(initialOutput);
  const latestIdentity = useRef(inputIdentity);
  latestIdentity.current = inputIdentity;
  const [seenIdentity, setSeenIdentity] = useState(inputIdentity);
  if (seenIdentity !== inputIdentity) {
    setSeenIdentity(inputIdentity);
    setOutput(initialOutput);
    setContentPublished(false);
    setReview(false);
    setReadGeneration((generation) => generation + 1);
    returnToRecovery.current = false;
  }
  useEffect(() => {
    active.current = open;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open && review && !surfaceShown.current) onExited();
  }, [open, review]);
  const message = toast;
  const query = useQuery({
    queryKey: [
      "output-access",
      output.id,
      output.revision,
      output.accessRevision,
      readOwner,
      readGeneration,
    ],
    queryFn: async () => {
      const result = await request<{
        feedURL?: string;
        feedPath?: string;
        delivery?: "feed" | "bundle";
        bundleURL?: string;
        bundlePath?: string;
        downloadPath?: string;
      }>(`/me/outputs/${output!.id}/access`);
      if (
        result.delivery === "bundle"
          ? !result.downloadPath
          : !result.feedURL && !result.feedPath
      )
        throw new Error("暂时无法获取订阅链接，请重试。");
      return result;
    },
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const errorCode =
    query.error instanceof APIError && query.error.status === 409
      ? (
          query.error.details as
            | {
                code?: string;
              }
            | undefined
        )?.code
      : undefined;
  const readiness =
    errorCode === "OUTPUT_ENTRY_UNCONFIRMED" ||
    errorCode === "OUTPUT_REPUBLISH_REQUIRED"
      ? errorCode
      : undefined;
  const paused = query.fetchStatus === "paused";
  const accessReady = query.isSuccess && query.fetchStatus === "idle";
  const path = accessReady
    ? query.data?.feedURL || query.data?.feedPath
    : undefined;
  const url = path ? new URL(path, location.origin).href : undefined;
  const bundle = accessReady && query.data?.delivery === "bundle";
  const bundleDownload = bundle
    ? `/api/me/outputs/${encodeURIComponent(output.id)}/bundle`
    : undefined;
  const tokenDownload = usesTokenAuthentication();
  const [downloading, setDownloading] = useState(false);
  const downloadPending = useRef<AbortController | null>(null);
  const downloadLifetime = useRef({ active: false, epoch: 0 });
  // A harmless background refetch does not revoke an already authorized read.
  // A rejected read or changed delivery does, even without opening recovery.
  const downloadUnavailable = query.isError ||
    (query.isSuccess && query.data?.delivery !== "bundle");
  useLayoutEffect(() => {
    const lifetime = downloadLifetime.current;
    lifetime.active = open && !review && !downloadUnavailable;
    if (lifetime.active) setDownloading(!!downloadPending.current);
    return () => {
      // Revoke during commit, before passive cleanup or promise continuations.
      // A return to the same inputs never revives an earlier download.
      lifetime.active = false;
      lifetime.epoch++;
      const pending = downloadPending.current;
      downloadPending.current = null;
      pending?.abort();
    };
  }, [open, review, inputIdentity, readGeneration, downloadUnavailable]);
  const downloadBundle = async () => {
    if (!active.current || review || !bundle || downloadPending.current) return;
    const owner = downloadLifetime.current.epoch;
    const ownsDownload = () =>
      active.current && downloadLifetime.current.active &&
      downloadLifetime.current.epoch === owner;
    if (!ownsDownload()) return;
    const controller = new AbortController();
    downloadPending.current = controller;
    setDownloading(true);
    try {
      const result = await requestOutputBundle(output.id, controller.signal);
      if (!ownsDownload()) return;
      result.assertCurrent();
      const objectURL = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      try {
        link.href = objectURL;
        link.download = `${output.name || "config"}.zip`;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
      }
    } catch {
      if (ownsDownload()) message.error("无法下载配置包，请确认登录状态后重试。");
    } finally {
      // An obsolete completion must not release a newer request's busy state.
      if (downloadPending.current === controller) {
        downloadPending.current = null;
        if (ownsDownload()) setDownloading(false);
      }
    }
  };
  const accessDelivery = accessReady
    ? query.data?.delivery || output?.delivery
    : output?.delivery;
  const copy = async () => {
    try {
      if (!active.current || !url) return;
      await navigator.clipboard.writeText(url);
      if (active.current) message.success("订阅链接已复制");
    } catch {
      if (!active.current) return;
      message.warning("自动复制未成功，请在下方选中链接手动复制。");
    }
  };
  return (
    <>
      <TaskDialog
        title={output ? `获取「${output.name}」` : "获取订阅"}
        open={open && !review}
        footer={null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen)
            (() => {
              if (active.current) onClose();
            })();
        }}
        onReady={() =>
          ((visible) => {
            surfaceShown.current = visible;
            if (!visible) return;
            const restore = returnToRecovery.current;
            returnToRecovery.current = false;
            if (
              restore &&
              readiness === "OUTPUT_REPUBLISH_REQUIRED" &&
              !query.isFetching
            )
              recoveryButton.current?.focus({ preventScroll: true });
          })(true)
        }
        onClosed={() => {
          if (open) return;
          const focused = document.activeElement;
          if (
            openingTrigger?.isConnected &&
            !openingTrigger.closest("[inert]") &&
            !openingTrigger.matches(":disabled") &&
            (focused === document.body ||
              surfaceContent.current?.contains(focused))
          )
            openingTrigger.focus({ preventScroll: true });
          onExited();
        }}
        size={url && !bundle ? "lg" : "md"}
        contentRef={surfaceContent}
        contentProps={{
          onPointerDownCapture: () => {
            returnToRecovery.current = false;
          },
          onKeyDownCapture: () => {
            returnToRecovery.current = false;
          },
        }}
      >
        <div inert={!open} className="space-y-4">
          {rotationUncertain && (
            <Notice tone="warning" title="链接更换结果尚未确认">
              此处只显示当前可获取的访问方式，不能确认上次更换是否完成，也不能确认旧链接仍有效。请勿重复更换。
            </Notice>
          )}
          {replacement && !rotationUncertain && (
            <Notice
              tone="success"
              title={
                accessDelivery === "feed" ? "新链接已生成" : "访问凭据已更换"
              }
            >
              {accessDelivery === "bundle"
                ? replacement === "rotation" && !contentPublished
                  ? "旧下载链接已失效。配置包内容不变，无需因此重新导入。其他订阅保留原状。"
                  : "旧下载链接已失效，请重新下载配置包并导入客户端。其他订阅保留原状。"
                : accessDelivery === "feed"
                  ? "旧链接已失效，请将新链接重新添加到客户端。其他订阅保留原状。"
                  : "旧链接已失效，请获取最新订阅内容并更新客户端。其他订阅保留原状。"}
            </Notice>
          )}
          {paused && (
            <Notice role="status" tone="warning" title="当前离线">
              {"恢复网络后会继续获取订阅。"}
            </Notice>
          )}
          <div
            ref={accessState}
            className="output-access-state space-y-4"
            role="region"
            aria-label="订阅获取状态"
            aria-busy={query.isFetching}
            tabIndex={-1}
          >
            <QueryState
              loading={query.isFetching}
              error={
                paused || readiness
                  ? null
                  : query.error
                    ? new Error("暂时无法获取此订阅，请稍后重试。")
                    : null
              }
              retry={() => {
                if (active.current) void query.refetch();
              }}
            >
              {readiness && !query.isFetching && !paused && (
                <Notice
                  tone="warning"
                  className="output-access-notice mb-4"
                  role="status"
                  aria-live="polite"
                  title={
                    readiness === "OUTPUT_ENTRY_UNCONFIRMED"
                      ? "平台入口尚未确认可用"
                      : "此订阅需要更新"
                  }
                  action={
                    readiness === "OUTPUT_ENTRY_UNCONFIRMED" ? (
                      <ActionButton
                        onClick={() => {
                          if (!active.current) return;
                          accessState.current?.focus({ preventScroll: true });
                          void query.refetch();
                        }}
                        variant="default"
                      >
                        重新核对
                      </ActionButton>
                    ) : (
                      <ActionButton
                        ref={recoveryButton}
                        onClick={() => {
                          if (!active.current) return;
                          published.current = false;
                          setReview(true);
                        }}
                        variant="default"
                      >
                        检查更新
                      </ActionButton>
                    )
                  }
                />
              )}
              {bundleDownload && (
                <div className="space-y-4 [&>h3]:font-semibold">
                  <h3>配置与规则文件包</h3>
                  <p>
                    这份配置引用私有规则文件，需要一起下载。解压后保留文件夹结构，将配置与
                    rules 文件夹放在客户端配置目录。
                  </p>
                  {tokenDownload ? (
                    <ActionButton
                      variant="default"
                      disabled={downloading}
                      aria-busy={downloading}
                      onClick={() => void downloadBundle()}
                    >
                      <Download aria-hidden="true" />
                      下载配置与规则文件
                    </ActionButton>
                  ) : (
                    <ActionButton variant="default" asChild={true}>
                      <a
                        href={bundleDownload}
                        download={`${output?.name || "config"}.zip`}
                      >
                        <Download aria-hidden="true" />
                        下载配置与规则文件
                      </a>
                    </ActionButton>
                  )}
                  <p className="access-note text-sm text-muted-foreground">
                    配置包包含连接凭据与私有规则，请仅导入可信客户端。配置内容更新后需重新下载整个配置包。
                  </p>
                </div>
              )}
              {url && !bundle && (
                <div className="space-y-5">
                  <div className="access-client flex items-center gap-3 rounded-lg bg-muted/50 p-4">
                    <Link
                      aria-hidden="true"
                      className="size-5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <h3 className="font-semibold wrap-anywhere">
                        {output?.target?.adapterId}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {output?.mode === "nodes-only"
                          ? "纯节点输出"
                          : "完整客户端配置"}
                      </p>
                    </div>
                    <Badge className="shrink-0" variant="secondary">
                      已发布
                    </Badge>
                  </div>
                  <div className="grid items-start gap-5 sm:grid-cols-[auto_minmax(0,1fr)]">
                    <div className="qr-container mx-auto flex justify-center rounded-lg border bg-white p-4 sm:mx-0">
                      <SubscriptionQRCode value={url} />
                    </div>
                    <div className="min-w-0 space-y-4">
                      <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                        你的订阅链接
                        <Input
                          value={url}
                          readOnly
                          aria-label="订阅链接"
                          onFocus={(e) => e.target.select()}
                        />
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <ActionButton
                          leadingIcon={<Copy aria-hidden="true" />}
                          onClick={copy}
                          variant="default"
                        >
                          复制订阅链接
                        </ActionButton>
                        <ActionButton variant="outline" asChild={true}>
                          <a
                            href={url}
                            download={`${output?.name || "config"}.${output?.target.adapterId === "mihomo" ? "yaml" : "json"}`}
                          >
                            {<Download aria-hidden="true" />}
                            下载配置
                          </a>
                        </ActionButton>
                      </div>
                      <p className="access-note text-sm leading-relaxed text-muted-foreground">
                        链接包含访问凭据，请仅添加到你信任的客户端。
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </QueryState>
          </div>
        </div>
      </TaskDialog>
      {open && review && (
        <UpdateOutput
          key={seenIdentity}
          output={output}
          autoInspect
          onPublished={(result) => {
            if (!active.current || latestIdentity.current !== seenIdentity)
              return;
            published.current = true;
            setContentPublished(true);
            returnToRecovery.current = false;
            setOutput(result);
            setReadGeneration((generation) => generation + 1);
          }}
          onClose={() => {
            if (!active.current || latestIdentity.current !== seenIdentity)
              return;
            returnToRecovery.current = !published.current;
            setReview(false);
          }}
        />
      )}
    </>
  );
}
export function UpdateOutput({
  output,
  onClose,
  onPublished,
  autoInspect = false,
  profileName,
  usesAcceptedSources = false,
  repairProfile,
  onRepair,
  suspended = false,
  openingTrigger,
}: {
  output: Output;
  repairProfile?: Profile;
  onRepair?: (issue: MissingActionReference) => void;
  suspended?: boolean;
  openingTrigger?: HTMLElement | null;
  profileName?: string;
  usesAcceptedSources?: boolean;
  onClose: () => void;
  onPublished?: (output: Output, replaced: boolean) => void;
  autoInspect?: boolean;
}) {
  const client = useQueryClient(),
    message = toast;
  type Inspection = {
    id: string;
    name: string;
    profileId: string;
    target: Output["target"];
    mode: string;
    generation: number;
  };
  type Review = Inspection & {
    preview: Preview;
    link?: "preserve" | "replace";
  };
  type Approval = Inspection & {
    digest: string;
    link: "preserve" | "replace";
  };
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [closing, setClosing] = useState(false);
  const closingGeneration = useRef<number | null>(null);
  const surfaceContent = useRef<HTMLDivElement>(null);
  const focusOutputID = useRef(output.id);
  const returnFocusTarget = useRef<HTMLElement | null>(
    openingTrigger !== undefined
      ? openingTrigger
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
  );
  const generation = useRef(0);
  const active = useRef(false);
  const writing = useRef(false);
  const current = (attempt: Inspection) =>
    active.current && attempt.generation === generation.current;
  const inspect = useMutation({
    mutationFn: (attempt: Inspection) =>
      post<Preview>(`/me/profiles/${attempt.profileId}/preview`, {
        outputId: attempt.id,
        target: attempt.target,
        mode: attempt.mode,
      }),
    onSuccess: (value, attempt) => {
      if (!current(attempt)) return;
      if (
        !value ||
        typeof value !== "object" ||
        value.outputId !== attempt.id ||
        value.previewScope !== "output-update" ||
        typeof value.previewDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.previewDigest)
      ) {
        setError(new Error("检查结果与此订阅不匹配，请重新检查。"));
        return;
      }
      const effect = value.publicationEffect;
      const link =
        effect?.version === 1 &&
        (effect.link === "preserve" || effect.link === "replace")
          ? effect.link
          : undefined;
      setReview({ ...attempt, preview: value, link });
    },
    onError: (failure, attempt) => {
      if (current(attempt)) setError(failure);
    },
  });
  const publish = useMutation({
    onMutate: (approved: Approval) =>
      invalidateOutputPublication(client, approved.id),
    onSettled: (_result, _failure, approved) => {
      // The write belongs to its approved output, even after the UI task expires.
      invalidateOutputPublication(client, approved.id);
      client.invalidateQueries({ queryKey: ["outputs"], exact: true });
      client.invalidateQueries({
        queryKey: ["outputs", approved.id, "status"],
        exact: true,
      });
      if (current(approved)) writing.current = false;
    },
    mutationFn: (approved: Approval) =>
      post<Output>(`/me/outputs/${approved.id}/publish`, {
        previewDigest: approved.digest,
      }),
    onSuccess: (result, approved) => {
      if (!current(approved)) return;
      message.success(`「${approved.name}」已更新，其他客户端订阅保留原版本`);
      active.current = false;
      generation.current++;
      onPublished?.(result, approved.link === "replace");
      onClose();
    },
    onError: (failure, approved) => {
      if (!current(approved)) return;
      setError(failure);
      if (failure instanceof APIError && failure.status === 409)
        setReview(null);
    },
  });
  const check = () => {
    if (!active.current || writing.current) return;
    generation.current++;
    setReview(null);
    setError(null);
    publish.reset();
    inspect.mutate({
      id: output.id,
      name: output.name,
      profileId: output.profileId,
      target: { ...output.target },
      mode: output.mode,
      generation: generation.current,
    });
  };
  useLayoutEffect(() => {
    closingGeneration.current = null;
    setClosing(false);
    if (focusOutputID.current !== output.id) {
      returnFocusTarget.current = openingTrigger || null;
      focusOutputID.current = output.id;
    }
    generation.current++;
    active.current = !suspended;
    writing.current = false;
    inspect.reset();
    publish.reset();
    setReview(null);
    setError(null);
    if (!suspended && autoInspect) {
      // A committed opening owns one inspection. React StrictMode replays the
      // setup/cleanup pair; do not dispatch an obsolete request during that
      // replay or race a newer authoritative result against a second preview.
      const openingGeneration = generation.current;
      queueMicrotask(() => {
        if (active.current && generation.current === openingGeneration) check();
      });
    }
    return () => {
      active.current = false;
      generation.current++;
    };
  }, [
    output.id,
    output.profileId,
    output.target.adapterId,
    output.target.version,
    output.mode,
    suspended,
  ]);
  const close = () => {
    if (!active.current || writing.current) return;
    // Consent expires now; keep only the closing surface through its lifecycle.
    active.current = false;
    generation.current++;
    closingGeneration.current = generation.current;
    setClosing(true);
  };
  const preview = review?.preview;
  const bundlePreview = previewUsesBundle(preview);
  const unknownEffect = preview?.valid === true && !review?.link;
  const label =
    review?.link === "replace"
      ? bundlePreview
        ? "重新发布配置包"
        : "重新发布并生成新链接"
      : "确认更新";
  const confirm = () => {
    if (
      !review?.link ||
      !preview?.previewDigest ||
      preview.valid !== true ||
      !current(review) ||
      inspect.isPending ||
      writing.current
    )
      return;
    writing.current = true;
    setError(null);
    // Primitive effect and digest are copied at the explicit approval event.
    publish.mutate({
      id: review.id,
      name: review.name,
      profileId: review.profileId,
      target: { ...review.target },
      mode: review.mode,
      generation: review.generation,
      digest: preview.previewDigest,
      link: review.link,
    });
  };
  return (
    <TaskDialog
      title={
        <span aria-label={`检查订阅更新「${review?.name || output.name}」`}>
          检查订阅更新
        </span>
      }
      className="update-output-review"
      scrollMode="auto"
      bodyProps={{ className: "space-y-5" }}
      open={!suspended && !closing}
      footer={
        <div
          className="update-output-decision min-w-0 w-full space-y-3 text-left wrap-anywhere"
          role="group"
          aria-label="更新确认"
        >
          <p>
            更新订阅：<strong>{review?.name || output.name}</strong>
          </p>
          {review?.link && preview?.valid === true && (
            <p>
              {bundlePreview
                ? `${review.link === "replace" ? "重新发布将更换访问凭据。" : ""}发布后仅提供配置与规则文件包，请下载并导入客户端。其他订阅保留原状。`
                : review.link === "replace"
                  ? "发布后请在客户端换用新链接，其他订阅保留原状。"
                  : "沿用当前链接，其他订阅保留原状。"}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <ActionButton
              className="min-h-11"
              disabled={publish.isPending}
              onClick={close}
              variant="outline"
            >
              取消
            </ActionButton>
            <ActionButton
              className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere"
              aria-label={`${label}「${review?.name || output.name}」`}
              aria-busy={publish.isPending}
              disabled={
                !review?.link ||
                !preview?.previewDigest ||
                preview.valid !== true ||
                inspect.isPending
              }
              onClick={confirm}
              variant="default"
              pending={!!publish.isPending}
            >
              {label}
            </ActionButton>
          </div>
        </div>
      }
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      onClosed={() => {
        if (
          !closing ||
          suspended ||
          closingGeneration.current !== generation.current
        )
          return;
        closingGeneration.current = null;
        const target = returnFocusTarget.current;
        const focused = document.activeElement;
        if (
          target &&
          target !== document.body &&
          target.isConnected &&
          !target.closest('[hidden], [inert], [aria-hidden="true"]') &&
          !target.matches(':disabled, [aria-disabled="true"]') &&
          target.checkVisibility?.() !== false &&
          getComputedStyle(target).visibility !== "hidden" &&
          (focused === document.body ||
            surfaceContent.current?.contains(focused))
        ) {
          target.focus({ preventScroll: true });
        }
        // A parent may open the next task; never restore the old trigger after it.
        onClose();
      }}
      size="lg"
      contentRef={surfaceContent}
    >
      <ProfileValidationNotice
        error={error}
        ir={repairProfile?.ir}
        onRepair={onRepair}
        publicationTarget={output.target}
      />
      <div className="update-output-identity space-y-2 rounded-lg border bg-muted/30 p-4 wrap-anywhere">
        <p className="update-output-name text-lg font-semibold">
          订阅：<strong>{review?.name || output.name}</strong>
        </p>
        {profileName && <p>分流配置：{profileName}</p>}
        <p>
          <Metadata>
            <MetadataItem>{output.target.adapterId} {output.target.version}</MetadataItem>
            <MetadataItem>{output.mode === "nodes-only" ? "纯节点" : "完整配置"}</MetadataItem>
          </Metadata>
        </p>
      </div>
      {unknownEffect && (
        <Notice tone="error" title="无法确认链接变化，请重新检查。" />
      )}
      <div className="update-output-status flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-4">
        {preview && (
          <p role="status">
            {preview.valid === true
              ? "兼容检查通过。"
              : "兼容检查未通过，已发布内容保留原版本。"}
          </p>
        )}
        <ActionButton
          disabled={publish.isPending}
          onClick={check}
          variant="outline"
          pending={!!inspect.isPending}
        >
          {preview ? "重新检查" : "预览此订阅更新"}
        </ActionButton>
      </div>
      {preview && (
        <div className="update-output-evidence space-y-3">
          {output.mode !== "nodes-only" && (
            <SemanticOutputChanges
              value={preview.semanticChanges}
              unchangedContext={
                usesAcceptedSources
                  ? "比较使用当前已应用的来源内容；手动模式的更新需先应用到来源，再重新比较。"
                  : undefined
              }
            />
          )}
          {output.mode === "nodes-only" && preview.nodeChanges ? (
            <NodeChanges value={preview.nodeChanges} />
          ) : (
            <RoutingReview
              decisionReview
              companionCategories={
                output.mode !== "nodes-only"
                  ? { groups: true, nodes: true }
                  : undefined
              }
              published={preview.publishedRoutingSummary}
              candidate={preview.routingSummary}
              publishedIntent={preview.publishedRoutingIntent}
              candidateIntent={preview.routingIntent}
            />
          )}
          {output.mode !== "nodes-only" && (
            <SemanticOutputChanges
              value={preview.semanticChanges}
              unchangedOnly
            />
          )}
          {preview.diagnostics?.map((d, i) => (
            <Notice
              key={i}
              tone={preview.valid === false ? "warning" : "info"}
              title={d}
            />
          ))}
          {preview.valid === true &&
            preview.platformEntryRefresh?.version === 1 &&
            Number.isSafeInteger(preview.platformEntryRefresh.count) &&
            preview.platformEntryRefresh.count > 0 && (
              <p>
                将采用 {preview.platformEntryRefresh.count}{" "}
                个平台入口的最新连接信息。
              </p>
            )}
          <PublicationTechnicalPreview
            artifacts={preview.artifacts}
            label="查看待发布技术配置"
          />
        </div>
      )}
    </TaskDialog>
  );
}
/** One explicit publication target for a shared Profile; missing context never means create. */
export function ProfilePublicationDialog({
  profile,
  preferredOutput,
  onClose,
  onPublished,
  onRepair,
  suspended = false,
}: {
  profile: Profile;
  preferredOutput?: Output;
  onClose: () => void;
  onPublished?: (output: Output, created: boolean, replaced?: boolean) => void;
  onRepair?: (issue: MissingActionReference) => void;
  suspended?: boolean;
}) {
  const query = useQuery({
    queryKey: ["outputs"],
    queryFn: () => list<Output>("/me/outputs"),
    staleTime: 0,
  });
  const [target, setTarget] = useState<string | undefined>(preferredOutput?.id);
  const [review, setReview] = useState<Output | "new" | null>(null);
  const chooserOwner = useRef({ profile, preferredOutput });
  if (
    chooserOwner.current.profile !== profile ||
    chooserOwner.current.preferredOutput !== preferredOutput
  )
    chooserOwner.current = { profile, preferredOutput };
  const owner = chooserOwner.current;
  const [entry] = useState(() => ({ owner, opener: document.activeElement }));
  const chooserSurface = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState<{
    owner: typeof owner;
    panel: HTMLElement | null;
    hash: string;
    finish: () => void;
  } | null>(null);
  const closeClaim = useRef<typeof closing>(null);
  const active = useRef(true);
  const liveChooser = useRef({ owner, suspended, review });
  liveChooser.current = { owner, suspended, review };
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      closeClaim.current = null;
    };
  }, []);
  const chooserClosing = closing?.owner === owner;
  const closeChooser = () => {
    if (
      !active.current ||
      liveChooser.current.owner !== owner ||
      liveChooser.current.suspended ||
      liveChooser.current.review ||
      closeClaim.current?.owner === owner
    )
      return;
    const task = {
      owner,
      panel:
        chooserSurface.current?.closest<HTMLElement>('[role="dialog"]') || null,
      hash: window.location.hash,
      finish: onClose,
    };
    closeClaim.current = task;
    setClosing(task);
  };
  const paused = query.fetchStatus === "paused";
  const links = (Array.isArray(query.data) ? query.data : []).filter(
    (output) => output.profileId === profile.id,
  );
  const targetsReady =
    query.isFetchedAfterMount &&
    query.isSuccess &&
    query.fetchStatus === "idle";
  const enterFirstCreation =
    !review &&
    !chooserClosing &&
    !suspended &&
    targetsReady &&
    links.length === 0 &&
    !preferredOutput &&
    !target;
  useEffect(() => {
    // Render the confirmed first form immediately; retain its session so a
    // later list refresh cannot replace it or erase the user's choices.
    if (enterFirstCreation && closeClaim.current?.owner !== owner)
      setReview("new");
  }, [enterFirstCreation, owner]);
  const selectedOutput = links.find((output) => output.id === target);
  const preferredUnavailable =
    preferredOutput &&
    targetsReady &&
    !links.some((output) => output.id === preferredOutput.id);
  if (review === "new" || enterFirstCreation)
    return (
      <PublishOutput
        profile={profile}
        onClose={onClose}
        onPublished={(output) => onPublished?.(output, true)}
        onRepair={onRepair}
        suspended={suspended}
      />
    );
  if (review)
    return (
      <UpdateOutput
        output={review}
        profileName={profile.name}
        usesAcceptedSources={
          !!(profile.sourceIds?.length || profile.collectionId)
        }
        repairProfile={profile}
        onRepair={onRepair}
        suspended={suspended}
        onClose={onClose}
        onPublished={(output, replaced) =>
          onPublished?.(output, false, replaced)
        }
        autoInspect
      />
    );
  return (
    <TaskDialog
      title="选择客户端订阅"
      open={!suspended && !chooserClosing}
      footer={null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeChooser();
      }}
      onClosed={() => {
        const task = closing;
        if (
          !task ||
          !active.current ||
          closeClaim.current !== task ||
          liveChooser.current.owner !== task.owner ||
          liveChooser.current.review
        )
          return;
        closeClaim.current = null;
        const focused = document.activeElement;
        const opener = entry.opener;
        // Only this explicit cancellation can return the exact entry focus.
        // Suspended parents and newer controls retain their own focus handoff.
        if (
          !liveChooser.current.suspended &&
          entry.owner === task.owner &&
          window.location.hash === task.hash &&
          document.hasFocus() &&
          document.visibilityState === "visible" &&
          (focused === document.body ||
            (focused instanceof Node && task.panel?.contains(focused))) &&
          opener instanceof HTMLElement &&
          opener !== document.body &&
          opener.isConnected &&
          !opener.closest('[hidden], [inert], [aria-hidden="true"]') &&
          !opener.matches(':disabled, [aria-disabled="true"]') &&
          opener.getClientRects().length > 0 &&
          !["hidden", "collapse"].includes(getComputedStyle(opener).visibility)
        )
          opener.focus();
        task.finish();
      }}
      contentRef={chooserSurface}
      size="md"
    >
      <p>
        分流配置：<strong>{profile.name}</strong>
      </p>
      <p role="status">草稿已保存</p>
      {paused && (
        <Notice role="status" tone="warning" title="当前离线">
          {"恢复网络后会继续读取客户端订阅。"}
        </Notice>
      )}
      {preferredUnavailable && (
        <Notice
          tone="warning"
          title={`「${preferredOutput.name}」已不在此配置的订阅列表中`}
        >
          {"请重新选择发布目标。未自动新增或切换到其他订阅。"}
        </Notice>
      )}
      <QueryState
        loading={query.isFetching}
        error={paused ? null : query.error}
        retry={() => query.refetch()}
      >
        {targetsReady && (
          <RadioGroup
            aria-label="本次发布目标"
            value={target}
            disabled={chooserClosing}
            onValueChange={(value) =>
              ((event) => {
                if (closeClaim.current?.owner !== owner)
                  setTarget(event.target.value);
              })({ target: { value } })
            }
          >
            <div className="grid w-full gap-3">
              {links.map((output) => (
                <Label
                  key={output.id}
                  className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-4 leading-relaxed wrap-anywhere has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50"
                >
                  <RadioGroupItem value={output.id} />
                  <span className="min-w-0 space-y-1">
                    <span className="block font-medium">更新「{output.name}」</span>{" "}
                    <Metadata className="text-sm font-normal text-muted-foreground">
                      <MetadataItem>{output.target.adapterId}</MetadataItem>
                      <MetadataItem>{output.mode === "nodes-only" ? "纯节点" : "完整配置"}</MetadataItem>
                      {output.status === "revoked" && <MetadataItem>已撤销（需重新发布）</MetadataItem>}
                    </Metadata>
                  </span>
                </Label>
              ))}
              <Label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 leading-relaxed has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50">
                <RadioGroupItem value={"new"} />
                创建新的客户端订阅
              </Label>
            </div>
          </RadioGroup>
        )}
      </QueryState>
      <div className="form-footer mt-6 flex flex-wrap items-center justify-end gap-2">
        <ActionButton
          disabled={chooserClosing}
          onClick={closeChooser}
          variant="outline"
        >
          返回编辑
        </ActionButton>
        <ActionButton
          disabled={
            chooserClosing ||
            (target !== "new" && !selectedOutput) ||
            !targetsReady
          }
          onClick={() => {
            if (closeClaim.current?.owner === owner) return;
            closeClaim.current = null;
            const chosen = links.find((output) => output.id === target);
            if (target === "new") setReview("new");
            else if (chosen) setReview(chosen);
          }}
          variant="default"
        >
          检查所选订阅
        </ActionButton>
      </div>
    </TaskDialog>
  );
}
