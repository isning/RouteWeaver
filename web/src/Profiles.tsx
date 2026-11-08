import { DraftIntegerInput, exactDraftInteger } from "./draft-integer";
import { Metadata, MetadataItem } from "@/ui-patterns/metadata";
import { contentWidth } from "@/ui-patterns/content-width";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { NumericInput } from "@/ui-patterns/numeric-input";
import { TaskDialog, TaskSheet } from "@/ui-patterns/task-overlays";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { DataTable } from "./DataTable";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/ui-patterns/notice";
import { MultiChoice, ChoiceSelect } from "@/ui-patterns/choice-select";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Code,
  Trash2,
  Eye,
  MoreVertical,
  ChevronRight,
  Plus,
  Save as SaveOutlined,
} from "lucide-react";
import { revealFocusedPolicyModalControl } from "./drawer-control-visibility";
import {
  sourceHasFailure,
  sourceIssueText,
  sourceStatusUnknown,
} from "./source-failure";
import {
  parseDraftIR,
  toPersistableProfile,
  type DraftProfile,
  type DraftIR,
} from "./profile-draft";
import { invalidateOutputInputs } from "./output-comparison";
import { ruleResourceReference } from "./rule-file-model";
import {
  bindCreatedGroup,
  groupUses,
  type RoutingTarget,
} from "./routing-task";
import { useUnsavedChanges } from "./navigation";
import { useWorkspaceViewEntry } from "./useWorkspaceViewEntry";
import {
  ProfileDraftConflict,
  profileDraftChanged,
} from "./ProfileDraftConflict";
import {
  useId,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  actionLocationKey,
  actionRepair,
  missingActionOccurrences,
  missingActionReference,
  ProfileValidationNotice,
  type ActionLocation,
  type MissingActionReference,
} from "./profile-validation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { list, post, request, saveRecord } from "./api";
import type {
  ActionRef,
  ClientNode,
  Collection,
  Group,
  MatchExpression,
  Preview,
  Profile,
  Output,
  Overview,
  ProfileIR,
  PlatformEntry,
  RuleResource,
  Source,
} from "./types";
import {
  actionValue,
  groupErrors,
  moveItem,
  newID,
  parseAction,
  redact,
  stableNodeLabel,
} from "./model";
import { CodePreview, ErrorNotice, PageHeader, Section } from "./components";
import { SourceImportTask, canResumeSourceReview } from "./SourceImportTask";
import { useEffectiveProfileInputs } from "./profile-inputs";
import {
  SourceSelectionIssues,
  sourceSelectionIssue,
  sourceSelectionLabel,
} from "./SourceSelectionIssues";
import { FilterFields } from "./Pipeline";
import {
  AccessSubscription,
  ProfilePublicationDialog,
  SubscriptionsPage,
} from "./Subscriptions";
import { NativeOverrideEditor, NativeOverrideResult } from "./NativeOverride";
type ActionOption = {
  value: string;
  label: string;
  detail?: string;
  entryID?: string;
  referenceID?: string;
  "aria-label"?: string;
};
function filterActionOption(input: string, option?: ActionOption) {
  return `${option?.label || ""} ${option?.detail || ""} ${option?.entryID || ""} ${option?.referenceID || ""}`
    .toLowerCase()
    .includes(input.toLowerCase());
}
function renderActionOption({ data }: { data: ActionOption }) {
  return data.referenceID || data.detail ? (
    <>
      {data.label}
      {data.detail && (
        <div className="profile-choice-detail text-xs text-muted-foreground">
          {data.detail}
        </div>
      )}
      {data.referenceID && (
        <div>
          <code>{data.referenceID}</code>
        </div>
      )}
    </>
  ) : (
    data.label
  );
}
function ActionReferenceDetails({
  controlID,
  location,
  references,
  actions,
}: {
  controlID: string;
  location: string;
  references: ActionRef[];
  actions: ActionOption[];
}) {
  const options = actions.filter(
    (option) =>
      option.referenceID &&
      references.some((reference) => actionValue(reference) === option.value),
  );
  if (!options.length) return null;
  return (
    <details
      id={`${controlID}-references`}
      className="profile-linked-details profile-reference-details min-w-0 text-sm wrap-anywhere [&>summary]:cursor-pointer [&>p]:mt-2 [&>ul]:mt-2"
      aria-label={`${location}的引用详情`}
    >
      <summary className="min-h-11 py-3">引用详情</summary>
      <ul>
        {options.map((option) => (
          <li key={option.value}>
            <Metadata><MetadataItem>{option.label}</MetadataItem><code>{option.referenceID}</code></Metadata>
          </li>
        ))}
      </ul>
    </details>
  );
}
const targets = [
  { value: "mihomo", label: "Mihomo", version: "1.19.32" },
  { value: "sing-box", label: "sing-box", version: "1.14.3" },
];
// Legacy imports use the same workspace, not a separate publication lifecycle.
export function ProfilesPage() {
  return <SubscriptionsPage view="profiles" />;
}
export function ProfileEditor({
  initial,
  isNew,
  initialDirty = false,
  focusNameOnOpen = false,
  output,
  onClose,
}: {
  initial: Profile;
  isNew: boolean;
  initialDirty?: boolean;
  focusNameOnOpen?: boolean;
  output?: Output;
  onClose: () => void;
}) {
  const replaceView = useWorkspaceViewEntry();
  const [draft, setDraft] = useState<DraftProfile>(initial);
  const [boundOutput, setBoundOutput] = useState(output);
  const [publishedAccess, setPublishedAccess] = useState<{
    output: Output;
    replacement?: "publication";
  } | null>(null);
  const [persisted, setPersisted] = useState(!isNew);
  const [saved, setSaved] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // A suspended review owns its last ready payload and target selection.
  // Incomplete editor intent must never unmount that session or resume it.
  const [publicationProfile, setPublicationProfile] =
    useState<Profile>(initial);
  const [repairingReview, setRepairingReview] = useState(false);
  const [reviewRevision, setReviewRevision] = useState<number | null>(null);
  const [sourceTask, setSourceTask] = useState<{
    source?: Source;
    selected?: boolean;
  } | null>(null);
  const sourceOwner = useRef<typeof sourceTask>(null);
  const [sourceNotice, setSourceNotice] = useState<Source | null>(null);
  const [savedSourceNames, setSavedSourceNames] = useState(
    () => new Map<string, string>(),
  );
  const [sourceExpanded, setSourceExpanded] = useState(() => isNew);
  const sourceDisclosure = useRef<HTMLButtonElement>(null);
  const sourcePanelID = useId();
  const [sourceFocus, setSourceFocus] = useState<
    "sources" | "collection" | null
  >(null);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const sourceSelection = useRef<HTMLButtonElement>(null);
  const collectionSelection = useRef<HTMLButtonElement>(null);
  const sourceReturnTrigger = useRef<HTMLElement | null>(null);
  const sourceReturnFocus = useRef(false);
  useLayoutEffect(
    () => () => {
      sourceOwner.current = null;
      sourceReturnFocus.current = false;
    },
    [],
  );
  useLayoutEffect(() => {
    if (!sourceTask && sourceReturnFocus.current) {
      sourceReturnFocus.current = false;
      const origin = sourceReturnTrigger.current;
      const visible =
        origin?.isConnected && !origin.closest("[hidden], [inert]");
      (visible ? origin : sourceDisclosure.current)?.focus();
    }
  }, [sourceTask]);
  const focusSourceInput = (mode: "sources" | "collection") => {
    setSourceExpanded(true);
    setSourceFocus(mode);
  };
  useLayoutEffect(() => {
    if (!sourceExpanded || !sourceFocus) return;
    (sourceFocus === "sources"
      ? sourceSelection
      : collectionSelection
    ).current?.focus();
    setSourceFocus(null);
  }, [sourceExpanded, sourceFocus]);
  const openSourceTask = (
    trigger: HTMLElement,
    source?: Source,
    selected = false,
  ) => {
    if (sourceOwner.current) return;
    const task = { source, selected };
    sourceReturnTrigger.current = trigger;
    sourceOwner.current = task;
    setSourceTask(task);
  };
  const [inputMode, setInputMode] = useState<"sources" | "collection">(
    initial.collectionId ? "collection" : "sources",
  );
  const retainedSources = useRef(initial.sourceIds || []);
  const retainedCollection = useRef(initial.collectionId);
  const [tab, setTab] = useState("rules");
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const revealGroup = (id: string) => setExpandedGroups((ids) => ids.includes(id) ? ids : [...ids, id]);
  const [runtimeVisited, setRuntimeVisited] = useState(false);
  useEffect(() => {
    if (tab === "runtime") setRuntimeVisited(true);
  }, [tab]);
  const [groupTask, setGroupTask] = useState<{
    target: RoutingTarget;
    group: Group;
    ownerLabel: string;
  } | null>(null);
  const groupTaskOwner = useRef<typeof groupTask>(null);
  const [groupTaskError, setGroupTaskError] = useState<string | null>(null);
  const [useFocus, setUseFocus] = useState<ActionLocation | null>(null);
  const openGroupTask = (target: RoutingTarget, ownerLabel: string) => {
    const task = {
      target,
      ownerLabel,
      group: { id: newID("group"), name: "", kind: "manual", members: [] },
    };
    groupTaskOwner.current = task;
    setGroupTaskError(null);
    setNewGroupInterval(undefined);
    setGroupTask(task);
  };
  const detailTabs = useRef<HTMLDivElement>(null);
  const detailNavigationFrame = useRef<number | null>(null);
  useEffect(() => () => {
    if (detailNavigationFrame.current !== null) cancelAnimationFrame(detailNavigationFrame.current);
  }, []);
  const showDetails = (key: string) => {
    setPendingRepair(null);
    setTab(key);
    // The shortcut changes only the visible editor section, never the draft.
    if (detailNavigationFrame.current !== null) cancelAnimationFrame(detailNavigationFrame.current);
    detailNavigationFrame.current = requestAnimationFrame(() => {
      detailNavigationFrame.current = null;
      const target = detailTabs.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!target?.isConnected || target.dataset.section !== key || target.closest("[inert]")) return;
      detailTabs.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
      target.focus({ preventScroll: true });
    });
  };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [errorRevision, setErrorRevision] = useState<number | null>(null);
  const editorID = useId();
  const actionControlID = (location: ActionLocation) =>
    `${editorID}-${actionLocationKey(location)}`;
  useLayoutEffect(() => {
    if (!useFocus) return;
    const frame = requestAnimationFrame(() => {
      const control = document.getElementById(actionControlID(useFocus));
      control?.scrollIntoView?.({ block: "center" });
      control
        ?.querySelector<HTMLElement>('[role="combobox"]')
        ?.focus({ preventScroll: true });
      setUseFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [useFocus, tab]);
  const [pendingRepair, setPendingRepair] = useState<{
    issue: MissingActionReference;
    revision: number;
  } | null>(null);
  const [changed, setChanged] = useState(initialDirty);
  const [groupIntervalDrafts, setGroupIntervalDrafts] = useState<Record<string, string>>({});
  const [newGroupInterval, setNewGroupInterval] = useState<string | undefined>();
  const [groupIntervalFocus, setGroupIntervalFocus] = useState({ id: "", request: 0 });
  const invalidGroup = draft.ir.groups.find((group) => group.kind !== "manual" &&
    groupIntervalDrafts[group.id] !== undefined && groupIntervalDrafts[group.id] !== "" &&
    exactDraftInteger(groupIntervalDrafts[group.id]) === undefined);
  const [runtimeNumericLifetime, setRuntimeNumericLifetime] = useState(0);
  const [runtimeNumericErrors, setRuntimeNumericErrors] = useState<Record<string, boolean>>({});
  const runtimeNumericKeys = [
    "mixed-port",
    ...(readableRuntimeDNS(draft.ir.runtime.dns)
      ? draft.ir.runtime.dns!.servers.map((server) => `dns-${server.id}`)
      : []),
  ];
  const invalidRuntimeKey = runtimeNumericKeys.find((key) => runtimeNumericErrors[key]);
  const [runtimeNumericFocus, setRuntimeNumericFocus] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!runtimeNumericFocus) return;
    const frame = requestAnimationFrame(() => {
      const input = document.getElementById(`${editorID}-runtime-${runtimeNumericFocus}`);
      input?.scrollIntoView?.({ block: "center" });
      input?.focus({ preventScroll: true });
      setRuntimeNumericFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [runtimeNumericFocus, tab]);
  // Validation visibility only; action:null remains the sole incomplete intent.
  const [destinationErrors, setDestinationErrors] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const [codeBaseline, setCodeBaseline] = useState("");
  const codeDirty = codeOpen && code !== codeBaseline;
  useUnsavedChanges(changed || codeDirty || !!groupTask);
  const client = useQueryClient();
  const message = toast,
    confirm = useConfirm();
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => list<Source>("/me/sources"),
  });
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => list<Collection>("/me/collections"),
  });
  const outputs = useQuery({
    queryKey: ["outputs"],
    queryFn: () => list<Output>("/me/outputs"),
  });
  const linkedOutputs = (
    Array.isArray(outputs.data) ? outputs.data : []
  ).filter((item) => item.profileId === draft.id);
  const resources = useQuery({
    queryKey: ["resources"],
    queryFn: () => list<RuleResource>("/me/resources"),
  });
  const revision = useRef(0);
  const entries = useQuery({
    queryKey: ["platform-entries"],
    queryFn: () => list<PlatformEntry>("/me/platform-entries"),
    // Missing-reference conclusions require this editor's completed check,
    // even when the shared cache is still within its normal stale window.
    refetchOnMount: "always",
  });
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => request<Overview>("/me/overview"),
    refetchOnMount: "always",
  });
  const platformDetail = (entry: PlatformEntry) => {
    const routes =
      overview.isSuccess &&
      !overview.isFetching &&
      !overview.isPaused &&
      Array.isArray(overview.data?.routes)
        ? overview.data.routes.filter((route) => route.id === entry.routeId)
        : [];
    const route = routes.length === 1 ? routes[0] : undefined;
    const rate = route?.rateMicros;
    const multiplier =
      typeof rate === "number" &&
      Number.isSafeInteger(rate) &&
      rate >= 0 &&
      rate <= 1000000000
        ? `额度倍率 ${(rate / 1000000).toLocaleString("zh-CN", { maximumFractionDigits: 6 })}×`
        : "倍率暂不可用";
    return `${route?.name ? `${route.name} 的` : ""}${multiplier}${(entries.data || []).filter((other) => other.name === entry.name).length > 1 ? `，入口 ${entry.id}` : ""}`;
  };
  const includeChosenEntries = (references: ActionRef[]) => {
    const ids = references
      .filter(
        (reference) =>
          reference.kind === "endpoint" &&
          entries.data?.some((entry) => entry.id === reference.ref),
      )
      .map((reference) => reference.ref!);
    return ids.length
      ? {
          platformEntryIds: [
            ...new Set([...(draft.platformEntryIds || []), ...ids]),
          ],
        }
      : {};
  };
  const selectedEntries = (entries.data || []).filter((entry) =>
    draft.platformEntryIds?.includes(entry.id),
  );
  const update = (patch: Partial<DraftProfile>) => {
    revision.current++;
    if (patch.ir)
      setDestinationErrors(
        (previous) =>
          new Set(
            patch
              .ir!.rules.filter(
                (rule) => rule.action === null && previous.has(rule.id),
              )
              .map((rule) => rule.id),
          ),
      );
    // A validation result describes the checked draft, not its next edit.
    setError((current) => (missingActionReference(current) ? null : current));
    setErrorRevision(null);
    setDraft((d) => ({ ...d, ...patch }));
    setChanged(true);
    setSaved(false);
    setPreview(null);
  };
  const changeInputs = (
    patch: Pick<Partial<Profile>, "sourceIds" | "collectionId">,
  ) => {
    const next = {
      sourceIds: draft.sourceIds,
      collectionId: draft.collectionId,
      ...patch,
    };
    const clearsReferencedInput =
      (draft.collectionId || draft.sourceIds?.length) &&
      !next.collectionId &&
      !next.sourceIds?.length;
    setError(null);
    // Saved Profiles contain materialized input endpoints. Explicitly clearing
    // the last reference must not silently turn those into manual connections.
    // No-reference advanced JSON endpoints retain their existing manual meaning.
    update({
      ...patch,
      ...(clearsReferencedInput ? { ir: { ...draft.ir, endpoints: [] } } : {}),
    });
  };
  const clearCollection = () => {
    changeInputs({ collectionId: undefined, sourceIds: [] });
    focusSourceInput("collection");
  };
  const updateIR = (patch: Partial<DraftIR>) =>
    update({ ir: { ...draft.ir, ...patch } });
  const effectiveInputs = useEffectiveProfileInputs(
    draft,
    sources,
    collections,
  );
  const endpoints = effectiveInputs.endpoints;
  const completeDraft = toPersistableProfile(draft);
  const [destinationFocus, setDestinationFocus] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!destinationFocus) return;
    const frame = requestAnimationFrame(() => {
      if (destinationFocus.revision === revision.current && tab === "rules") {
        const control = document.getElementById(
          actionControlID({ kind: "rule", id: destinationFocus.id }),
        );
        control?.scrollIntoView?.({ block: "center" });
        control
          ?.querySelector<HTMLElement>('[role="combobox"]')
          ?.focus({ preventScroll: true });
      }
      setDestinationFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [destinationFocus, tab, draft]);
  const checkDestinations = () => {
    if (invalidGroup) {
      revealGroup(invalidGroup.id);
      setTab("groups");
      setGroupIntervalFocus((previous) => ({ id: invalidGroup.id, request: previous.request + 1 }));
      setError(new Error("请完成测试间隔输入，使用大于零的整数秒数。"));
      return false;
    }
    if (invalidRuntimeKey) {
      setTab("runtime");
      setRuntimeNumericFocus(invalidRuntimeKey);
      setError(new Error("请完成端口输入，范围为 1–65535 的整数。"));
      return false;
    }
    const result = toPersistableProfile(draft);
    if (result.ok) return true;
    setDestinationErrors(
      new Set(
        result.issues.flatMap((issue) => (issue.ruleId ? [issue.ruleId] : [])),
      ),
    );
    const issue = result.issues[0];
    if (issue.ruleId) {
      setPendingRepair(null);
      setTab("rules");
      setDestinationFocus({ id: issue.ruleId, revision: revision.current });
    } else setError(new Error(issue.message));
    return false;
  };
  const payload = (): Profile => {
    if (invalidGroup) throw new Error("请完成测试间隔输入，使用大于零的整数秒数。");
    if (invalidRuntimeKey) throw new Error("请完成端口输入，范围为 1–65535 的整数。");
    const result = toPersistableProfile(draft);
    if (!result.ok) throw new Error(result.issues[0].message);
    // Existing request normalization: the editable profile name owns ir.name.
    const { revisionToken: _revisionToken, ...profile } = result.profile;
    return {
      ...profile,
      ir: { ...profile.ir, name: draft.name },
    };
  };
  const save = useMutation({
    onMutate: () => invalidateOutputInputs(client, draft.id),
    onSettled: () => invalidateOutputInputs(client, draft.id),
    mutationFn: () =>
      saveRecord<Profile>(
        "me/profiles",
        { ...payload(), revisionToken: draft.revisionToken },
        !persisted,
      ),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["profiles"] });
      // A saved draft changes candidates, not frozen Output artifacts. Mark only
      // its cached comparisons stale; do not compile every linked Output here.
      client.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "outputs" &&
          query.queryKey[2] === "status" &&
          (linkedOutputs.some((output) => output.id === query.queryKey[1]) ||
            (query.state.data as Output | undefined)?.profileId === draft.id),
        refetchType: "none",
      });
      // Save responses are redacted summaries. Keep editable secrets and native
      // override text from this draft rather than replacing them with blanks.
      setDraft({
        ...payload(),
        updatedAt: result?.updatedAt,
        revision: result?.revision,
        revisionToken: result?.revisionToken,
      });
      setChanged(false);
      setPersisted(true);
      setSaved(true);
    },
    onError: (error) => {
      if (profileDraftChanged(error)) {
        setDraftConflict(true);
        setSaved(false);
        setChanged(true);
      }
      setError(error);
      setErrorRevision(revision.current);
    },
  });
  const inspect = useMutation({
    mutationFn: async (_version: number) =>
      post<Preview>("/me/profiles/preview", payload()),
    onSuccess: (result, version) => {
      if (version !== revision.current) return;
      setPreview(result);
      setError(null);
    },
    onError: (error, version) => {
      if (version !== revision.current) return;
      setError(error);
      setErrorRevision(version);
    },
  });
  const repairAction = (issue: MissingActionReference) => {
    const target = actionRepair(draft.ir, issue);
    if (!target) return;
    if (issue.location.kind === "group") revealGroup(issue.location.id);
    if (target.tab) setTab(target.tab);
    setPendingRepair({ issue, revision: revision.current });
  };
  useLayoutEffect(() => {
    if (!pendingRepair) return;
    // Tabs mount their lazy content after their own commit. Defer focus until
    // that commit, and cancel it if a newer edit/navigation replaces the target.
    const frame = requestAnimationFrame(() => {
      const target = actionRepair(draft.ir, pendingRepair.issue);
      if (
        pendingRepair.revision === revision.current &&
        target &&
        (!target.tab || target.tab === tab)
      ) {
        const control = document.getElementById(
          actionControlID(pendingRepair.issue.location),
        );
        control?.scrollIntoView?.({ block: "center" });
        control
          ?.querySelector<HTMLElement>('[role="combobox"]')
          ?.focus({ preventScroll: true });
      }
      setPendingRepair(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingRepair, tab, draft]);
  const closeCode = () => {
    const discard = () => {
      setCode(codeBaseline);
      setCodeOpen(false);
    };
    if (!codeDirty) return discard();
    confirm({
      title: "放弃尚未应用的 JSON 修改？",
      description: "仅放弃 JSON 文本修改，保留之前的配置草稿。",
      confirmLabel: "放弃 JSON 修改",
      cancelLabel: "继续编辑",
      destructive: true,
      onConfirm: discard,
    });
  };
  const close = () => {
    if (sourceOwner.current) {
      message.info("请先完成或关闭来源编辑，当前输入会保留。");
      return;
    }
    if (!changed && !codeDirty) return onClose();
    const origin = location.hash;
    let confirmed = false;
    return confirm({
      title: "放弃未保存的修改？",
      description: "当前编辑尚未保存。你可以继续编辑，或放弃这次修改。",
      confirmLabel: "放弃修改",
      cancelLabel: "继续编辑",
      destructive: true,
      onConfirm: () => {
        confirmed = replaceView(origin);
      },
      onClosed: () => {
        // Release the confirmation's focus scope before replacing the editor.
        // A departed view/session cannot complete this deferred dismissal.
        if (confirmed) replaceView(origin, onClose);
      },
    });
  };
  const actions: ActionOption[] = [
    { value: "direct", label: "直连" },
    { value: "reject", label: "拒绝连接" },
    ...draft.ir.groups.map((g) => ({
      value: `group:${g.id}`,
      label: `策略组 ${g.name}`,
    })),
    ...(entries.data || [])
      .filter((e) => !endpoints.some((n) => n.id === e.id))
      .map((e) => ({
        value: `endpoint:${e.id}`,
        label: `平台入口 ${e.name}`,
        detail: platformDetail(e),
        entryID: e.id,
      })),
    ...endpoints.map((n) => ({
      value: `endpoint:${n.id}`,
      label: stableNodeLabel(n, endpoints),
      ...(entries.data?.find((entry) => entry.id === n.id)
        ? {
            detail: platformDetail(
              entries.data.find((entry) => entry.id === n.id)!,
            ),
            entryID: n.id,
          }
        : {}),
    })),
  ];
  const ownInputsResolved =
    effectiveInputs.status === "success" || effectiveInputs.status === "empty";
  const inventoryResolved =
    ownInputsResolved &&
    entries.isSuccess &&
    entries.isFetchedAfterMount &&
    !entries.isFetching &&
    !entries.isPaused;
  const checkedIssue =
    errorRevision === revision.current ? missingActionReference(error) : null;
  const presentedIssue =
    checkedIssue && actionRepair(draft.ir, checkedIssue) ? checkedIssue : null;
  const missingOccurrences = inventoryResolved
    ? missingActionOccurrences(
        draft.ir,
        new Set(
          actions
            .filter(
              (action) =>
                !action.entryID ||
                draft.platformEntryIds?.includes(action.entryID) ||
                endpoints.some((endpoint) => endpoint.id === action.entryID),
            )
            .map((action) => action.value),
        ),
      ).filter(
        (issue) =>
          actionRepair(draft.ir, issue) &&
          !(
            presentedIssue &&
            actionLocationKey(issue.location) ===
              actionLocationKey(presentedIssue.location)
          ),
      )
    : [];
  const unresolvedLabel = inventoryResolved
    ? "不可用"
    : effectiveInputs.status === "error" || entries.isError
      ? "暂无法核对"
      : entries.isPaused || effectiveInputs.paused
        ? "等待核对"
        : "正在核对";
  // Preserve references while an input is loading, removed or filtered out.
  for (const reference of [
    ...draft.ir.groups.flatMap((group) => group.members),
    ...draft.ir.rules.map((rule) => rule.action),
    draft.ir.defaultAction,
  ]) {
    if (reference === null) continue;
    const value = actionValue(reference);
    if (!actions.some((action) => action.value === value)) {
      const retainedName =
        reference.kind === "endpoint"
          ? draft.ir.endpoints.find((node) => node.id === reference.ref)
              ?.name ||
            (sources.data || [])
              .flatMap((source) => source.snapshot?.endpoints || [])
              .find((node) => node.id === reference.ref)?.name ||
            entries.data?.find((entry) => entry.id === reference.ref)?.name
          : undefined;
      const missing = {
        value,
        label: retainedName
          ? `${unresolvedLabel}：${retainedName}`
          : `${reference.kind === "endpoint" ? "连接" : "策略组"}${unresolvedLabel}`,
        referenceID: reference.ref,
      };
      actions.push(missing);
    }
  }
  const retainedOptions = actions.filter((option) => option.referenceID);
  // Display ordinals distinguish unnamed choices; persisted values remain the stable references.
  const retainedLabels = retainedOptions.map((option) => option.label);
  retainedOptions.forEach((option, index) => {
    if (retainedLabels.filter((label) => label === option.label).length > 1) {
      const number = retainedLabels
        .slice(0, index + 1)
        .filter((label) => label === option.label).length;
      option.label = `${option.label} ${number}`;
    }
    option["aria-label"] = `${option.label}，引用 ${option.referenceID}`;
  });
  const missingControls = missingOccurrences.filter(
    (issue, index, all) =>
      all.findIndex(
        (other) =>
          actionLocationKey(other.location) ===
          actionLocationKey(issue.location),
      ) === index,
  );
  const errors = groupErrors(draft.ir.groups);
  const nativeOverride = draft.ir.nativeOverride;
  const nativeTargetMismatch =
    nativeOverride &&
    (nativeOverride.target.adapterId !== draft.target.adapterId ||
      nativeOverride.target.version !== draft.target.version);
  const sourceCatalogChecked =
    sources.isSuccess && !sources.isFetching && !sources.isPaused;
  const selectedCollection = collections.data?.find(
    (item) => item.id === draft.collectionId,
  );
  const selectedSourceIds =
    inputMode === "collection"
      ? selectedCollection?.sources.map((ref) => ref.sourceId) || []
      : draft.sourceIds || [];
  const inputsChecked =
    sourceCatalogChecked &&
    (inputMode !== "collection" ||
      (collections.isSuccess &&
        !collections.isFetching &&
        !collections.isPaused));
  const unavailableSources = inputsChecked
    ? selectedSourceIds.flatMap((id) => {
        const source = sources.data?.find((item) => item.id === id);
        return source && sourceSelectionIssue(source) ? [source] : [];
      })
    : [];
  const sourceOptions = (sources.data || []).map((source) => ({
    value: source.id,
    label: sourceSelectionLabel(source, sourceCatalogChecked),
  }));
  for (const id of draft.sourceIds || []) {
    if (!sourceOptions.some((option) => option.value === id))
      sourceOptions.push({
        value: id,
        label: savedSourceNames.get(id) || `${id}（来源暂不可用，已保留）`,
      });
  }
  const collectionOptions = (collections.data || []).map((collection) => ({
    value: collection.id,
    label: collection.name,
  }));
  if (
    draft.collectionId &&
    !collectionOptions.some((option) => option.value === draft.collectionId)
  )
    collectionOptions.push({
      value: draft.collectionId,
      label: `${draft.collectionId}（集合暂不可用，已保留）`,
    });
  const entryOptions = (entries.data || []).map((entry) => ({
    value: entry.id,
    label: entry.name,
    detail: platformDetail(entry),
  }));
  for (const id of draft.platformEntryIds || []) {
    if (!entryOptions.some((option) => option.value === id))
      entryOptions.push({
        value: id,
        label: `${id}（入口暂不可用，已保留）`,
        detail: "",
      });
  }
  const missingSourceCount = sourceCatalogChecked
    ? selectedSourceIds.filter(
        (id) => !sources.data?.some((source) => source.id === id),
      ).length
    : 0;
  const sourceSummary =
    inputMode === "collection"
      ? selectedCollection
        ? `节点集合：${selectedCollection.name}`
        : draft.collectionId
          ? collections.isPaused
            ? "等待核对所选集合，原选择已保留"
            : collections.isError
              ? "暂无法核对所选集合，原选择已保留"
              : collections.isSuccess && !collections.isFetching
                ? "所选集合暂不可用，原选择已保留"
                : "正在核对所选集合…"
          : "未选择节点集合"
      : selectedSourceIds.length
        ? missingSourceCount
          ? `${selectedSourceIds.length} 个来源，${missingSourceCount} 个暂不可用，原选择已保留`
          : selectedSourceIds.length === 1
            ? sources.data?.find((source) => source.id === selectedSourceIds[0])
                ?.name ||
              savedSourceNames.get(selectedSourceIds[0]) ||
              "1 个已选来源"
            : `${selectedSourceIds.length} 个来源`
        : draft.ir.endpoints.length
          ? "配置内置连接"
          : draft.platformEntryIds?.length
            ? "使用平台入口"
            : "尚未添加代理连接";
  const missingEntryCount =
    entries.isSuccess && !entries.isFetching && !entries.isPaused
      ? (draft.platformEntryIds || []).filter(
          (id) => !entries.data?.some((entry) => entry.id === id),
        ).length
      : 0;
  const groupTaskActions = actions.filter((action) => !action.referenceID);
  for (const member of groupTask?.group.members || []) {
    if (
      !groupTaskActions.some((action) => action.value === actionValue(member))
    )
      groupTaskActions.push({
        value: actionValue(member),
        label: "候选连接暂不可用",
        referenceID: member.ref,
      });
  }
  const editorTabs = [
    {
      key: "rules",
      label: "分流规则",
      children: (
        <>
          <Section>
            <div className="profile-rules-toolbar mb-4 flex flex-wrap items-center justify-between gap-3">
              {!!draft.ir.rules.length && <p>按顺序匹配，首个命中生效。</p>}
              <ActionButton
                leadingIcon={<Plus aria-hidden="true" />}
                onClick={() =>
                  updateIR({
                    rules: [
                      ...draft.ir.rules,
                      {
                        id: newID("rule"),
                        match: { op: "domain-suffix", value: "" },
                        action: null,
                      },
                    ],
                  })
                }
                variant="outline"
              >
                添加规则
              </ActionButton>
              <ActionButton
                onClick={() =>
                  updateIR({
                    rules: [
                      ...draft.ir.rules,
                      {
                        id: newID("rule"),
                        match: { op: "resource", value: "" },
                        action: null,
                      },
                    ],
                  })
                }
                variant="outline"
              >
                按规则文件分流
              </ActionButton>
            </div>
            {draft.ir.rules.map((rule, index) => (
              <div
                className="rule-card mb-4 space-y-4 rounded-lg border p-4"
                key={rule.id}
              >
                <div className="step-top flex flex-wrap items-center justify-between gap-3">
                  <span className="step-index flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {index + 1}
                  </span>
                  <strong>匹配条件</strong>
                  <div className="spacer flex-1" />
                  <ActionButton
                    aria-label={`上移规则 ${index + 1}`}
                    leadingIcon={<ArrowUp aria-hidden="true" />}
                    disabled={index === 0}
                    onClick={() =>
                      updateIR({
                        rules: moveItem(draft.ir.rules, index, index - 1),
                      })
                    }
                    variant="ghost"
                    size="sm"
                  />
                  <ActionButton
                    aria-label={`下移规则 ${index + 1}`}
                    leadingIcon={<ArrowDown aria-hidden="true" />}
                    disabled={index === draft.ir.rules.length - 1}
                    onClick={() =>
                      updateIR({
                        rules: moveItem(draft.ir.rules, index, index + 1),
                      })
                    }
                    variant="ghost"
                    size="sm"
                  />
                  <ActionButton
                    aria-label={`删除规则 ${index + 1}`}
                    leadingIcon={<Trash2 aria-hidden="true" />}
                    onClick={() =>
                      updateIR({
                        rules: draft.ir.rules.filter((_, i) => i !== index),
                      })
                    }
                    variant="ghost"
                    size="sm"
                  />
                </div>
                <MatchEditor
                  value={rule.match}
                  resources={resources.data || []}
                  onChange={(match, selectedResource) =>
                    updateIR({
                      rules: draft.ir.rules.map((r, i) =>
                        i === index ? { ...r, match } : r,
                      ),
                      ...(selectedResource &&
                      !draft.ir.resources.some(
                        (resource) => resource.id === selectedResource.id,
                      )
                        ? {
                            resources: [
                              ...draft.ir.resources,
                              ruleResourceReference(selectedResource),
                            ],
                          }
                        : {}),
                    })
                  }
                />
                <label
                  className="rule-action grid min-w-0 gap-2 text-sm font-medium"
                  id={actionControlID({
                    kind: "rule",
                    id: rule.id,
                  })}
                >
                  流量去向
                  <ChoiceSelect
                    aria-label={`规则 ${index + 1} 的流量去向`}
                    aria-invalid={
                      rule.action === null && destinationErrors.has(rule.id)
                    }
                    placeholder="选择去向"
                    aria-describedby={
                      rule.action === null && destinationErrors.has(rule.id)
                        ? `${actionControlID({ kind: "rule", id: rule.id })}-required`
                        : rule.action !== null &&
                            retainedOptions.some(
                              (option) =>
                                option.value === actionValue(rule.action!),
                            )
                          ? `${actionControlID({ kind: "rule", id: rule.id })}-references`
                          : undefined
                    }
                    value={
                      rule.action === null
                        ? undefined
                        : actionValue(rule.action)
                    }
                    searchable
                    options={actions.map((option) => ({
                      ...option,
                      description: option.referenceID || option.detail,
                    }))}
                    onValueChange={(value) => {
                      if (value === undefined) return;
                      const action = parseAction(value);
                      update({
                        ...includeChosenEntries([action]),
                        ir: {
                          ...draft.ir,
                          rules: draft.ir.rules.map((r, i) =>
                            i === index ? { ...r, action } : r,
                          ),
                        },
                      });
                    }}
                  />
                </label>
                {rule.action === null && destinationErrors.has(rule.id) && (
                  <span
                    className="profile-field-error text-sm text-destructive"
                    id={`${actionControlID({ kind: "rule", id: rule.id })}-required`}
                  >
                    请选择此规则的流量去向
                  </span>
                )}
                <ActionReferenceDetails
                  controlID={actionControlID({
                    kind: "rule",
                    id: rule.id,
                  })}
                  location={`规则 ${index + 1}`}
                  references={rule.action === null ? [] : [rule.action]}
                  actions={actions}
                />
                <ActionButton
                  className="profile-candidate-action flex flex-wrap items-center gap-2"
                  aria-label={`规则 ${index + 1}：使用多个候选连接…`}
                  onClick={() =>
                    openGroupTask(
                      {
                        kind: "rule",
                        id: rule.id,
                        expected: rule.action,
                      },
                      `规则 ${index + 1}${rule.match.value ? ` 匹配 ${rule.match.op === "resource" ? draft.ir.resources.find((resource) => resource.id === rule.match.value)?.name || resources.data?.find((resource) => resource.id === rule.match.value)?.name || "规则文件暂不可用" : rule.match.value}` : ""}`,
                    )
                  }
                  variant="outline"
                >
                  使用多个候选连接…
                </ActionButton>
              </div>
            ))}
            {!draft.ir.rules.length && (
              <div className="inline-empty rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                尚未添加规则。完整配置使用上方选择的默认流量行为。
              </div>
            )}
            <details className="profile-resource-references space-y-3 border-t pt-3 text-sm [&>summary]:min-h-11 [&>summary]:cursor-pointer [&>summary]:rounded-sm [&>summary]:py-3 [&>summary]:outline-none [&>summary]:focus-visible:ring-2 [&>summary]:focus-visible:ring-ring">
              <summary>已引用的规则文件（{draft.ir.resources.length}）</summary>
              <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                引用的规则文件
                <MultiChoice
                  value={draft.ir.resources.map((r) => r.id)}
                  options={(resources.data || []).map((r) => ({
                    value: r.id,
                    label: r.name || r.id,
                  }))}
                  onValueChange={(ids) =>
                    updateIR({
                      resources: ids.map((id) =>
                        ruleResourceReference(
                          draft.ir.resources.find((r) => r.id === id) ||
                            resources.data!.find((r) => r.id === id)!,
                        ),
                      ),
                    })
                  }
                />
              </label>
            </details>
            {draft.ir.resources
              .filter(
                (r) =>
                  r.acceptedVersion &&
                  r.updatePolicy === "pinned" &&
                  resources.data?.some(
                    (current) =>
                      current.id === r.id &&
                      current.acceptedVersion !== r.acceptedVersion,
                  ),
              )
              .map((r) => (
                <div
                  className="inline-empty rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
                  key={r.id}
                >
                  {r.name || r.id}：当前配置固定较早的文件版本。
                  <ActionButton
                    onClick={() =>
                      updateIR({
                        resources: draft.ir.resources.map((ref) =>
                          ref.id === r.id
                            ? {
                                ...ruleResourceReference(
                                  resources.data!.find(
                                    (current) => current.id === r.id,
                                  )!,
                                ),
                                updatePolicy: "pinned",
                              }
                            : ref,
                        ),
                      })
                    }
                    variant="outline"
                  >
                    固定到最新接纳版本
                  </ActionButton>
                </div>
              ))}
          </Section>
        </>
      ),
    },
    {
      key: "groups",
      label: "策略组",
      children: (
        <Section>
          <div
            className={
              draft.ir.groups.length
                ? "profile-group-toolbar flex flex-wrap items-center gap-2"
                : "profile-group-empty space-y-3 rounded-lg border border-dashed p-4"
            }
          >
            {!draft.ir.groups.length && <p>需要自动优选、故障切换或多个候选连接时，再添加策略组。</p>}
            <ActionButton
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => {
                const id = newID("group");
                revealGroup(id);
                updateIR({
                  groups: [
                    ...draft.ir.groups,
                    {
                      id,
                      name: "新策略组",
                      kind: "manual",
                      members: [],
                    },
                  ],
                });
              }}
              variant="outline"
            >
              添加策略组
            </ActionButton>
          </div>
          {draft.ir.groups.map((group, index) => (
            <details
              key={group.id}
              className="rounded-lg border p-4"
              open={expandedGroups.includes(group.id)}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpandedGroups((ids) => open
                  ? ids.includes(group.id) ? ids : [...ids, group.id]
                  : ids.filter((id) => id !== group.id));
              }}
            >
              <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="font-medium">{group.name || "未命名策略组"}</span>
                <span className="mt-2 block text-sm text-muted-foreground">
                  {({ manual: "手动选择", "url-test": "延迟优选", fallback: "故障切换", "load-balance": "负载均衡" } as Record<string, string>)[group.kind] || group.kind}
                  {`，${group.members.length} 个固定候选`}{group.dynamic != null ? "，自动加入连接已开启" : ""}
                </span>
                <span className="mt-1 block break-words text-sm">
                  {group.members.slice(0, 3).map((member) => actions.find((action) => action.value === actionValue(member))?.label || "候选连接暂不可用").join("、") || "尚未选择固定候选"}
                  {group.members.length > 3 ? ` 等 ${group.members.length} 个` : ""}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {groupUses(draft.ir, group.id).map((use) => use.label).join("；") || "尚未用于流量分配"}
                </span>
              </summary>
              <div className="mt-4">
            <GroupEditor
              value={group}
              onIntervalFocused={() => setGroupIntervalFocus((previous) => ({ ...previous, id: "" }))}
              intervalRaw={groupIntervalDrafts[group.id]}
              onIntervalReset={() => setGroupIntervalDrafts((previous) => {
                const next = { ...previous };
                delete next[group.id];
                return next;
              })}
              intervalFocus={groupIntervalFocus.id === group.id ? groupIntervalFocus.request : 0}
              onIntervalInput={(raw) => {
                setGroupIntervalDrafts((previous) => ({ ...previous, [group.id]: raw }));
                update({});
              }}
              actionControlID={actionControlID({
                kind: "group",
                id: group.id,
              })}
              actions={actions}
              sources={sources.data || []}
              usage={
                <div
                  className="profile-group-uses space-y-2 text-sm"
                  aria-label="策略组用途"
                >
                  {groupUses(draft.ir, group.id).length ? (
                    groupUses(draft.ir, group.id).map((use) => (
                      <ActionButton
                        key={actionLocationKey(use.location)}
                        onClick={() => {
                          setPendingRepair(null);
                          if (use.location.kind !== "default")
                            setTab(
                              use.location.kind === "rule" ? "rules" : "groups",
                            );
                          if (use.location.kind === "group") revealGroup(use.location.id);
                          setUseFocus(use.location);
                        }}
                        variant="link"
                      >
                        {use.label}
                      </ActionButton>
                    ))
                  ) : (
                    <span>尚未被默认去向、规则或其他组引用</span>
                  )}
                </div>
              }
              onChange={(value, chosenMembers) =>
                update({
                  ...(chosenMembers ? includeChosenEntries(chosenMembers) : {}),
                  ir: {
                    ...draft.ir,
                    groups: draft.ir.groups.map((g, i) =>
                      i === index ? value : g,
                    ),
                  },
                })
              }
              onRemove={() => {
                const uses = groupUses(draft.ir, group.id);
                const remove = () =>
                  updateIR({
                    groups: draft.ir.groups.filter(
                      (item) => item.id !== group.id,
                    ),
                  });
                if (!uses.length) return remove();
                const openedAt = revision.current;
                confirm({
                  title: `移除策略组「${group.name}」？`,
                  description: (
                    <>
                      <ul>
                        {uses.map((use) => (
                          <li key={actionLocationKey(use.location)}>
                            {use.label}
                          </li>
                        ))}
                      </ul>
                      <p>
                        这些引用将变为不可用，需要明确选择新的流量去向后才能发布。
                      </p>
                    </>
                  ),
                  confirmLabel: "移除策略组",
                  cancelLabel: "保留策略组",
                  destructive: true,
                  onConfirm: () => {
                    if (openedAt !== revision.current) {
                      message.warning(
                        "配置已改变，请重新查看策略组用途后移除。",
                      );
                      return;
                    }
                    remove();
                  },
                });
              }}
            />
              </div>
            </details>
          ))}
        </Section>
      ),
    },
    {
      key: "inspection",
      label: "检查与预览",
      children: (
        <Section
          title="检查配置草稿"
          description="技术预览用于检查当前草稿；保存与发布需单独操作。正式发布会按所选客户端订阅重新检查。"
        >
          <label className="standalone-label profile-diagnostic-target grid min-w-0 gap-2 text-sm font-medium">
            预览客户端
            <ChoiceSelect
              aria-label="预览客户端"
              value={draft.target.adapterId}
              options={targets}
              onValueChange={(adapterId) => {
                if (adapterId === undefined) return;
                return update({
                  target: {
                    adapterId,
                    version: targets.find(
                      (target) => target.value === adapterId,
                    )!.version,
                  },
                });
              }}
            />
            <small>
              用于此处预览、原生覆盖绑定和新订阅的默认客户端。已有订阅保留各自的客户端与输出方式。
            </small>
          </label>
          <ActionButton
            leadingIcon={<Eye aria-hidden="true" />}
            disabled={codeDirty || unavailableSources.length > 0}
            onClick={() => {
              setError(null);
              if (!checkDestinations()) return;
              inspect.mutate(revision.current);
            }}
            variant="outline"
            pending={!!inspect.isPending}
          >
            预览配置
          </ActionButton>
        </Section>
      ),
    },
    {
      key: "runtime",
      label: "运行设置",
      children: (
        <Section title="客户端运行设置">
          <RuntimeEditor
            value={draft.ir}
            onChange={updateIR}
            numericResetKey={runtimeNumericLifetime}
            numericIDPrefix={`${editorID}-runtime-`}
            numericErrors={runtimeNumericErrors}
            onNumericEdit={(key, raw) => {
              setRuntimeNumericErrors((previous) => ({ ...previous, [key]: exactRuntimePort(raw) === undefined }));
              update({});
            }}
            onRepairDNS={() => {
              const text = JSON.stringify(draft.ir, null, 2);
              setCode(text);
              setCodeBaseline(text);
              setCodeOpen(true);
            }}
          />
          <Accordion type="multiple">
            {[
              {
                key: "native",
                label: "高级：目标原生覆盖",
                children: (
                  <NativeOverrideEditor
                    value={draft.ir.nativeOverride}
                    target={draft.target}
                    mode={draft.mode}
                    onChange={(nativeOverride) => updateIR({ nativeOverride })}
                    useFullMode={() => update({ mode: "full" })}
                  />
                ),
              },
              {
                key: "advanced",
                label: "高级：配置意图与目标版本",
                children: (
                  <>
                    <div className="key-value grid gap-2 text-sm">
                      <span>目标版本</span>
                      <strong>
                        {draft.target.adapterId} {draft.target.version}
                      </strong>
                    </div>
                    <p className="muted text-sm text-muted-foreground">
                      查看并编辑完整配置意图。
                    </p>
                    <ActionButton
                      leadingIcon={<Code aria-hidden="true" />}
                      onClick={() => {
                        const text = JSON.stringify(draft.ir, null, 2);
                        setCode(text);
                        setCodeBaseline(text);
                        setCodeOpen(true);
                      }}
                      variant="outline"
                    >
                      编辑配置意图 JSON
                    </ActionButton>
                  </>
                ),
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
                <AccordionContent
                  forceMount
                  className="data-[state=closed]:hidden"
                >
                  {section.children}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Section>
      ),
    },
  ];
  return (
    <div
      className={`profile-intent-editor mx-auto w-full min-w-0 space-y-6 ${contentWidth.workspace} [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:min-h-11 [&_input]:scroll-mt-32 [&_textarea]:scroll-mt-32 [&_[role=combobox]]:scroll-mt-32`}
      inert={!!sourceTask}
    >
      <div className="profile-editor-heading flex flex-wrap items-end justify-between gap-4">
        <PageHeader
          title={persisted ? draft.name : "新建分流配置"}
          back={close}
        />
      </div>
      <div
        className="profile-publish-action sticky top-0 z-20 border-b bg-background py-3"
        role="group"
        aria-label="保存与检查配置"
      >
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span
            className="profile-save-state mr-auto text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {saved && !codeDirty
              ? "草稿已保存"
              : codeDirty
                ? "JSON 修改尚未应用"
                : !persisted || changed
                  ? "草稿尚未保存"
                  : "已保存草稿"}
          </span>
          <div className={"flex flex-wrap items-center gap-2"}>
            <ActionButton
              leadingIcon={<SaveOutlined aria-hidden="true" />}
              aria-label="保存草稿"
              aria-busy={save.isPending}
              onClick={() => {
                if (sourceOwner.current || draftConflict) return;
                setError(null);
                if (!checkDestinations()) return;
                save.mutate();
              }}
              disabled={
                !draft.name.trim() ||
                codeDirty ||
                save.isPending ||
                draftConflict ||
                !!sourceTask ||
                unavailableSources.length > 0
              }
              variant="outline"
              pending={!!save.isPending}
            >
              保存草稿
            </ActionButton>
            <ActionButton
              aria-label={!persisted || changed ? "保存并检查" : "检查发布"}
              aria-busy={save.isPending}
              disabled={
                !draft.name.trim() ||
                codeDirty ||
                save.isPending ||
                draftConflict ||
                !!sourceTask ||
                unavailableSources.length > 0
              }
              onClick={async () => {
                if (sourceOwner.current || draftConflict) return;
                setError(null);
                if (!checkDestinations()) return;
                const handoffRevision = revision.current;
                try {
                  if (!persisted || changed) await save.mutateAsync();
                  if (revision.current !== handoffRevision) return;
                  setPublicationProfile(payload());
                  setRepairingReview(false);
                  setReviewRevision(handoffRevision);
                  setReviewOpen(true);
                } catch {
                  /* The mutation keeps the editable draft and reports the failure. */
                }
              }}
              variant="default"
              pending={!!save.isPending}
            >
              {!persisted || changed ? "保存并检查" : "检查发布"}
            </ActionButton>
          </div>
        </div>
      </div>
      <div
        className="profile-state-strip flex flex-wrap items-end gap-4"
        inert={save.isPending}
      >
        <label className="profile-name-field grid min-w-0 flex-1 gap-2 text-sm font-medium">
          配置名称
          <Input
            value={draft.name}
            placeholder="例如：日常使用"
            aria-label="配置名称"
            aria-describedby={!draft.name.trim() ? `${editorID}-name-guidance` : undefined}
            autoFocus={focusNameOnOpen}
            onChange={(event) => update({ name: event.target.value })}
          />
          {!draft.name.trim() && (
            <span id={`${editorID}-name-guidance`} className="text-sm font-normal text-muted-foreground">
              填写配置名称后可保存或检查。
            </span>
          )}
        </label>
        <div className="profile-state grid gap-2 text-xs text-muted-foreground">
          <details className="profile-linked-details text-sm [&>summary]:cursor-pointer [&>p]:mt-2 [&>ul]:mt-2">
            <summary>
              {outputs.isPending
                ? outputs.isPaused
                  ? "等待核对关联订阅…"
                  : "正在核对此配置的订阅…"
                : outputs.isError
                  ? "关联订阅暂无法核对"
                  : `关联订阅（${linkedOutputs.length}）`}
            </summary>
            {!outputs.isPending &&
              !outputs.isError &&
              (linkedOutputs.length ? (
                <ul>
                  {linkedOutputs.map((item) => (
                    <li key={item.id}>
                      <span className="block font-medium">{item.name}</span>{" "}
                      <Metadata className="text-muted-foreground">
                        <MetadataItem>{item.target.adapterId}</MetadataItem>
                        <MetadataItem>{item.mode === "nodes-only" ? "纯节点" : "完整配置"}</MetadataItem>
                        {item.status === "revoked" && <MetadataItem>已撤销</MetadataItem>}
                      </Metadata>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>暂无关联订阅</p>
              ))}
            {boundOutput && <p>从「{boundOutput.name}」打开</p>}
          </details>
        </div>
      </div>
      {draftConflict && (
        <ProfileDraftConflict profileID={draft.id} onClose={onClose} />
      )}
      <ProfileValidationNotice
        error={profileDraftChanged(error) ? null : error}
        ir={draft.ir}
        onRepair={errorRevision === revision.current ? repairAction : undefined}
      />
      {outputs.isError && (
        <div className="profile-visible-error my-3 text-sm text-destructive">
          <ErrorNotice error={outputs.error} />
          <ActionButton onClick={() => outputs.refetch()} variant="outline">
            重新核对订阅
          </ActionButton>
        </div>
      )}
      <div className="profile-editor-layout space-y-6" inert={save.isPending}>
        <div className="profile-editor space-y-6">
          <section
            className="surface profile-intent-task @container/profile-task scroll-mt-32 rounded-lg border bg-card p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="连接与流量"
            id={`${editorID}-connections`}
            tabIndex={-1}
          >
            <div className="profile-intent-grid grid gap-6 @min-[44rem]/profile-task:grid-cols-2 [&>div]:min-w-0 [&_h2]:mb-4 [&_h2]:font-semibold">
              <div className="profile-traffic-task space-y-4">
                <h2>默认流量去向</h2>
                <label
                  className="standalone-label default-route grid min-w-0 gap-2 text-sm font-medium"
                  id={actionControlID({ kind: "default" })}
                >
                  {draft.ir.rules.length ? "未匹配规则的流量" : "所有流量"}
                  <ChoiceSelect
                    aria-label="默认流量行为"
                    aria-describedby={
                      actions.some(
                        (option) =>
                          option.referenceID &&
                          option.value === actionValue(draft.ir.defaultAction),
                      )
                        ? `${actionControlID({ kind: "default" })}-references`
                        : undefined
                    }
                    value={actionValue(draft.ir.defaultAction)}
                    searchable
                    options={actions.map((option) => ({
                      ...option,
                      description: option.referenceID || option.detail,
                    }))}
                    onValueChange={(value) => {
                      if (value === undefined) return;
                      const action = parseAction(value);
                      update({
                        ir: { ...draft.ir, defaultAction: action },
                        ...includeChosenEntries([action]),
                      });
                    }}
                  />
                </label>
                <ActionReferenceDetails
                  controlID={actionControlID({ kind: "default" })}
                  location="默认去向"
                  references={[draft.ir.defaultAction]}
                  actions={actions}
                />
                <ActionButton
                  className="profile-candidate-action flex flex-wrap items-center gap-2"
                  aria-label="默认流量：使用多个候选连接…"
                  onClick={() =>
                    openGroupTask(
                      { kind: "default", expected: draft.ir.defaultAction },
                      draft.ir.rules.length ? "未匹配规则的流量" : "所有流量",
                    )
                  }
                  variant="outline"
                >
                  使用多个候选连接…
                </ActionButton>
                {/* Keep the announcer mounted; an empty consequence has no visual card. */}
                <div
                  className="profile-traffic-outcome space-y-2 rounded-lg bg-muted p-4 text-sm empty:sr-only"
                  aria-live="polite"
                >
                  {!nativeOverride &&
                    !draft.ir.rules.length &&
                    draft.ir.defaultAction.kind === "direct" &&
                    (endpoints.length > 0 || selectedEntries.length > 0) && (
                      <p>已导入的连接尚未用于分流。</p>
                    )}
                  {nativeOverride && (
                    <p>
                      上方保留结构化默认行为；原生规则或设置可能改变最终行为，请按具体客户端检查。
                    </p>
                  )}
                  {(draft.mode === "nodes-only" ||
                    boundOutput?.mode === "nodes-only") && (
                    <p>
                      纯节点订阅仅交付连接；上方分流行为保存在共享配置中，供完整配置使用。
                    </p>
                  )}
                </div>
              </div>
              <div className="profile-input-task space-y-4 @min-[44rem]/profile-task:border-l @min-[44rem]/profile-task:pl-6">
                <div className="profile-source-summary flex flex-wrap items-center justify-between gap-3 [&>h2]:mb-0 [&>span]:w-full">
                  <h2>代理连接</h2>
                  <ActionButton
                    ref={sourceDisclosure}
                    aria-label={sourceExpanded ? "收起来源设置" : "编辑来源"}
                    aria-expanded={sourceExpanded}
                    aria-controls={sourcePanelID}
                    onKeyDown={(event) => {
                      if (
                        event.repeat &&
                        (event.key === "Enter" || event.key === " ")
                      )
                        event.preventDefault();
                    }}
                    onClick={() => setSourceExpanded((expanded) => !expanded)}
                    variant="outline"
                  >
                    {sourceExpanded ? "收起来源设置" : "编辑来源"}
                  </ActionButton>
                  <span className="profile-source-identity flex flex-wrap items-center gap-2">
                    {sourceSummary}
                  </span>
                </div>
                <div
                  className="profile-input-result grid gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"
                  aria-live="polite"
                >
                  {effectiveInputs.status === "pending" ? (
                    <span>
                      {effectiveInputs.paused
                        ? "等待核对有效连接…"
                        : "正在计算有效连接…"}
                    </span>
                  ) : effectiveInputs.status === "error" ? (
                    <strong>有效连接暂不可用</strong>
                  ) : (
                    <strong>{endpoints.length === 0 &&
                      !selectedSourceIds.length && !draft.collectionId &&
                      !draft.platformEntryIds?.length && !draft.ir.endpoints.length &&
                      draft.ir.defaultAction.kind === "direct" &&
                      !draft.ir.rules.length && !draft.ir.groups.length
                      ? "直连与拒绝不需要代理连接"
                      : `${endpoints.length} 个有效连接`}</strong>
                  )}
                  {entries.isPaused ? (
                    <span>等待核对平台入口…</span>
                  ) : entries.isLoading ? (
                    <span>正在核对平台入口…</span>
                  ) : (
                    selectedEntries.length > 0 && (
                      <span>
                        另有 {selectedEntries.length}{" "}
                        个平台入口，凭据在发布时解析。
                      </span>
                    )
                  )}
                  {missingEntryCount > 0 && (
                    <span>
                      {missingEntryCount} 个平台入口暂不可用，原选择已保留。
                    </span>
                  )}
                  {effectiveInputs.status === "empty" &&
                    effectiveInputs.mode !== "manual" && (
                      <span>自己的连接处理后为空，已有路由引用仍保留。</span>
                    )}
                </div>
                <div
                  id={sourcePanelID}
                  className="profile-source-settings space-y-4"
                  hidden={!sourceExpanded}
                >
                  {effectiveInputs.mode === "manual" &&
                    endpoints.length > 0 && (
                      <p className="muted text-sm text-muted-foreground">
                        内置连接可在配置意图 JSON 中编辑。
                      </p>
                    )}
                  <RadioGroup
                    aria-label="连接来源方式"
                    value={inputMode}
                    onValueChange={(value) =>
                      ((event) => {
                        const mode = event.target.value as
                          "sources" | "collection";
                        if (inputMode === "sources")
                          retainedSources.current = draft.sourceIds || [];
                        else retainedCollection.current = draft.collectionId;
                        setInputMode(mode);
                        changeInputs(
                          mode === "sources"
                            ? {
                                sourceIds: retainedSources.current,
                                collectionId: undefined,
                              }
                            : {
                                sourceIds: [],
                                collectionId: retainedCollection.current,
                              },
                        );
                      })({ target: { value } })
                    }
                  >
                    {[
                      { value: "sources", label: "直接选择来源" },
                      { value: "collection", label: "使用节点集合" },
                    ].map((option) => (
                      <Label
                        key={option.value}
                        className="flex cursor-pointer items-center gap-2 rounded-md border p-3 has-[[data-state=checked]]:border-primary"
                      >
                        <RadioGroupItem
                          value={String(option.value)}
                          disabled={"disabled" in option && !!option.disabled}
                        />
                        {option.label}
                      </Label>
                    ))}
                  </RadioGroup>
                  {inputMode === "sources" ? (
                    <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                      订阅来源
                      <MultiChoice
                        ref={sourceSelection}
                        aria-label="使用的订阅来源"
                        value={draft.sourceIds || []}
                        placeholder="选择已有来源，或添加新来源"
                        options={sourceOptions}
                        searchable
                        onValueChange={(sourceIds) =>
                          changeInputs({ sourceIds })
                        }
                      />
                    </label>
                  ) : (
                    <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                      复用节点集合
                      <ChoiceSelect
                        ref={collectionSelection}
                        clearable
                        aria-label="复用节点集合"
                        value={draft.collectionId}
                        placeholder="选择已整理的集合"
                        options={collectionOptions}
                        searchable
                        onValueChange={(collectionId) =>
                          collectionId
                            ? changeInputs({ collectionId })
                            : clearCollection()
                        }
                      />
                    </label>
                  )}

                  <ActionButton
                    ref={sourceTrigger}
                    onKeyDown={(event) => {
                      if (
                        event.repeat &&
                        (event.key === "Enter" || event.key === " ")
                      )
                        event.preventDefault();
                    }}
                    onClick={(event) => {
                      setSourceNotice(null);
                      openSourceTask(event.currentTarget);
                    }}
                    leadingIcon={<Plus aria-hidden="true" />}
                    variant="outline"
                  >
                    添加来源
                  </ActionButton>
                  {inputMode === "collection" && (
                    <p className="muted text-sm text-muted-foreground">
                      将新来源加入此配置时，会改为直接选择来源；可切回原集合。
                    </p>
                  )}
                  {!!entryOptions.length && (
                    <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                      平台分配的入口
                      <MultiChoice
                        aria-label="使用的平台入口"
                        value={draft.platformEntryIds || []}
                        searchable
                        onValueChange={(platformEntryIds) =>
                          update({ platformEntryIds })
                        }
                        options={entryOptions.map((option) => ({
                          ...option,
                          description:
                            "detail" in option ? option.detail : undefined,
                        }))}
                      />
                    </label>
                  )}

                  <Accordion type="multiple">
                    {[
                      {
                        key: "nodes",
                        label: "查看有效连接明细",
                        children: (
                          <DataTable
                            rowKey="id"
                            rows={endpoints}
                            columns={[
                              { title: "名称", accessor: "name" },
                              { title: "地区", accessor: "region" },
                              {
                                title: "协议",
                                render: (_, node) => node.connection.protocol,
                              },
                            ]}
                            pageSize={8}
                            compact
                          />
                        ),
                      },
                    ].map((section) => (
                      <AccordionItem
                        key={section.key}
                        value={String(section.key)}
                        disabled={
                          "collapsible" in section &&
                          section.collapsible === "disabled"
                        }
                      >
                        <AccordionTrigger>{section.label}</AccordionTrigger>
                        <AccordionContent
                          forceMount
                          className="data-[state=closed]:hidden"
                        >
                          {section.children}
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              </div>
            </div>
            <SourceSelectionIssues
              sources={unavailableSources}
              onRepair={(source, trigger) => {
                setSourceNotice(null);
                setError(null);
                openSourceTask(trigger, source, true);
              }}
              onRemove={
                inputMode === "sources"
                  ? (source) => {
                      setError(null);
                      changeInputs({
                        sourceIds: (draft.sourceIds || []).filter(
                          (id) => id !== source.id,
                        ),
                      });
                      focusSourceInput("sources");
                    }
                  : undefined
              }
              removeCollection={
                inputMode === "collection" ? (
                  <ActionButton
                    onClick={clearCollection}
                    variant="outline"
                    size="sm"
                  >
                    移除此集合
                  </ActionButton>
                ) : undefined
              }
            />
            {sourceNotice && (
              <Notice
                tone="warning"
                title={
                  <span className="flex items-center justify-between gap-3">
                    来源已保存，尚未加入此草稿
                    <ActionButton
                      variant="ghost"
                      size="sm"
                      aria-label="关闭来源提示"
                      onClick={() => setSourceNotice(null)}
                    >
                      关闭
                    </ActionButton>
                  </span>
                }
                action={
                  <ActionButton
                    onKeyDown={(event) => {
                      if (
                        event.repeat &&
                        (event.key === "Enter" || event.key === " ")
                      )
                        event.preventDefault();
                    }}
                    onClick={(event) =>
                      openSourceTask(event.currentTarget, sourceNotice)
                    }
                    variant="outline"
                  >
                    {canResumeSourceReview(sourceNotice)
                      ? "查看变化"
                      : "继续编辑"}
                  </ActionButton>
                }
              >
                {
                  <>
                    <p>
                      「{sourceNotice.name}」
                      {sourceNotice.candidate
                        ? "有尚未应用的更新。"
                        : !sourceNotice.enabled
                          ? "已暂停。"
                          : !sourceNotice.snapshot
                            ? "尚无可用节点。"
                            : sourceStatusUnknown(sourceNotice)
                              ? "来源状态待确认。"
                              : sourceHasFailure(sourceNotice)
                                ? "最近导入未完成。"
                                : "当前节点仍可用。"}
                    </p>
                    {sourceIssueText(sourceNotice) && (
                      <p>{sourceIssueText(sourceNotice)}</p>
                    )}
                  </>
                }
              </Notice>
            )}
            {sources.isError && (
              <div className="profile-visible-error my-3 text-sm text-destructive">
                <ErrorNotice error={sources.error} />
                <ActionButton
                  onClick={() => sources.refetch()}
                  variant="outline"
                >
                  重新加载来源
                </ActionButton>
              </div>
            )}
            {collections.isError && (
              <div className="profile-visible-error my-3 text-sm text-destructive">
                <ErrorNotice error={collections.error} />
                <ActionButton
                  onClick={() => collections.refetch()}
                  variant="outline"
                >
                  重新加载集合
                </ActionButton>
              </div>
            )}
            {entries.isError && (
              <div className="profile-visible-error my-3 text-sm text-destructive">
                <ErrorNotice error={entries.error} />
                <ActionButton
                  onClick={() => entries.refetch()}
                  variant="outline"
                >
                  重新加载平台入口
                </ActionButton>
              </div>
            )}
            {effectiveInputs.error &&
              !unavailableSources.length &&
              effectiveInputs.error !== sources.error &&
              effectiveInputs.error !== collections.error && (
                <div className="profile-visible-error my-3 text-sm text-destructive">
                  <ErrorNotice error={effectiveInputs.error} />
                  <ActionButton
                    onClick={() => effectiveInputs.retry()}
                    variant="outline"
                  >
                    重新计算有效连接
                  </ActionButton>
                </div>
              )}
            {!effectiveInputs.error &&
              effectiveInputs.diagnostics.map((item, index) => (
                <p className="muted text-sm text-muted-foreground" key={index}>
                  {item}
                </p>
              ))}
            {missingOccurrences.length > 0 && (
              <Notice
                tone="warning"
                title="部分流量去向当前不可用"
                aria-label="部分流量去向当前不可用"
                className="profile-validation-notice space-y-3"
              >
                {
                  <>
                    <p>原选择已保留，请明确选择替代连接后再发布。</p>
                    <ul className="profile-missing-actions flex flex-wrap gap-2">
                      {missingControls.map((issue) => {
                        const repair = actionRepair(draft.ir, issue);
                        return (
                          repair && (
                            <li
                              key={`${actionLocationKey(issue.location)}:${issue.reference.kind}:${issue.reference.id}`}
                            >
                              <span>{repair.title}</span>
                              <ActionButton
                                onClick={() => repairAction(issue)}
                                variant="outline"
                              >
                                {repair.action}
                              </ActionButton>
                            </li>
                          )
                        );
                      })}
                    </ul>
                  </>
                }
              </Notice>
            )}
            {errors.length > 0 && (
              <Notice
                tone="warning"
                title="继续完善策略组"
                action={
                  <ActionButton
                    onClick={() => showDetails("groups")}
                    variant="outline"
                  >
                    检查策略组
                  </ActionButton>
                }
              >
                {errors.join(" ")}
              </Notice>
            )}
            {resources.isError && (
              <div className="profile-visible-error my-3 text-sm text-destructive">
                <ErrorNotice error={resources.error} />
                <ActionButton
                  onClick={() => resources.refetch()}
                  variant="outline"
                >
                  重新加载规则文件
                </ActionButton>
              </div>
            )}
            {nativeTargetMismatch && (
              <Notice
                tone="warning"
                title="原生覆盖的客户端绑定需要调整"
                action={
                  <ActionButton
                    onClick={() => showDetails("runtime")}
                    variant="outline"
                  >
                    检查运行设置
                  </ActionButton>
                }
              >
                {
                  "原文和原绑定已保留；到运行设置中检查，不能按当前草稿客户端直接发布。"
                }
              </Notice>
            )}
            {nativeOverride && draft.mode === "nodes-only" && (
              <Notice tone="warning" title="原生覆盖不能用于纯节点默认输出">
                {"原文仍保留。请在运行设置中选择完整配置，或明确移除覆盖。"}
              </Notice>
            )}
          </section>
          <div ref={detailTabs} id={`${editorID}-details`} className="profile-editor-tools scroll-mt-32 space-y-4">
            <Tabs
              className="profile-editor-tabs space-y-4"
              value={tab}
              onValueChange={(key) => {
                setPendingRepair(null);
                setTab(key);
              }}
            >
              {
                <TabsList aria-label="配置内容" className="max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto">
                  {editorTabs.map((section) => (
                    <TabsTrigger
                      className="h-auto min-h-11 whitespace-nowrap"
                      key={section.key}
                      value={String(section.key)}
                      data-section={section.key}
                      disabled={save.isPending || ("disabled" in section && !!section.disabled)}
                    >
                      {section.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              }
              {editorTabs.map((section) => (
                <TabsContent key={section.key} value={String(section.key)}
                  forceMount={section.key === "runtime" && runtimeVisited ? true : undefined}
                  className="data-[state=inactive]:hidden">
                  <div id={`${editorID}-section-${section.key}`} className="scroll-mt-32">
                    {section.children}
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </div>
        </div>
      </div>
      <TaskDialog
        title="创建并使用策略组"
        className="profile-candidate-modal"
        bodyProps={{ className: "space-y-4" }}
        open={!!groupTask}
        onOpenChange={(nextOpen) => {
          if (!nextOpen)
            (() => {
              groupTaskOwner.current = null;
              setGroupTask(null);
            })();
        }}
        size="lg"
        footer={
          <>
            <div className="mr-auto text-sm text-muted-foreground">
              {groupTask && <>用于当前草稿：{groupTask.ownerLabel}</>}
            </div>
            <ActionButton
              variant="outline"
              onClick={() => {
                groupTaskOwner.current = null;
                setGroupTask(null);
              }}
            >
              取消
            </ActionButton>
            <ActionButton
              disabled={!groupTask || groupErrors([groupTask.group]).length > 0}
              onClick={() => {
                if (!groupTask || groupTaskOwner.current !== groupTask) return;
                if (groupTask.group.kind !== "manual" && newGroupInterval !== undefined && newGroupInterval !== "" && exactDraftInteger(newGroupInterval) === undefined) {
                  setGroupTaskError("请完成测试间隔输入，使用大于零的整数秒数。");
                  setGroupIntervalFocus((previous) => ({ id: groupTask.group.id, request: previous.request + 1 }));
                  return;
                }
                if (
                  groupTask.group.members.some(
                    (member) =>
                      !groupTaskActions.some(
                        (action) =>
                          action.value === actionValue(member) &&
                          !action.referenceID,
                      ),
                  )
                ) {
                  setGroupTaskError(
                    "所选候选连接已不可用，原选择已保留，请重新选择。",
                  );
                  return;
                }
                if (
                  !inventoryResolved &&
                  groupTask.group.members.some(
                    (member) => member.kind === "endpoint",
                  )
                ) {
                  setGroupTaskError("正在核对候选连接，请完成核对后重试。");
                  return;
                }
                const result = bindCreatedGroup(
                  draft,
                  groupTask.target,
                  groupTask.group,
                  (entries.data || []).map((entry) => entry.id),
                );
                if (!result.ok) {
                  setGroupTaskError(
                    "原流量去向已改变，请取消后从需要调整的位置重新打开。",
                  );
                  return;
                }
                groupTaskOwner.current = null;
                update({
                  ir: result.profile.ir,
                  platformEntryIds: result.profile.platformEntryIds,
                });
                setGroupTask(null);
              }}
            >
              创建并使用
            </ActionButton>
          </>
        }
      >
        {groupTask && (
          <>
            <GroupEditor
              value={groupTask.group}
              onIntervalFocused={() => setGroupIntervalFocus((previous) => ({ ...previous, id: "" }))}
              intervalRaw={newGroupInterval}
              onIntervalReset={() => setNewGroupInterval(undefined)}
              onIntervalInput={setNewGroupInterval}
              intervalFocus={groupIntervalFocus.id === groupTask.group.id ? groupIntervalFocus.request : 0}
              actionControlID={`${editorID}-new-group`}
              actions={groupTaskActions}
              sources={sources.data || []}
              onChange={(group) => {
                const next = { ...groupTask, group };
                groupTaskOwner.current = next;
                setGroupTask(next);
              }}
            />
            {!groupTask.group.name.trim() ||
            (!groupTask.group.members.length && !groupTask.group.dynamic) ? (
              <p className="muted text-sm text-muted-foreground">
                填写组名，并选择固定成员或自动加入连接。
              </p>
            ) : (
              !!groupErrors([groupTask.group]).length && (
                <p className="profile-field-error text-sm text-destructive">
                  {groupErrors([groupTask.group]).join(" ")}
                </p>
              )
            )}
            {groupTaskError && <Notice tone="error" title={groupTaskError} />}
          </>
        )}
      </TaskDialog>
      <TaskSheet
        title="草稿配置预览"
        open={!!preview}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) (() => setPreview(null))();
        }}
        size="lg"
      >
        {preview && (
          <Section title={preview.valid === false ? "需要调整" : "生成结果"}>
            {preview.diagnostics?.map((d, i) => (
              <Notice
                key={i}
                className="preview-diagnostic text-sm text-muted-foreground"
                tone={preview.valid === false ? "warning" : "info"}
                title={d}
              />
            ))}
            {preview.nativeOverride && (
              <NativeOverrideResult value={preview.nativeOverride} />
            )}
            {preview.artifacts?.map((artifact, i) => (
              <div key={i} className="space-y-2">
                <h4 className="break-all font-mono text-xs text-muted-foreground">
                  {artifact.path}
                </h4>
                <CodePreview content={redact(artifact.content)} />
              </div>
            ))}
            {preview.content && (
              <CodePreview content={redact(preview.content)} />
            )}
          </Section>
        )}
      </TaskSheet>
      <TaskSheet
        title="配置意图 JSON"
        bodyProps={{ className: "space-y-4" }}
        open={codeOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeCode();
        }}
        size="lg"
        footer={
          <ActionButton
            onClick={() => {
              try {
                const ir = parseDraftIR(JSON.parse(code));
                update({ ir });
                // Applying JSON explicitly replaces the form intent, including
                // raw numeric edits whose accepted value did not change.
                setGroupIntervalDrafts({});
                setRuntimeNumericErrors({});
                setRuntimeNumericFocus(null);
                setRuntimeNumericLifetime((lifetime) => lifetime + 1);
                setCodeBaseline(code);
                setCodeOpen(false);
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
            variant="outline"
          >
            应用到草稿
          </ActionButton>
        }
      >
        <p className="muted text-sm text-muted-foreground">
          应用到草稿后仍需保存。
        </p>
        <Textarea
          className="json-editor min-h-48 font-mono text-xs"
          rows={30}
          aria-label="配置意图 JSON 文本"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
        />
      </TaskSheet>
      <SourceImportTask
        open={!!sourceTask}
        source={sourceTask?.source}
        onFinish={(result) => {
          if (!sourceTask || sourceOwner.current !== sourceTask) return;
          if (sourceTask.selected) {
            // Source-only recovery never rewrites the parent input mode/recipe.
            setSourceNotice(null);
            setError(null);
            setPreview(null);
          } else if (result.kind === "ready") {
            const source = result.source;
            setSavedSourceNames((current) =>
              new Map(current).set(source.id, source.name),
            );
            if (inputMode === "collection")
              retainedCollection.current = draft.collectionId;
            const previousSources =
              inputMode === "sources"
                ? draft.sourceIds || []
                : retainedSources.current;
            setInputMode("sources");
            update({
              sourceIds: [...new Set([...previousSources, source.id])],
              collectionId: undefined,
            });
            setSourceNotice(null);
          } else setSourceNotice(result.source || null);
          sourceOwner.current = null;
          sourceReturnFocus.current = true;
          setSourceTask(null);
        }}
      />
      <AccessSubscription
        output={publishedAccess?.output || null}
        replacement={publishedAccess?.replacement}
        onClose={() => setPublishedAccess(null)}
      />
      {reviewOpen && (
        <ProfilePublicationDialog
          profile={publicationProfile}
          preferredOutput={boundOutput}
          suspended={
            repairingReview ||
            !completeDraft.ok ||
            reviewRevision !== revision.current
          }
          onRepair={
            reviewRevision === revision.current
              ? (issue) => {
                  setRepairingReview(true);
                  repairAction(issue);
                }
              : undefined
          }
          onPublished={(value, created, replaced) => {
            setBoundOutput(value);
            if (created || replaced || value.delivery === "bundle")
              setPublishedAccess({ output: value, replacement: replaced ? "publication" : undefined });
          }}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </div>
  );
}
function GroupEditor({
  onIntervalFocused,
  onIntervalReset,
  intervalRaw,
  onIntervalInput,
  intervalFocus,
  value,
  onChange,
  onRemove,
  actions,
  sources,
  actionControlID,
  usage,
}: {
  onIntervalFocused: () => void;
  onIntervalReset: () => void;
  intervalRaw?: string;
  onIntervalInput: (raw: string) => void;
  intervalFocus: number;
  value: Group;
  actionControlID: string;
  onChange: (g: Group, chosenMembers?: ActionRef[]) => void;
  onRemove?: () => void;
  actions: ActionOption[];
  sources: Source[];
  usage?: ReactNode;
}) {
  const [testSections, setTestSections] = useState<string[]>([]);
  useLayoutEffect(() => {
    if (intervalFocus) setTestSections((previous) => previous.includes("policy") ? previous : [...previous, "policy"]);
  }, [intervalFocus]);
  const dynamicEnabled = value.dynamic != null;
  const hasConditions = Object.values(value.dynamic || {}).some((condition) =>
    Array.isArray(condition) ? condition.length > 0 : !!condition,
  );
  const updateDynamic = (dynamic: NonNullable<Group["dynamic"]>) =>
    onChange({
      ...value,
      dynamic: Object.fromEntries(
        Object.entries(dynamic).filter(([, condition]) =>
          Array.isArray(condition)
            ? condition.length > 0
            : condition !== undefined && condition !== "",
        ),
      ),
    });
  return (
    <div
      className="group-card mb-4 space-y-4 rounded-lg border p-4"
      role="group"
      aria-label={`策略组「${value.name || "未命名"}」`}
    >
      <div className="form-grid grid gap-4 sm:grid-cols-2 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
        <label>
          策略组名称
          <Input
            value={value.name}
            aria-label="策略组名称"
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </label>
        <label>
          选择策略
          <ChoiceSelect
            value={value.kind}
            options={[
              { value: "manual", label: "手动选择" },
              { value: "url-test", label: "延迟优选" },
              { value: "fallback", label: "故障切换" },
              { value: "load-balance", label: "负载均衡" },
            ]}
            onValueChange={(kind) => {
              if (kind === undefined) return;
              if (kind === "manual") onIntervalReset();
              return onChange({
                ...value,
                kind,
                testUrl:
                  kind === "manual"
                    ? undefined
                    : value.testUrl || "https://www.gstatic.com/generate_204",
                intervalSeconds:
                  kind === "manual" ? undefined : value.intervalSeconds || 300,
                strategy:
                  kind === "load-balance"
                    ? value.strategy || "consistent-hashing"
                    : undefined,
                toleranceMs:
                  kind === "url-test" ? (value.toleranceMs ?? 50) : undefined,
              });
            }}
          />
        </label>
      </div>
      {usage}
      <label
        className="standalone-label grid min-w-0 gap-2 text-sm font-medium"
        id={actionControlID}
      >
        固定成员
        <MultiChoice
          aria-label={`策略组「${value.name}」的固定成员`}
          aria-describedby={
            actions.some(
              (option) =>
                option.referenceID &&
                value.members.some(
                  (reference) => actionValue(reference) === option.value,
                ),
            )
              ? `${actionControlID}-references`
              : undefined
          }
          value={value.members.map(actionValue)}
          onValueChange={(members) => {
            const chosen = members.map(parseAction);
            onChange({ ...value, members: chosen }, chosen);
          }}
          searchable
          placeholder="选择节点或其他策略组"
          options={actions
            .filter((a) => a.value !== `group:${value.id}`)
            .map((option) => ({
              ...option,
              description: option.referenceID || option.detail,
            }))}
        />
      </label>
      <ActionReferenceDetails
        controlID={actionControlID}
        location={`策略组「${value.name}」成员`}
        references={value.members}
        actions={actions}
      />
      <div className="group-automatic-members space-y-3 rounded-lg bg-muted/50 p-4">
        <div className="group-automatic-heading flex flex-wrap justify-between gap-2">
          <label htmlFor={`${actionControlID}-automatic`}>自动加入连接</label>
          <Switch
            id={`${actionControlID}-automatic`}
            aria-label="自动加入连接"
            aria-describedby={`${actionControlID}-automatic-state${hasConditions ? ` ${actionControlID}-automatic-clear` : ""}`}
            checked={dynamicEnabled}
            onCheckedChange={(enabled) =>
              onChange({ ...value, dynamic: enabled ? {} : undefined })
            }
          />
        </div>
        <div
          id={`${actionControlID}-automatic-state`}
          className="group-automatic-state text-sm text-muted-foreground"
          aria-live="polite"
        >
          {!dynamicEnabled
            ? "仅固定成员"
            : hasConditions
              ? "按条件自动加入"
              : "当前配置中的全部连接"}
        </div>
        {hasConditions && (
          <small id={`${actionControlID}-automatic-clear`}>
            关闭将清除筛选条件
          </small>
        )}
        {dynamicEnabled && (
          <Accordion type="multiple">
            {[
              {
                key: "dynamic",
                label: "筛选条件",
                children: (
                  <>
                    <FilterFields
                      value={value.dynamic || {}}
                      onChange={updateDynamic}
                    />
                    <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                      限定来源
                      <ChoiceSelect
                        clearable
                        value={value.dynamic?.sourceId}
                        aria-label="限定来源"
                        placeholder="不限来源"
                        options={sources.map((s) => ({
                          value: s.id,
                          label: s.name,
                        }))}
                        onValueChange={(sourceId) =>
                          updateDynamic({ ...value.dynamic, sourceId })
                        }
                      />
                    </label>
                  </>
                ),
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
                <AccordionContent
                  forceMount
                  className="data-[state=closed]:hidden"
                >
                  {section.children}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
      {value.kind !== "manual" && (
        <Accordion type="multiple" value={testSections} onValueChange={setTestSections}>
          {[
            {
              key: "policy",
              label: "策略参数",
              children: (
                <>
                  <div className="form-grid grid gap-4 sm:grid-cols-2 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
                    <label>
                      测试地址
                      <Input
                        value={value.testUrl}
                        placeholder="https://www.gstatic.com/generate_204"
                        onChange={(e) =>
                          onChange({ ...value, testUrl: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      测试间隔（秒）
                      <DraftIntegerInput
                        value={value.intervalSeconds}
                        raw={intervalRaw}
                        focusRequest={intervalFocus}
                        onFocusHandled={onIntervalFocused}
                        onInput={(raw) => {
                          onIntervalInput(raw);
                          const interval = raw === "" ? 300 : exactDraftInteger(raw);
                          if (interval !== undefined) onChange({ ...value, intervalSeconds: interval });
                        }}
                      />
                    </label>
                  </div>
                  {value.kind === "load-balance" && (
                    <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                      均衡方式
                      <ChoiceSelect
                        value={value.strategy || "consistent-hashing"}
                        options={[
                          { value: "consistent-hashing", label: "一致性哈希" },
                          { value: "round-robin", label: "轮询" },
                        ]}
                        onValueChange={(strategy) => {
                          if (strategy === undefined) return;
                          return onChange({ ...value, strategy });
                        }}
                      />
                    </label>
                  )}
                </>
              ),
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
              <AccordionContent
                forceMount
                className="data-[state=closed]:hidden"
              >
                {section.children}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
      {onRemove && (
        <ActionButton
          className="remove-inline"
          onClick={onRemove}
          leadingIcon={<Trash2 aria-hidden="true" />}
          variant="destructive"
          size="sm"
        >
          移除策略组
        </ActionButton>
      )}
    </div>
  );
}
function MatchEditor({
  value,
  onChange,
  resources,
  nested = false,
  depth = 0,
  onRemove,
}: {
  value: MatchExpression;
  onChange: (m: MatchExpression, selectedResource?: RuleResource) => void;
  resources: RuleResource[];
  nested?: boolean;
  depth?: number;
  onRemove?: () => void;
}) {
  const confirm = useConfirm();
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ value, onChange });
  const pending = useRef<{
    value: MatchExpression;
    destroy: () => void;
  } | null>(null);
  const focusFrame = useRef<number | null>(null);
  useLayoutEffect(() => {
    latest.current = { value, onChange };
    if (pending.current && pending.current.value !== value) {
      pending.current.destroy();
      pending.current = null;
    }
  });
  useLayoutEffect(
    () => () => {
      pending.current?.destroy();
      pending.current = null;
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );
  const focusValue = (last = false) => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      const fields = root.current?.querySelectorAll<HTMLElement>(
        '[aria-label="规则匹配值"], [aria-label="匹配规则文件"]',
      );
      const field = fields?.[last ? fields.length - 1 : 0];
      (
        field ||
        root.current?.querySelector<HTMLElement>('[aria-label="条件操作"]')
      )?.focus();
    });
  };
  const confirmReplacement = (next: MatchExpression, description: string) => {
    if (pending.current) return;
    const captured = value;
    const active = document.activeElement as HTMLElement | null;
    const trigger =
      active?.getAttribute("role") === "combobox"
        ? active
        : active?.closest('[data-slot="popover-content"]')
          ? root.current?.querySelector<HTMLElement>(
              '[aria-label="规则匹配方式"]',
            )
          : root.current?.querySelector<HTMLElement>('[aria-label="条件操作"]');
    let confirmed = false;
    const dialog = confirm({
      title: "替换当前匹配条件？",
      description: description,
      confirmLabel: "替换条件",
      cancelLabel: "保留原条件",
      destructive: true,
      onConfirm: () => {
        if (
          !pending.current ||
          pending.current.value !== captured ||
          latest.current.value !== captured
        )
          return;
        confirmed = true;
        pending.current = null;
        latest.current.onChange(next);
      },
      onCancel: () => {
        pending.current = null;
      },
      onClosed: () => {
        if (!root.current) return;
        if (confirmed) focusValue();
        else if (latest.current.value === captured && trigger?.isConnected)
          trigger.focus();
      },
    });
    pending.current = { value: captured, destroy: dialog.close };
  };
  // Raw JSON is retained in the draft. Only interpret shapes the form can
  // actually represent; use the same depth bound as domain validation.
  const readable =
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.op === "string" &&
    depth <= 128;
  const operator = readable ? value.op : "";
  const boolean = ["and", "or", "not"].includes(operator);
  const readableChildren =
    Array.isArray(value?.children) &&
    value.children.every(
      (child) =>
        !!child &&
        typeof child === "object" &&
        !Array.isArray(child) &&
        typeof child.op === "string",
    );
  const composite =
    boolean &&
    readableChildren &&
    (operator !== "not" || value.children!.length === 1) &&
    (value.value === undefined || value.value === "");
  const group = composite && (operator === "and" || operator === "or");
  const leafOptions = [
    { value: "domain", label: "完整域名" },
    { value: "domain-suffix", label: "域名后缀" },
    { value: "ip-cidr", label: "IP 网段" },
    { value: "resource", label: "规则文件" },
  ];
  const knownLeaf =
    readable &&
    leafOptions.some((option) => option.value === operator) &&
    (value.value === undefined || typeof value.value === "string");
  // A scalar polarity control is only a view of a lossless NOT wrapper.
  // Opaque wrappers and structural children keep the explicit tree view.
  const scalarShape = (candidate: MatchExpression) =>
    !!candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    leafOptions.some((option) => option.value === candidate.op) &&
    (candidate.value === undefined || typeof candidate.value === "string") &&
    (candidate.children === undefined ||
      (Array.isArray(candidate.children) && candidate.children.length === 0));
  const projectedNegative =
    composite &&
    operator === "not" &&
    depth < 128 &&
    Object.keys(value).every((key) => key === "op" || key === "children") &&
    scalarShape(value.children![0]);
  const scalar = knownLeaf
    ? value
    : projectedNegative
      ? value.children![0]
      : null;
  const scalarPolarity = !!scalar && scalarShape(scalar);
  const updateScalar = (
    next: MatchExpression,
    selectedResource?: RuleResource,
  ) =>
    onChange(
      projectedNegative ? { ...value, children: [next] } : next,
      selectedResource,
    );
  const add = () => {
    const blank = { op: "domain-suffix", value: "" };
    onChange(
      group
        ? { ...value, children: [...(value.children || []), blank] }
        : { op: "and", children: [value, blank] },
    );
    focusValue(true);
  };
  const replace = (op: string) => {
    const blank = { op, value: "" };
    const next = projectedNegative ? { ...value, children: [blank] } : blank;
    const emptyLeaf =
      !!scalar &&
      !scalar.value &&
      Object.keys(scalar).every((key) => key === "op" || key === "value");
    if (emptyLeaf) {
      onChange(next);
      focusValue();
    } else {
      const label = leafOptions.find((option) => option.value === op)!.label;
      confirmReplacement(
        next,
        projectedNegative
          ? `当前不匹配的内容将替换为“${label}”的空条件，保留不匹配关系。`
          : `当前条件及其子条件将被替换为“${label}”的空条件。`,
      );
    }
  };
  const unwrap = () => {
    const child = value.children![0];
    if (Object.keys(value).some((key) => key !== "op" && key !== "children")) {
      confirmReplacement(
        child,
        "取消不匹配将保留内部条件，并移除外层条件及其附加字段。",
      );
    } else {
      onChange(child);
      focusValue();
    }
  };
  const menu = [
    ...(readable && nested && !group
      ? [{ key: "add", label: "添加条件", onClick: add }]
      : []),
    ...(readable && !scalarPolarity
      ? [
          {
            key: "negate",
            label: composite ? "不匹配此组" : "不匹配此条件",
            onClick: () => {
              onChange({ op: "not", children: [value] });
              focusValue();
            },
          },
        ]
      : []),
    ...(composite && operator === "not" && !projectedNegative
      ? [{ key: "unwrap", label: "取消不匹配", onClick: unwrap }]
      : []),
    {
      key: "replace",
      label: "替换为",
      children: leafOptions.map((option) => ({
        key: option.value,
        label: option.label,
        onClick: () => replace(option.value),
      })),
    },
    ...(onRemove
      ? [
          {
            key: "remove",
            label: "移除匹配条件",
            danger: true,
            onClick: onRemove,
          },
        ]
      : []),
  ];
  return (
    <div
      ref={root}
      className={`match-editor space-y-3 ${composite ? "composite" : ""}`}
    >
      <div
        className={`match-line flex flex-wrap items-center gap-2 ${scalar ? "match-leaf-line" : ""} ${scalarPolarity ? "match-scalar-line" : ""}`}
      >
        {composite && operator === "not" && !projectedNegative ? (
          <strong className="match-relation text-xs font-medium text-muted-foreground">
            不匹配以下条件
          </strong>
        ) : group || scalar ? (
          <ChoiceSelect
            aria-label="规则匹配方式"
            value={scalar?.op || value.op}
            options={
              group
                ? [
                    { value: "and", label: "全部满足（AND）" },
                    { value: "or", label: "任一满足（OR）" },
                  ]
                : leafOptions
            }
            onValueChange={(op) => {
              if (op === undefined) return;
              if (group) onChange({ ...value, op });
              else if (
                scalar &&
                ["domain", "domain-suffix"].includes(scalar.op) &&
                ["domain", "domain-suffix"].includes(op)
              )
                updateScalar({ ...scalar, op });
              else replace(op);
            }}
          />
        ) : (
          <span className="match-relation text-xs font-medium text-muted-foreground">
            {readable &&
            !boolean &&
            !leafOptions.some((option) => option.value === operator)
              ? `未支持的匹配方式：${operator}`
              : "条件结构暂不支持，原内容已保留"}
          </span>
        )}
        {scalarPolarity && (
          <ChoiceSelect
            className="match-polarity text-xs font-medium"
            aria-label="条件匹配关系"
            value={projectedNegative ? "negative" : "positive"}
            options={[
              { value: "positive", label: "匹配" },
              { value: "negative", label: "不匹配" },
            ]}
            onValueChange={(polarity) => {
              if (polarity === undefined) return;
              return onChange(
                polarity === "negative"
                  ? { op: "not", children: [scalar!] }
                  : scalar!,
              );
            }}
          />
        )}
        {scalar &&
          (scalar.op === "resource" ? (
            <ChoiceSelect
              className="match-value wrap-anywhere font-mono text-xs"
              value={scalar.value}
              aria-label="匹配规则文件"
              options={resources
                .map((r) => ({
                  value: r.id,
                  label: (
                    <span className="block min-w-0 space-y-1">
                      <span className="block">{r.name || r.id}</span>{" "}
                      <Metadata className="text-xs text-muted-foreground">
                        <MetadataItem>{r.acceptedVersion ? "已接纳文件" : "远程引用"}</MetadataItem>
                        <MetadataItem>{r.format}</MetadataItem>
                        {r.acceptedVersion && r.location === "local" && <MetadataItem>随完整配置打包</MetadataItem>}
                        {r.acceptedVersion && r.refreshStatus === "failed" && <MetadataItem>刷新失败</MetadataItem>}
                      </Metadata>
                    </span>
                  ),
                  searchText: `${r.name || r.id} ${r.format}`,
                }))}
              onValueChange={(v) => {
                if (v === undefined) return;
                return updateScalar(
                  { ...scalar, value: v },
                  resources.find((resource) => resource.id === v),
                );
              }}
            />
          ) : (
            <Input
              className="match-value wrap-anywhere font-mono text-xs"
              value={scalar.value}
              aria-label="规则匹配值"
              placeholder={
                scalar.op === "ip-cidr" ? "192.168.0.0/16" : "example.com"
              }
              onChange={(e) =>
                updateScalar({ ...scalar, value: e.target.value })
              }
            />
          ))}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <ActionButton
              className="match-actions flex flex-wrap gap-2"
              aria-label="条件操作"
              leadingIcon={<MoreVertical aria-hidden="true" />}
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
            <MatchActionItems items={menu} close={() => setMenuOpen(false)} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {scalar?.op === "resource" &&
        resources.some(
          (resource) =>
            resource.id === scalar.value &&
            resource.location === "local" &&
            !!resource.acceptedVersion,
        ) && (
          <p className="profile-resource-delivery space-y-2">
            用于完整配置时，需下载配置与规则文件包。
          </p>
        )}
      {composite && !projectedNegative && (
        <div className="match-children ml-3 space-y-3 border-l pl-3">
          {value.children?.map((child, index) => (
            <div className="match-child space-y-2" key={index}>
              <MatchEditor
                value={child}
                resources={resources}
                nested
                depth={depth + 1}
                onChange={(next, selectedResource) =>
                  onChange(
                    {
                      ...value,
                      children: value.children!.map((c, i) =>
                        i === index ? next : c,
                      ),
                    },
                    selectedResource,
                  )
                }
                onRemove={
                  value.children!.length > 1
                    ? () =>
                        onChange({
                          ...value,
                          children: value.children!.filter(
                            (_, i) => i !== index,
                          ),
                        })
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      )}
      {readable && (group || !nested) && (
        <ActionButton
          className="match-add mt-3"
          leadingIcon={<Plus aria-hidden="true" />}
          onClick={add}
          variant="outline"
          size="sm"
        >
          添加条件
        </ActionButton>
      )}
    </div>
  );
}
/** Runtime capabilities share a row rhythm; optional parameters belong to that row. */
function RuntimeSetting({
  title,
  description,
  label,
  checked,
  onCheckedChange,
  children,
}: {
  title: string;
  description: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  const descriptionID = useId();
  return (
    <div className="runtime-setting-row min-w-0 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium leading-6">{title}</h3>
          <p
            id={descriptionID}
            className="text-sm leading-relaxed text-muted-foreground"
          >
            {description}
          </p>
        </div>
        <Switch
          className="mt-1 shrink-0"
          aria-label={label}
          aria-describedby={descriptionID}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
      {children && (
        <div className="runtime-setting-fields mt-4 min-w-0 space-y-4 border-t pt-4">
          {children}
        </div>
      )}
    </div>
  );
}
// Check the decimal spelling before Number can round away fractional intent.
// Bounded input and exponent work prevent oversized text from growing integers.
function exactRuntimePort(raw: string): number | undefined {
  if (raw.length > 256) return undefined;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,3}))?$/.exec(raw);
  if (!match || match[0] !== raw) return undefined;
  const fraction = match[2] ?? match[3] ?? "";
  let digits = ((match[1] || "0") + fraction).replace(/^0+/, "") || "0";
  const shift = Number(match[4] || "0") - fraction.length;
  if (shift < 0) {
    const removed = -shift;
    if (removed >= digits.length || !/^0*$/.test(digits.slice(-removed))) return undefined;
    digits = digits.slice(0, -removed);
  } else {
    if (digits.length + shift > 5) return undefined;
    digits += "0".repeat(shift);
  }
  if (digits.length > 5) return undefined;
  const port = Number(digits);
  return port >= 1 && port <= 65535 ? port : undefined;
}
function readableRuntimeDNS(dns: ProfileIR["runtime"]["dns"]): boolean {
  return !!dns &&
    typeof dns === "object" &&
    !Array.isArray(dns) &&
    Array.isArray(dns.servers) &&
    (dns.final === undefined || typeof dns.final === "string") &&
    dns.servers.every((server) =>
      !!server &&
      typeof server === "object" &&
      !Array.isArray(server) &&
      typeof server.id === "string" &&
      server.id.length > 0 &&
      typeof server.type === "string" &&
      typeof server.address === "string" &&
      (server.port === undefined || typeof server.port === "number"),
    );
}
function RuntimeEditor({
  value,
  onChange,
  onRepairDNS,
  numericIDPrefix,
  numericResetKey,
  numericErrors,
  onNumericEdit,
}: {
  value: Pick<ProfileIR, "runtime">;
  onChange: (value: Pick<ProfileIR, "runtime">) => void;
  onRepairDNS: () => void;
  numericIDPrefix: string;
  numericResetKey: number;
  numericErrors: Record<string, boolean>;
  onNumericEdit: (key: string, raw: string) => void;
}) {
  const runtime = value.runtime;
  const defaultDNS = useRef<HTMLButtonElement>(null);
  const dnsIssueID = useId();
  // JSON drafts may violate the static IR type. Interpret only representable
  // shapes; never filter bad rows, coerce values, or replace the saved intent.
  const dns = runtime.dns;
  const readableDNS = readableRuntimeDNS(dns);
  const missingDefaultDNS =
    readableDNS &&
    (!dns!.final || !dns!.servers.some((server) => server.id === dns!.final));
  const update = (patch: Partial<ProfileIR["runtime"]>) =>
    onChange({ runtime: { ...runtime, ...patch } });
  return (
    <>
      <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
        本地混合代理端口
        <NumericInput
          value={runtime.mixedPort}
          min={1}
          max={65535}
          resetKey={numericResetKey}
          id={`${numericIDPrefix}mixed-port`}
          aria-invalid={numericErrors["mixed-port"] || undefined}
          onInputText={(raw) => {
            onNumericEdit("mixed-port", raw);
            const mixedPort = exactRuntimePort(raw);
            if (mixedPort !== undefined) update({ mixedPort });
          }}
        />
      </label>
      <div
        role="group"
        aria-label="客户端网络能力"
        className="runtime-settings-group divide-y rounded-lg border"
      >
        <RuntimeSetting
          title="DNS 解析"
          description="为客户端设置独立的 DNS 服务器。"
          checked={runtime.dns !== undefined}
          label="启用 DNS"
          onCheckedChange={(enabled) => {
            const id = newID("dns");
            update({
              dns: enabled
                ? {
                    servers: [
                      {
                        id,
                        type: "tls",
                        address: "1.1.1.1",
                        port: 853,
                      },
                    ],
                    final: id,
                  }
                : undefined,
            });
          }}
        >
          {runtime.dns !== undefined && !readableDNS && (
            <Notice
              tone="warning"
              title="DNS 结构无法读取"
              action={
                <ActionButton variant="outline" onClick={onRepairDNS}>
                  修复 DNS JSON
                </ActionButton>
              }
            >
              原始内容保留在当前草稿中，请在配置意图 JSON 中修复后再保存。
            </Notice>
          )}
          {readableDNS && runtime.dns && (
            <>
              {runtime.dns.servers.map((server, index) => (
                <div
                  className="dns-row grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
                  key={server.id}
                >
                  <label className="grid min-w-0 gap-2 text-sm font-medium">
                    传输协议
                    <ChoiceSelect
                      aria-label={`DNS 传输协议 ${index + 1}`}
                      value={server.type}
                      options={["udp", "tcp", "tls"].map((value) => ({
                        value,
                        label: value.toUpperCase(),
                      }))}
                      onValueChange={(type) => {
                        if (type === undefined) return;
                        return update({
                          dns: {
                            ...runtime.dns!,
                            servers: runtime.dns!.servers.map((s, i) =>
                              i === index ? { ...s, type } : s,
                            ),
                          },
                        });
                      }}
                    />
                  </label>
                  <label className="grid min-w-0 gap-2 text-sm font-medium">
                    服务器地址
                    <Input
                      value={server.address}
                      aria-label={`DNS 服务器 ${index + 1}`}
                      placeholder="1.1.1.1"
                      onChange={(e) =>
                        update({
                          dns: {
                            ...runtime.dns!,
                            servers: runtime.dns!.servers.map((s, i) =>
                              i === index
                                ? { ...s, address: e.target.value }
                                : s,
                            ),
                          },
                        })
                      }
                    />
                  </label>
                  <label className="grid min-w-0 gap-2 text-sm font-medium">
                    端口
                    <NumericInput
                      aria-label={`DNS 端口 ${index + 1}`}
                      value={server.port}
                      min={1}
                      max={65535}
                      resetKey={numericResetKey}
                      id={`${numericIDPrefix}dns-${server.id}`}
                      aria-invalid={numericErrors[`dns-${server.id}`] || undefined}
                      onInputText={(raw) => {
                        onNumericEdit(`dns-${server.id}`, raw);
                        const port = exactRuntimePort(raw);
                        if (port === undefined) return;
                        update({
                          dns: {
                            ...runtime.dns!,
                            servers: runtime.dns!.servers.map((s, i) =>
                              i === index ? { ...s, port } : s,
                            ),
                          },
                        });
                      }}
                    />
                  </label>
                  <ActionButton
                    className="justify-self-end self-end"
                    aria-label={`删除 DNS ${index + 1}`}
                    leadingIcon={<Trash2 aria-hidden="true" />}
                    onClick={() =>
                      update({
                        dns: {
                          ...runtime.dns!,
                          servers: runtime.dns!.servers.filter(
                            (_, i) => i !== index,
                          ),
                        },
                      })
                    }
                    variant="ghost"
                  />
                </div>
              ))}
              <ActionButton
                leadingIcon={<Plus aria-hidden="true" />}
                onClick={() =>
                  update({
                    dns: {
                      ...runtime.dns!,
                      servers: [
                        ...runtime.dns!.servers,
                        {
                          id: newID("dns"),
                          type: "tls",
                          address: "",
                          port: 853,
                        },
                      ],
                    },
                  })
                }
                variant="outline"
                size="sm"
              >
                添加 DNS
              </ActionButton>
              <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                默认 DNS
                <ChoiceSelect
                  ref={defaultDNS}
                  aria-label="默认 DNS"
                  aria-invalid={missingDefaultDNS || undefined}
                  aria-describedby={missingDefaultDNS ? dnsIssueID : undefined}
                  selectedLabel={missingDefaultDNS
                    ? runtime.dns.final
                      ? `已缺失：${runtime.dns.final}`
                      : "尚未选择默认 DNS"
                    : undefined}
                  value={runtime.dns.final}
                  options={runtime.dns.servers.map((s) => ({
                    value: s.id,
                    label: s.address || "未填写地址",
                  }))}
                  onValueChange={(final) => {
                    if (final === undefined) return;
                    return update({ dns: { ...runtime.dns!, final } });
                  }}
                />
              </label>
              {missingDefaultDNS && (
                <Notice
                  id={dnsIssueID}
                  tone="warning"
                  title="默认 DNS 不可用"
                  action={
                    <ActionButton
                      variant="outline"
                      onClick={() => defaultDNS.current?.focus()}
                    >
                      重新选择默认 DNS
                    </ActionButton>
                  }
                >
                  {runtime.dns.servers.length
                    ? "请选择现有服务器。可先保存草稿，检查通过后才能发布。"
                    : "请先添加 DNS 服务器，再选择默认 DNS。可先保存草稿，检查通过后才能发布。"}
                </Notice>
              )}
            </>
          )}
        </RuntimeSetting>
        <RuntimeSetting
          title="流量嗅探"
          description="识别流量中的域名，辅助分流匹配。"
          label="启用流量嗅探"
          checked={!!runtime.sniff}
          onCheckedChange={(sniff) => update({ sniff })}
        />
        <RuntimeSetting
          title="TUN 虚拟网卡"
          description="生成 TUN 配置，客户端仍需获得设备系统权限。"
          label="启用 TUN"
          checked={!!runtime.tun?.enabled}
          onCheckedChange={(enabled) =>
            update({
              tun: {
                addresses: ["172.19.0.1/30"],
                autoRoute: true,
                ...runtime.tun,
                enabled,
              },
            })
          }
        >
          {runtime.tun?.enabled && (
            <>
              <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                网卡地址
                <MultiChoice
                  value={runtime.tun.addresses}
                  onValueChange={(addresses) =>
                    update({ tun: { ...runtime.tun!, addresses } })
                  }
                  creatable
                  options={[]}
                />
              </label>
              <Label className="inline-flex items-center gap-2 text-sm">
                <Checkbox
                  checked={runtime.tun.autoRoute}
                  onCheckedChange={(checked) =>
                    ((e) =>
                      update({
                        tun: { ...runtime.tun!, autoRoute: e.target.checked },
                      }))({ target: { checked: checked === true } })
                  }
                />
                自动配置路由
              </Label>
            </>
          )}
        </RuntimeSetting>
      </div>
    </>
  );
}

interface MatchCommand {
  key: string;
  label: ReactNode;
  children?: MatchCommand[];
  danger?: boolean;
  onClick?: () => void;
}
function MatchActionItems({
  items,
  close,
}: {
  items: MatchCommand[];
  close: () => void;
}) {
  return (
    <>
      {items.map((item) =>
        item.children ? (
          <DropdownMenuSub key={item.key}>
            <DropdownMenuSubTrigger>{item.label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <MatchActionItems items={item.children} close={close} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <DropdownMenuItem
            key={item.key}
            variant={item.danger ? "destructive" : "default"}
            onSelect={() => {
              close();
              queueMicrotask(() => item.onClick?.());
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ),
      )}
    </>
  );
}

