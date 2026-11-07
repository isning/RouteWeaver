import { Metadata } from "./ui-patterns/metadata";
import type { DataTableProps, DataTableHandle } from "./DataTable";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TaskSheet, TaskDialog } from "@/ui-patterns/task-overlays";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Notice } from "@/ui-patterns/notice";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/ui-patterns/actions";
import { toast } from "sonner";
import { BookOpen, Plus, RotateCw } from "lucide-react";
import { revealFocusedPolicyModalControl as revealFocusedModalAction } from "./drawer-control-visibility";
import { DataTable } from "./DataTable";
import { useUnsavedChanges } from "./navigation";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { invalidateOutputInputs } from "./output-comparison";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { APIError, list, post } from "./api";
import type {
  ActionRef,
  Artifact,
  Collection,
  Group,
  Rule,
  Profile,
  Runtime,
  PlatformEntry,
  TemplateRoutingReview,
  FrozenRoutingIntent,
} from "./types";
import {
  CodePreview,
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { dateLabel, newID, redact } from "./model";
import {
  FrozenRoutingComparison,
  RoutingSummaryView,
  hasCompleteFrozenRoutingIntent,
} from "./RoutingSummary";
type Kind = "processing-preset" | "client-profile";
interface Spec {
  steps?: unknown[];
  endpointSlots?: {
    id: string;
    name: string;
  }[];
  resourceSlots?: {
    id: string;
    name: string;
  }[];
  groups?: Group[];
  rules?: Rule[];
  defaultAction?: ActionRef;
  runtime?: Runtime;
}
interface Template {
  id: string;
  name: string;
  kind: Kind;
  version: number;
  spec: Spec;
  publishedAt?: string;
}
interface SlotBindings {
  endpoints?: Record<string, string>;
  resources?: Record<string, string>;
}
interface Binding {
  bindings?: SlotBindings;
  id: string;
  templateId: string;
  targetKind: string;
  targetId: string;
  mode: "copy" | "pinned" | "follow";
  appliedVersion: number;
  updatedAt: string;
}
interface UpdatePreview {
  review?: TemplateRoutingReview;
  candidateVersion: number;
  currentVersion: number;
  compatible: boolean;
  hasUpdate: boolean;
  diagnostics: string[];
  changes: string[];
  preservedLocalEdits: string[];
  nativeChecked: boolean;
  previewDigest: string;
  artifacts?: Artifact[];
}
const changeCategoryLabels: Record<string, string> = {
  rules: "分流规则已更改",
  defaultAction: "默认去向已更改",
  groups: "策略组设置已更改",
  runtime: "运行设置已更改",
  steps: "节点处理步骤已更改",
};
// Translate only the merge report's known grammar; do not infer extra edits.
function preservedItem(
  path: string,
  current?: FrozenRoutingIntent,
): {
  label: string;
  id?: string;
} | null {
  const fields: Record<string, string> = {
    defaultAction: "默认去向",
    "runtime.mixedPort": "监听端口",
    "runtime.sniff": "流量识别",
    "runtime.dns": "DNS 设置",
    "runtime.tun": "TUN 设置",
  };
  if (Object.hasOwn(fields, path)) return { label: fields[path] };
  const item =
    /^(rules|groups|steps)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})( \(deleted\))?$/.exec(
      path,
    );
  if (!item) return null;
  const objects: Record<string, string> = {
    rules: "规则",
    groups: "策略组",
    steps: "处理步骤",
  };
  const object = objects[item[1]];
  if (item[1] === "rules" && !item[3] && current?.kind === "portable") {
    const index = current.rules?.findIndex((rule) => rule.id === item[2]) ?? -1;
    if (index >= 0)
      return { label: `当前第${index + 1}条规则的修改`, id: item[2] };
  }
  return {
    label: item[3] ? `保持删除的${object}` : `${object}修改`,
    id: item[2],
  };
}
function TemplateUpdateChanges({
  preview,
  profile,
}: {
  preview: UpdatePreview;
  profile: boolean;
}) {
  const review =
    preview.review?.version === 1 && preview.review.scope === "profile-routing"
      ? preview.review
      : undefined;
  const current =
    review?.current.state === "available" && review.current.intent.version === 1
      ? review.current.intent
      : undefined;
  const candidate =
    review?.candidate.state === "available" &&
    review.candidate.intent.version === 1
      ? review.candidate.intent
      : undefined;
  const comparable = profile && !!current && !!candidate;
  const portableComparison =
    comparable &&
    hasCompleteFrozenRoutingIntent(current) &&
    hasCompleteFrozenRoutingIntent(candidate);
  const categories = preview.changes.filter(
    (path) => !portableComparison || !["rules", "defaultAction"].includes(path),
  );
  const preserved = preview.preservedLocalEdits.map((path) =>
    preservedItem(path, current),
  );
  const omitted = preserved.filter((item) => !item).length;
  return (
    <>
      <Section title="将改变的内容">
        {comparable ? (
          <FrozenRoutingComparison
            publishedIntent={current}
            candidateIntent={candidate}
            decisionReview
            labels={{ before: "当前草稿", after: "更新后" }}
          />
        ) : profile ? (
          <>
            <p>
              {review?.current.state === "unavailable" &&
              review.current.reason === "render-failed"
                ? "当前草稿无法生成分流摘要，无法逐条比较。"
                : review
                  ? "部分分流摘要未提供，无法逐条比较。"
                  : "此检查未提供逐条比较。"}
            </p>
            {candidate && (
              <div>
                <h4>更新后</h4>
                <RoutingSummaryView intent={candidate} />
              </div>
            )}
          </>
        ) : null}
        {categories.map((path) => (
          <p key={path}>
            {Object.hasOwn(changeCategoryLabels, path)
              ? changeCategoryLabels[path]
              : "其他草稿设置已更改"}
          </p>
        ))}
        {!comparable && !categories.length && (
          <p className="muted text-sm text-muted-foreground">
            未报告变更类别。
          </p>
        )}
      </Section>
      {!!preserved.length && (
        <Section title="本次更新保留的已知修改">
          <ul className="space-y-3 text-sm">
            {preserved.map(
              (item, index) =>
                item && (
                  <li key={index}>
                    <span>{item.label}</span>
                    {item.id && (
                      <details>
                        <summary>查看标识</summary>
                        <p className="mt-2 font-mono text-xs text-muted-foreground wrap-anywhere">
                          {item.id}
                        </p>
                      </details>
                    )}
                  </li>
                ),
            )}
          </ul>
          {!!omitted && <p>另有 {omitted} 项保留记录未展示。</p>}
        </Section>
      )}
    </>
  );
}
function pruneBindings(spec: Spec, bindings: SlotBindings = {}): SlotBindings {
  const keep = (
    slots: {
      id: string;
    }[] = [],
    values: Record<string, string> = {},
  ) =>
    Object.fromEntries(
      slots
        .filter((slot) => !!values[slot.id])
        .map((slot) => [slot.id, values[slot.id]]),
    );
  return {
    endpoints: keep(spec.endpointSlots, bindings.endpoints),
    resources: keep(spec.resourceSlots, bindings.resources),
  };
}
const kindLabel = (kind: Kind) =>
  kind === "processing-preset" ? "节点处理预设" : "客户端配置模板";
const modeLabel = { copy: "独立副本", pinned: "固定版本", follow: "跟随版本" };
// Own this table's lifecycle: the mine tab mounts lazily, independently of the page.
function TemplateBindingsTable(props: DataTableProps<Binding>) {
  const table = useRef<DataTableHandle>(null);
  useLayoutEffect(() => {
    const root = table.current?.nativeElement;
    const viewport = root?.querySelector<HTMLElement>(
      '[data-slot="table-container"]',
    );
    const content = viewport?.querySelector("table");
    if (!root || !viewport || !content || typeof ResizeObserver === "undefined")
      return;
    let connected = true;
    let width = viewport.clientWidth;
    let contentWidth = content.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      if (
        !connected ||
        table.current?.nativeElement !== root ||
        !root.isConnected ||
        !viewport.isConnected ||
        !root.contains(viewport) ||
        viewport.querySelector("table") !== content
      )
        return;
      const nextWidth = viewport.clientWidth;
      const nextContentWidth = content.getBoundingClientRect().width;
      if (nextWidth === width && nextContentWidth === contentWidth) return;
      width = nextWidth;
      contentWidth = nextContentWidth;
      if (width <= 0) return;
      const focused = document.activeElement;
      if (
        !(focused instanceof HTMLElement) ||
        !viewport.contains(focused) ||
        !focused.matches(".template-binding-action button")
      )
        return;
      const identity = focused
        .closest("tr")
        ?.querySelector<HTMLElement>(".template-binding-identity");
      if (!identity) return;
      const actionBounds = focused.getBoundingClientRect();
      if (actionBounds.width <= 0) return;
      const bounds = viewport.getBoundingClientRect();
      const style = window.getComputedStyle(focused);
      const outline =
        style.outlineStyle === "none" || style.outlineStyle === "hidden"
          ? 0
          : (Number.parseFloat(style.outlineWidth) || 0) +
            Math.max(0, Number.parseFloat(style.outlineOffset) || 0);
      const margin = Math.max(2, outline);
      const left =
        Math.max(bounds.left, identity.getBoundingClientRect().right) + margin;
      const right = bounds.right - margin;
      const delta =
        actionBounds.right > right
          ? actionBounds.right - right
          : actionBounds.left < left
            ? actionBounds.left - left
            : 0;
      const scrollLeft = Math.max(
        0,
        Math.min(viewport.scrollWidth - width, viewport.scrollLeft + delta),
      );
      // Preserve the active element and vertical position; move only enough to
      // keep its actual outline beside the fixed identity after a width change.
      if (scrollLeft !== viewport.scrollLeft) viewport.scrollLeft = scrollLeft;
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => {
      connected = false;
      observer.disconnect();
    };
  }, [props.rows]);
  return <DataTable<Binding> {...props} ref={table} />;
}
export function TemplatesPage({ admin = false }: { admin?: boolean }) {
  const client = useQueryClient();
  const message = toast;
  const query = useQuery({
    queryKey: ["templates"],
    queryFn: () => list<Template>("/templates"),
  });
  const bindings = useQuery({
    queryKey: ["template-bindings"],
    queryFn: () => list<Binding>("/me/template-bindings"),
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: () => list<Profile>("/me/profiles"),
  });
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => list<Collection>("/me/collections"),
  });
  const [selected, setSelected] = useState<Template | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [checking, setChecking] = useState<Binding | null>(null);
  const [preview, setPreview] = useState<UpdatePreview | null>(null);
  const [updateVersion, setUpdateVersion] = useState<number>();
  const updateVersions = useQuery({
    queryKey: ["template-versions", checking?.templateId],
    queryFn: () =>
      list<Template>(`/templates/${checking!.templateId}/versions`),
    enabled: !!checking,
  });
  const [updateBindings, setUpdateBindings] = useState<SlotBindings>({});
  const currentProfile = profiles.data?.find(
    (p) => p.id === checking?.targetId,
  );
  const effectiveVersion =
    updateVersion ??
    (checking?.mode === "pinned"
      ? checking.appliedVersion
      : query.data?.find((t) => t.id === checking?.templateId)?.version);
  const updateSpec = (
    updateVersions.data?.find((t) => t.version === effectiveVersion) ||
    query.data?.find(
      (t) => t.id === checking?.templateId && t.version === effectiveVersion,
    )
  )?.spec;
  const updateEndpoints = useTemplateEndpoints(
    currentProfile,
    !!checking && !!updateSpec?.endpointSlots?.length && catalogReady(profiles),
  );
  const availableEndpoints = catalogReady(profiles) && catalogReady(updateEndpoints)
    ? updateEndpoints.data || []
    : [];
  const [reviewInput, setReviewInput] = useState<{
    version: number;
    bindings: SlotBindings;
  } | null>(null);
  const [updateError, setUpdateError] = useState<Error | null>(null);
  const revision = useRef(0);
  const applying = useRef<number | null>(null);
  const active = useRef(true);
  const [updateEdited, setUpdateEdited] = useState(false);
  const { confirm: confirmUpdateDiscard, confirming: updateConfirming } =
    useDiscardConfirmation(checking?.id || "closed-template-update");
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      revision.current++;
    };
  }, []);
  const inspect = useMutation({
    mutationFn: async ({
      binding,
      slots,
      requestedVersion,
      revisionAtRequest,
    }: {
      binding: Binding;
      slots?: SlotBindings;
      requestedVersion?: number;
      revisionAtRequest: number;
    }) => {
      const versions = await client.fetchQuery({
        queryKey: ["template-versions", binding.templateId],
        queryFn: () =>
          list<Template>(`/templates/${binding.templateId}/versions`),
      });
      const targetVersion =
        requestedVersion ??
        (binding.mode === "pinned"
          ? binding.appliedVersion
          : Math.max(...versions.map((t) => t.version)));
      const target = versions.find((t) => t.version === targetVersion);
      if (!target) throw new Error("所选模板版本不可用，请重新选择。");
      const input = {
        version: targetVersion,
        bindings: pruneBindings(target.spec, slots ?? binding.bindings),
      };
      return {
        value: await post<UpdatePreview>(
          `/me/template-bindings/${binding.id}/preview`,
          input,
        ),
        revisionAtRequest,
        input,
      };
    },
    onSuccess: ({ value, revisionAtRequest, input }) => {
      if (!active.current || revisionAtRequest !== revision.current) return;
      setUpdateVersion(input.version);
      setUpdateBindings(input.bindings);
      setReviewInput(input);
      setPreview(value);
    },
    onError: (failure, request) => {
      if (active.current && request.revisionAtRequest === revision.current)
        setUpdateError(failure);
    },
  });
  const apply = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: (_value, _failure, submission) => {
      if (applying.current === submission.revision) applying.current = null;
      invalidateOutputInputs(client);
    },
    mutationFn: (submission: {
      bindingId: string;
      revision: number;
      input: {
        previewDigest: string;
        version: number;
        bindings: SlotBindings;
      };
    }) =>
      post(
        `/me/template-bindings/${submission.bindingId}/apply`,
        submission.input,
      ),
    onSuccess: (_value, submission) => {
      client.invalidateQueries();
      if (!active.current || submission.revision !== revision.current) return;
      revision.current++;
      setChecking(null);
      setPreview(null);
      setUpdateEdited(false);
      message.success("更新已应用到草稿，已发布订阅保留原版本");
    },
    onError: (failure, submission) => {
      if (!active.current || submission.revision !== revision.current) return;
      const conflict = failure instanceof APIError && failure.status === 409;
      setUpdateError(
        conflict &&
          failure.message ===
          "template or personal configuration changed; preview again before applying"
          ? new Error(
              "模板或草稿已变化，本次更新未应用。请重新检查后再应用。",
            )
          : failure,
      );
      if (conflict) {
        revision.current++;
        setPreview(null);
        setReviewInput(null);
      }
    },
  });
  const inspectUpdate = (
    binding: Binding,
    slots?: SlotBindings,
    requestedVersion?: number,
  ) => {
    if (!active.current || applying.current !== null || updateConfirming) return;
    revision.current++;
    setPreview(null);
    setReviewInput(null);
    setUpdateError(null);
    inspect.mutate({
      binding,
      slots,
      requestedVersion,
      revisionAtRequest: revision.current,
    });
  };
  const editUpdate = () => {
    revision.current++;
    setUpdateEdited(true);
    setPreview(null);
    setReviewInput(null);
    setUpdateError(null);
  };
  useUnsavedChanges(!!checking && (updateEdited || apply.isPending));
  const closeUpdate = () => {
    if (applying.current !== null || apply.isPending || updateConfirming) return;
    const close = () => {
      revision.current++;
      setChecking(null);
      setUpdateEdited(false);
    };
    if (!updateEdited) return close();
    confirmUpdateDiscard(
      {
        title: "放弃未应用的模板更新选择？",
        description: "当前版本与绑定选择尚未应用到草稿。",
        confirmLabel: "放弃选择",
        cancelLabel: "继续编辑",
      },
      close,
    );
  };
  const targetName = (b: Binding) =>
    (b.targetKind === "collections" ? collections.data : profiles.data)?.find(
      (p) => p.id === b.targetId,
    )?.name || b.targetId;
  const catalogTabs = [
    {
      key: "library",
      label: "模板库",
      children: (
        <QueryState
          loading={query.isPending}
          paused={query.isPaused}
          loadingLayout="cards"
          error={query.error}
          retry={() => query.refetch()}
        >
          {!query.data?.length ? (
            <Section>
              <EmptyState
                title="暂无可用模板"
                description="管理员发布后可用。"
              />
            </Section>
          ) : (
            <div className="card-grid grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {query.data.map((t) => (
                <article
                  className="surface profile-card template-library-card flex flex-col gap-3 rounded-xl border bg-card p-5"
                  key={t.id}
                >
                  <div className="profile-card-top flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <BookOpen
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <h2 className="text-base font-semibold tracking-tight wrap-anywhere">
                        {t.name}
                      </h2>
                    </div>
                    <Badge variant="secondary">v{t.version}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <span>{kindLabel(t.kind)}</span>
                    {t.kind === "processing-preset" ? (
                      <span>{t.spec.steps?.length || 0} 个步骤</span>
                    ) : (
                      <>
                        <span>{t.spec.groups?.length || 0} 个策略组</span>
                        <span>{t.spec.rules?.length || 0} 条规则</span>
                      </>
                    )}
                  </div>
                  <footer className="template-library-footer mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                    <div className="profile-meta flex flex-wrap gap-2 text-sm text-muted-foreground">
                      发布于 {dateLabel(t.publishedAt)}
                    </div>
                    <ActionButton
                      onClick={() => setSelected(t)}
                      variant="default"
                    >
                      查看并使用
                    </ActionButton>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </QueryState>
      ),
    },
    {
      key: "mine",
      label: "我的引用",
      children: (
        <QueryState
          loading={bindings.isPending}
          paused={bindings.isPaused}
          loadingLayout="table"
          error={bindings.error}
          retry={() => bindings.refetch()}
        >
          <Section variant="plain">
            {!bindings.data?.length ? (
              <EmptyState
                title="暂无模板引用"
                description="从模板库选择模板并应用。"
              />
            ) : (
              <TemplateBindingsTable
                className="template-bindings-table w-full"
                rowKey="id"
                rows={bindings.data}
                minWidth={650}
                columns={[
                  {
                    title: "配置或集合",
                    width: 104,

                    className: "template-binding-identity",
                    render: (_, b) => (
                      <span className="template-binding-name block wrap-anywhere">
                        {targetName(b)}
                      </span>
                    ),
                  },
                  {
                    title: "模板",
                    width: 206,
                    render: (_, b) => (
                      <span className="template-binding-name block wrap-anywhere">
                        {query.data?.find((t) => t.id === b.templateId)?.name ||
                          b.templateId}
                      </span>
                    ),
                  },
                  {
                    title: "方式",
                    width: 104,
                    render: (_, b) => (
                      <Badge variant="secondary">{modeLabel[b.mode]}</Badge>
                    ),
                  },
                  {
                    title: "当前版本",
                    width: 92,
                    render: (_, b) => `v${b.appliedVersion}`,
                  },
                  {
                    title: "操作",
                    align: "right",
                    width: 144,
                    className: "template-binding-action",
                    render: (_, b) =>
                      b.mode === "copy" ? (
                        <span className="muted text-sm text-muted-foreground">
                          独立维护
                        </span>
                      ) : (
                        <ActionButton
                          aria-label={`${b.mode === "follow" ? "检查更新" : "查看固定版本"} ${targetName(b)}`}
                          leadingIcon={<RotateCw aria-hidden="true" />}
                          onClick={() => {
                            setChecking(b);
                            setUpdateEdited(false);
                            setUpdateVersion(undefined);
                            setUpdateBindings(b.bindings || {});
                            inspect.reset();
                            apply.reset();
                            inspectUpdate(b, b.bindings);
                          }}
                          variant="outline"
                          size="sm"
                        >
                          {b.mode === "follow" ? "检查更新" : "查看固定版本"}
                        </ActionButton>
                      ),
                  },
                ]}
              />
            )}
          </Section>
        </QueryState>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="模板与预设"
        action={
          admin ? (
            <ActionButton
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => setPublishing(true)}
              variant="outline"
            >
              发布模板
            </ActionButton>
          ) : undefined
        }
      />
      <Tabs defaultValue={String(catalogTabs[0]?.key ?? "")}>
        {
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            {catalogTabs.map((section) => (
              <TabsTrigger
                key={section.key}
                value={String(section.key)}
                disabled={"disabled" in section && !!section.disabled}
              >
                {section.label}
              </TabsTrigger>
            ))}
          </TabsList>
        }
        {catalogTabs.map((section) => (
          <TabsContent
            className="mt-5"
            key={section.key}
            value={String(section.key)}
          >
            {section.children}
          </TabsContent>
        ))}
      </Tabs>
      {selected && (
        <SelectTemplate
          key={selected.id}
          template={selected}
          profiles={profiles}
          collections={collections}
          onClose={() => setSelected(null)}
        />
      )}
      {publishing && (
        <PublishTemplate
          templates={query.data || []}
          profiles={profiles.data || []}
          collections={collections.data || []}
          onClose={() => setPublishing(false)}
        />
      )}
      <TaskSheet
        title={checking ? `模板更新 ${targetName(checking)}` : "模板更新"}
        open={!!checking}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeUpdate();
        }}
        pending={apply.isPending}
        contentProps={{
          onKeyDownCapture: (event) => {
            if (
              event.repeat &&
              (event.key === "Enter" || event.key === " ") &&
              event.target instanceof HTMLElement &&
              event.target.closest("button")
            )
              event.preventDefault();
          },
        }}
        size="lg"
      >
        <ErrorNotice
          error={
            updateError ||
            updateVersions.error ||
            profiles.error ||
            updateEndpoints.error
          }
        />
        <div className="space-y-5" inert={apply.isPending || updateConfirming}>
          {checking?.mode === "pinned" && (
            <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
              检查的模板版本
              <ChoiceSelect
                value={effectiveVersion}
                options={(updateVersions.data || []).map((t) => ({
                  value: t.version,
                  label: (
                    <Metadata className="flex-col items-start">
                      <span>v{t.version}</span>
                      {t.version === checking.appliedVersion && (
                        <span className="text-muted-foreground">当前固定</span>
                      )}
                    </Metadata>
                  ),
                }))}
                onValueChange={(value) => {
                  if (value === undefined) return;
                  editUpdate();
                  setUpdateVersion(value);
                  const spec = updateVersions.data?.find(
                    (t) => t.version === value,
                  )?.spec;
                  if (spec)
                    setUpdateBindings(pruneBindings(spec, updateBindings));
                }}
              />
            </label>
          )}
          {checking && checking.targetKind === "profiles" && (
            <div className="space-y-5">
              {!!updateSpec?.endpointSlots?.length && (
                <TemplateCatalogNotice<{ id: string; name: string }> query={catalogReady(profiles) ? updateEndpoints : profiles} label="可用连接列表" />
              )}
              {updateSpec?.endpointSlots?.map((slot) => (
                <label
                  className="standalone-label grid min-w-0 gap-2 text-sm font-medium"
                  key={slot.id}
                >
                  {slot.name}
                  <ChoiceSelect
                    clearable
                    value={updateBindings.endpoints?.[slot.id]}
                    placeholder="为模板选择自己的连接"
                    disabled={!catalogReady(profiles) || !catalogReady(updateEndpoints)}
                    options={availableEndpoints.map((e) => ({
                      value: e.id,
                      label: e.name,
                    }))}
                    onValueChange={(value) => {
                      editUpdate();
                      const next = { ...updateBindings.endpoints };
                      if (value === undefined) delete next[slot.id];
                      else next[slot.id] = value;
                      setUpdateBindings({ ...updateBindings, endpoints: next });
                    }}
                  />
                </label>
              ))}
              {updateSpec?.resourceSlots?.map((slot) => (
                <label
                  className="standalone-label grid min-w-0 gap-2 text-sm font-medium"
                  key={slot.id}
                >
                  {slot.name}
                  <ChoiceSelect
                    clearable
                    value={updateBindings.resources?.[slot.id]}
                    options={(currentProfile?.ir.resources || []).map((r) => ({
                      value: r.id,
                      label: r.name || r.id,
                    }))}
                    onValueChange={(value) => {
                      editUpdate();
                      const next = { ...updateBindings.resources };
                      if (value === undefined) delete next[slot.id];
                      else next[slot.id] = value;
                      setUpdateBindings({ ...updateBindings, resources: next });
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          {checking && (
            <ActionButton
              onClick={(event) => {
                if (event.detail <= 1 && !inspect.isPending)
                  inspectUpdate(checking, updateBindings, updateVersion);
              }}
              variant="outline"
              pending={!!inspect.isPending}
              disabled={apply.isPending || updateConfirming}
            >
              检查此绑定的更新
            </ActionButton>
          )}
        </div>
        <QueryState loading={inspect.isPending} error={null} retry={() => {}}>
          {preview && (
            <section aria-label="模板更新检查结果" className="mt-6 space-y-6">
              <Notice
                tone={
                  !preview.compatible
                    ? "warning"
                    : preview.hasUpdate
                      ? "info"
                      : "success"
                }
                title={
                  !preview.compatible
                    ? "此更新需要先解决兼容问题"
                    : preview.hasUpdate
                      ? `可以更新到 v${preview.candidateVersion}`
                      : "当前引用无需更新"
                }
              >
                {"更新只修改草稿。检查配置后再单独发布订阅。"}
              </Notice>
              {preview.diagnostics.length > 0 && (
                <ul
                  aria-label="检查提示"
                  className="list-disc space-y-2 pl-5 text-sm leading-relaxed wrap-anywhere"
                >
                  {preview.diagnostics.map((diagnostic, index) => (
                    <li key={index}>{diagnostic}</li>
                  ))}
                </ul>
              )}
              <TemplateUpdateChanges
                preview={preview}
                profile={checking?.targetKind === "profiles"}
              />
              <Accordion type="multiple">
                {[
                  {
                    key: "result",
                    label: "查看生成结果",
                    children: preview.artifacts?.map((a) => (
                      <div key={a.path}>
                        <h4>{a.path}</h4>
                        <CodePreview content={redact(a.content)} />
                      </div>
                    )),
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
              <div className="form-footer mt-6 flex flex-wrap items-center justify-end gap-2">
                <ActionButton
                  disabled={apply.isPending || updateConfirming}
                  onClick={closeUpdate}
                  variant="outline"
                >
                  关闭
                </ActionButton>
                <ActionButton
                  disabled={
                    !preview.compatible ||
                    !preview.hasUpdate ||
                    !preview.previewDigest
                  }
                  onClick={(event) => {
                    if (
                      event.detail > 1 ||
                      !active.current ||
                      applying.current !== null ||
                      !checking ||
                      !reviewInput ||
                      !preview.previewDigest ||
                      apply.isPending ||
                      updateConfirming
                    )
                      return;
                    applying.current = revision.current;
                    apply.mutate({
                      bindingId: checking.id,
                      revision: revision.current,
                      input: structuredClone({
                        previewDigest: preview.previewDigest,
                        ...reviewInput,
                      }),
                    });
                  }}
                  variant="default"
                  pending={!!apply.isPending}
                >
                  应用到草稿
                </ActionButton>
              </div>
            </section>
          )}
        </QueryState>
      </TaskSheet>
    </>
  );
}
type TemplateCatalog<T> = Pick<
  UseQueryResult<T[], Error>,
  "data" | "isPending" | "isFetching" | "isPaused" | "error" | "refetch"
>;
function catalogReady<T>(query: TemplateCatalog<T>) {
  return (
    !!query.data &&
    !query.isPending &&
    !query.isFetching &&
    !query.isPaused &&
    !query.error
  );
}
function TemplateCatalogNotice<T>({
  query,
  label,
}: {
  query: TemplateCatalog<T>;
  label: string;
}) {
  if (catalogReady(query)) return null;
  const object = label.replace(/列表$/, "");
  return (
    <div>
      {query.isPaused ? (
        <p role="status">{label}读取已暂停，恢复网络后重试。</p>
      ) : query.isFetching || (query.isPending && !query.error) ? (
        <p role="status">正在读取{label}…</p>
      ) : (
        <div role="status" className={"flex flex-wrap items-center gap-2"}>
          <span>暂时无法加载{object}</span>
          <ActionButton onClick={() => void query.refetch()} variant="link">
            重新加载{object}
          </ActionButton>
        </div>
      )}
      {!query.isFetching && query.isPaused && (
        <ActionButton onClick={() => void query.refetch()} variant="outline">
          重试读取{label}
        </ActionButton>
      )}
    </div>
  );
}
// Match materializeProfileWithReader: collection replaces sources and inline
// endpoints; source processing replaces inline endpoints; grants are resolved
// separately. Raw snapshots and embedded platform endpoints are not authority.
function endpointChoices(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) throw new Error("无法读取可用连接，请重试");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() ||
        typeof entry.name !== "string" || !entry.name.trim() || ids.has(entry.id))
      throw new Error("无法读取可用连接，请重试");
    ids.add(entry.id);
    return { id: entry.id, name: entry.name };
  });
}
function useTemplateEndpoints(profile: Profile | undefined, enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" ||
        !["sources", "collections", "platform-entries"].includes(String(event.query.queryKey[0]))) return;
    if (event.action.type === "invalidate" || event.action.type === "success")
      void client.invalidateQueries({ queryKey: ["template-endpoints"] });
  }), [client]);
  return useQuery({
    queryKey: ["template-endpoints", profile],
    enabled: enabled && !!profile,
    select: endpointChoices,
    queryFn: async () => {
      if (!profile) throw new Error("请选择客户端配置");
      let endpoints: { id: string; name: string }[];
      if (profile.collectionId || profile.sourceIds?.length) {
        const result = await post<{ endpoints: { id: string; name: string }[] }>(
          profile.collectionId
            ? `/me/collections/${encodeURIComponent(profile.collectionId)}/preview`
            : "/me/collections/preview",
          profile.collectionId
            ? {}
            : {
                id: "profile-sources",
                name: "Profile sources",
                sources: profile.sourceIds!.map((sourceId) => ({ sourceId })),
              },
        );
        if (!Array.isArray(result.endpoints))
          throw new Error("无法读取处理后的连接，请重试");
        if (result.endpoints.some((endpoint) =>
          !endpoint || (endpoint as { origin?: unknown }).origin !== "imported"))
          throw new Error("无法读取处理后的连接，请重试");
        endpoints = endpointChoices(result.endpoints);
      } else {
        const local = profile.ir.endpoints || [];
        if (local.some((endpoint) =>
          endpoint.origin !== "imported" &&
          !(endpoint.origin === "platform-entry" && profile.platformEntryIds?.includes(endpoint.id))))
          throw new Error("配置中的连接类型不可用");
        endpoints = endpointChoices(local.filter((endpoint) => endpoint.origin === "imported"));
      }
      if (profile.platformEntryIds?.length) {
        const entries = endpointChoices(await list<PlatformEntry>("/me/platform-entries"));
        const granted = profile.platformEntryIds.map((id) => {
          const entry = entries.find((item) => item.id === id);
          if (!entry) throw new Error("配置中的平台连接已不可用");
          return entry;
        });
        endpoints = [...endpoints, ...granted];
      }
      return endpointChoices(endpoints);
    },
  });
}
function SelectTemplate({
  template,
  profiles,
  collections,
  onClose,
}: {
  template: Template;
  profiles: TemplateCatalog<Profile>;
  collections: TemplateCatalog<Collection>;
  onClose: () => void;
}) {
  const [version, setVersion] = useState<number>(template.version);
  const [targetId, setTargetId] = useState<string>();
  const [selectedNames, setSelectedNames] = useState<Record<string, string>>(
    {},
  );
  const [mode, setMode] = useState<Binding["mode"]>("copy");
  const [endpointBindings, setEndpointBindings] = useState<
    Record<string, string>
  >({});
  const [resourceBindings, setResourceBindings] = useState<
    Record<string, string>
  >({});
  const message = toast;
  const client = useQueryClient();
  const [open, setOpen] = useState(true);
  const submitting = useRef(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { confirm, confirming } = useDiscardConfirmation(template.id);
  const versions = useQuery({
    queryKey: ["template-versions", template?.id],
    queryFn: () => list<Template>(`/templates/${template!.id}/versions`),
    enabled: !!template,
  });
  const chosen = versions.data?.find(
    (t) => t.version === (version ?? template?.version),
  );
  const targets: TemplateCatalog<Profile | Collection> =
    template?.kind === "processing-preset" ? collections : profiles;
  const target =
    template?.kind === "client-profile"
      ? profiles.data?.find((p) => p.id === targetId)
      : undefined;
  const hasEndpointSlots =
    template?.kind === "client-profile" && !!chosen?.spec.endpointSlots?.length;
  const endpointCatalog = useTemplateEndpoints(
    target,
    hasEndpointSlots && catalogReady(profiles),
  );
  const endpoints = catalogReady(profiles) && catalogReady(endpointCatalog)
    ? endpointCatalog.data || []
    : [];
  const candidatesUnresolved =
    !catalogReady(profiles) || !catalogReady(endpointCatalog);
  const missingTarget =
    !!targetId &&
    catalogReady(targets) &&
    !targets.data?.some((t) => t.id === targetId);
  const missingVersion = catalogReady(versions) && !chosen;
  const resources = target?.ir.resources || [];
  const unavailableOptions = (
    value: string | undefined,
    available: {
      id: string;
    }[],
    unresolved = false,
    name?: string,
  ) =>
    value && !available.some((item) => item.id === value)
      ? [
          {
            value,
            label: (
              <Metadata className="flex-col items-start">
                <span>{name || value}</span>
                <span className="text-muted-foreground">
                  {unresolved ? "暂不可用" : "已不可用"}
                </span>
              </Metadata>
            ),
            disabled: true,
          },
        ]
      : [];
  const select = useMutation({
    onMutate: () => invalidateOutputInputs(client),
    onSettled: () => {
      submitting.current = false;
      invalidateOutputInputs(client);
    },
    mutationFn: (submission: {
      templateId: string;
      input: {
        version: number;
        mode: Binding["mode"];
        targetId: string;
        target: Profile["target"] | undefined;
        bindings: SlotBindings;
      };
    }) =>
      post(`/me/templates/${submission.templateId}/select`, submission.input),
    onSuccess: () => {
      client.invalidateQueries();
      if (!active.current) return;
      setOpen(false);
      message.success("模板已用于草稿，已发布订阅保留原版本");
    },
  });
  const complete =
    !!targetId &&
    catalogReady(targets) &&
    !missingTarget &&
    catalogReady(versions) &&
    !!chosen &&
    (chosen.spec.endpointSlots || []).every((s) =>
      endpoints.some((e) => e.id === endpointBindings[s.id]),
    ) &&
    (chosen.spec.resourceSlots || []).every((s) =>
      resources.some((r) => r.id === resourceBindings[s.id]),
    );
  const dirty =
    !!targetId ||
    mode !== "copy" ||
    version !== template.version ||
    Object.keys(endpointBindings).length > 0 ||
    Object.keys(resourceBindings).length > 0;
  useUnsavedChanges(open && (dirty || select.isPending));
  const close = () => {
    if (!open || submitting.current || select.isPending || confirming) return;
    if (!dirty) return setOpen(false);
    confirm(
      {
        title: "放弃未应用的模板选择？",
        description: "当前选择尚未应用到草稿。",
        confirmLabel: "放弃选择",
        cancelLabel: "继续编辑",
        contentProps: { onFocusCapture: revealFocusedModalAction },
      },
      () => setOpen(false),
    );
  };
  return (
    <TaskDialog
      title={template?.name || "使用模板"}
      open={open}
      footer={null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      pending={select.isPending}
      onClosed={() => {
        if (active.current) onClose();
      }}
      size="lg"
    >
      <ErrorNotice error={select.error} />
      <>
        <div className="space-y-5">
          <TemplateCatalogNotice query={versions} label="模板版本" />
          {missingVersion && (
            <ErrorNotice
              error={new Error("所选模板版本已不可用，请重新选择。")}
            />
          )}
          <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
            模板版本
            <ChoiceSelect
              aria-label="模板版本"
              value={version}
              options={[
                ...(versions.data || []).map((v) => ({
                  value: v.version,
                  label: (
                    <Metadata className="flex-col items-start">
                      <span>v{v.version}</span>
                      <span className="text-muted-foreground">
                        {dateLabel(v.publishedAt)}
                      </span>
                    </Metadata>
                  ),
                })),
                ...(version &&
                !versions.data?.some((v) => v.version === version)
                  ? [
                      {
                        value: version,
                        label: (
                          <Metadata className="flex-col items-start">
                            <span>v{version}</span>
                            <span className="text-muted-foreground">
                              {catalogReady(versions) ? "已不可用" : "暂不可用"}
                            </span>
                          </Metadata>
                        ),
                        disabled: true,
                      },
                    ]
                  : []),
              ]}
              onValueChange={(v) => {
                if (v === undefined) return;
                setVersion(v);
                setEndpointBindings({});
                setResourceBindings({});
              }}
              disabled={select.isPending || !open}
            />
          </label>
          <Accordion type="multiple">
            {[
              {
                key: "spec",
                label: "查看模板结构",
                children: (
                  <CodePreview
                    tabIndex={select.isPending || !open ? -1 : 0}
                    content={JSON.stringify(chosen?.spec, null, 2)}
                  />
                ),
              },
            ].map((section) => (
              <AccordionItem
                key={section.key}
                value={String(section.key)}
                disabled={
                  (select.isPending || !open ? "disabled" : undefined) ===
                    "disabled" ||
                  ("collapsible" in section &&
                    section.collapsible === "disabled")
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
          <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
            应用到
            {template?.kind === "processing-preset" ? "节点集合" : "客户端配置"}
            <ChoiceSelect
              aria-label="模板目标"
              value={targetId}
              placeholder="选择已有草稿"
              options={[
                ...(targets.data || []).map((t) => ({
                  value: t.id,
                  label: t.name,
                })),
                ...unavailableOptions(
                  targetId,
                  targets.data || [],
                  !catalogReady(targets),
                  selectedNames.target,
                ),
              ]}
              onValueChange={(v) => {
                if (v === undefined) return;
                setTargetId(v);
                setSelectedNames({
                  target: targets.data?.find((t) => t.id === v)?.name || v,
                });
                setEndpointBindings({});
                setResourceBindings({});
              }}
              disabled={select.isPending || !open}
            />
          </label>
          <TemplateCatalogNotice
            query={targets}
            label={
              template?.kind === "processing-preset"
                ? "节点集合列表"
                : "客户端配置列表"
            }
          />
          {missingTarget && (
            <ErrorNotice error={new Error("所选草稿已不可用，请重新选择。")} />
          )}
          {catalogReady(targets) && !targets.data?.length && (
            <p role="status">
              暂无可用草稿，请先创建
              {template?.kind === "processing-preset"
                ? "节点集合"
                : "客户端配置"}
              。
            </p>
          )}
          <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
            引用方式
            <RadioGroup
              className="grid gap-2 sm:grid-cols-3"
              value={mode}
              onValueChange={(value) => {
                if (
                  value === "copy" ||
                  value === "follow" ||
                  value === "pinned"
                )
                  setMode(value);
              }}
              disabled={select.isPending || !open}
            >
              {[
                { value: "copy", label: "独立副本" },
                { value: "pinned", label: "固定此版本" },
                { value: "follow", label: "跟随版本" },
              ].map((option) => (
                <Label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
                >
                  <RadioGroupItem
                    value={String(option.value)}
                    disabled={"disabled" in option && !!option.disabled}
                  />
                  {option.label}
                </Label>
              ))}
            </RadioGroup>
          </label>
          <p className="muted text-sm text-muted-foreground">
            {mode === "copy"
              ? "创建独立副本，后续由你单独维护。"
              : mode === "pinned"
                ? "固定使用所选版本，后续由你决定是否更换版本。"
                : "有新版本时先查看差异与兼容性，再决定是否更新。"}
          </p>
          {hasEndpointSlots && target && (
            <TemplateCatalogNotice query={endpointCatalog} label="可用连接列表" />
          )}
          {chosen?.spec.endpointSlots?.map((slot) => (
            <label
              key={slot.id}
              className="standalone-label grid min-w-0 gap-2 text-sm font-medium"
            >
              {slot.name}
              <ChoiceSelect
                aria-label={slot.name}
                value={endpointBindings[slot.id]}
                placeholder="绑定你自己的连接"
                options={[
                  ...endpoints.map((e) => ({ value: e.id, label: e.name })),
                  ...unavailableOptions(
                    endpointBindings[slot.id],
                    endpoints,
                    candidatesUnresolved,
                    selectedNames[`endpoint:${slot.id}`],
                  ),
                ]}
                onValueChange={(value) => {
                  if (value === undefined) return;
                  setEndpointBindings({
                    ...endpointBindings,
                    [slot.id]: value,
                  });
                  setSelectedNames({
                    ...selectedNames,
                    [`endpoint:${slot.id}`]:
                      endpoints.find((e) => e.id === value)?.name || value,
                  });
                }}
                disabled={select.isPending || !open}
              />
            </label>
          ))}
          {chosen?.spec.resourceSlots?.map((slot) => (
            <label
              key={slot.id}
              className="standalone-label grid min-w-0 gap-2 text-sm font-medium"
            >
              {slot.name}
              <ChoiceSelect
                aria-label={slot.name}
                value={resourceBindings[slot.id]}
                placeholder="绑定配置中引用的规则文件"
                options={[
                  ...resources.map((r) => ({
                    value: r.id,
                    label: r.name || r.id,
                  })),
                  ...unavailableOptions(
                    resourceBindings[slot.id],
                    resources,
                    !catalogReady(profiles),
                    selectedNames[`resource:${slot.id}`],
                  ),
                ]}
                onValueChange={(value) => {
                  if (value === undefined) return;
                  setResourceBindings({
                    ...resourceBindings,
                    [slot.id]: value,
                  });
                  setSelectedNames({
                    ...selectedNames,
                    [`resource:${slot.id}`]:
                      resources.find((r) => r.id === value)?.name || value,
                  });
                }}
                disabled={select.isPending || !open}
              />
            </label>
          ))}
          <Notice tone="info" title="只更新选中的草稿">
            {
              "保留来源与凭据。首次选择或更换另一模板会采用它的结构与默认设置；同一模板的版本更新会保留可合并的本地修改。发布订阅仍需单独确认。"
            }
          </Notice>
        </div>
      </>
      <div className="form-footer mt-6 flex flex-wrap items-center justify-end gap-2">
        <ActionButton
          disabled={select.isPending || !open}
          onClick={close}
          variant="outline"
        >
          取消
        </ActionButton>
        <ActionButton
          ref={submitButton}
          disabled={!open || (!select.isPending && !complete)}
          aria-label="应用模板到草稿"
          aria-busy={select.isPending}
          onClick={() => {
            if (
              !active.current ||
              !open ||
              submitting.current ||
              !complete ||
              select.isPending ||
              confirming
            )
              return;
            submitting.current = true;
            const submit = submitButton.current;
            const dialog = submit?.closest('[role="dialog"]');
            if (submit && dialog?.contains(document.activeElement))
              submit.focus();
            select.mutate({
              templateId: template.id,
              input: {
                version: chosen!.version,
                mode,
                targetId: targetId!,
                target: target?.target,
                bindings: structuredClone({
                  endpoints: endpointBindings,
                  resources: resourceBindings,
                }),
              },
            });
          }}
          variant="default"
          pending={!!select.isPending}
        >
          应用模板到草稿
        </ActionButton>
      </div>
    </TaskDialog>
  );
}
function PublishTemplate({
  templates,
  profiles,
  collections,
  onClose,
}: {
  templates: Template[];
  profiles: Profile[];
  collections: Collection[];
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>("processing-preset");
  const [existing, setExisting] = useState<string>();
  const [targetId, setTargetId] = useState<string>();
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const revision = useRef(0);
  const extracting = useRef<number | null>(null);
  const [extractionError, setExtractionError] = useState<Error | null>(null);
  const [open, setOpen] = useState(true);
  const submitting = useRef(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      revision.current++;
    };
  }, []);
  const { confirm, confirming } = useDiscardConfirmation("publish-template");
  const client = useQueryClient();
  const message = toast;
  const selected = templates.find((t) => t.id === existing);
  const sanitize = useMutation({
    mutationFn: async ({ version, kind, targetId }: {
      version: number;
      kind: Kind;
      targetId: string;
    }) => {
      return {
        value: await post<{
          spec: Spec;
        }>("/admin/templates/sanitize", {
          kind,
          targetId,
        }),
        version,
      };
    },
    onSuccess: ({ value, version }) => {
      if (!active.current || version !== revision.current || extracting.current !== version) return;
      setSpec(JSON.stringify(value.spec, null, 2));
      setReviewed(false);
    },
    onError: (error, { version }) => {
      if (!active.current || version !== revision.current || extracting.current !== version) return;
      setExtractionError(error);
    },
    onSettled: (_value, _error, { version }) => {
      if (extracting.current === version) extracting.current = null;
    },
  });
  const publish = useMutation({
    onSettled: () => {
      submitting.current = false;
    },
    mutationFn: (submission: {
      id: string;
      name: string;
      kind: Kind;
      expectedVersion: number;
      spec: string;
    }) => {
      let parsed;
      try {
        parsed = JSON.parse(submission.spec);
      } catch {
        throw new Error("模板结构不是有效的 JSON，请先修正。");
      }
      return post("/admin/templates", {
        ...submission,
        spec: parsed,
      });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["templates"] });
      if (!active.current) return;
      message.success("模板新版本已发布");
      setOpen(false);
    },
  });
  const dirty =
    !!existing ||
    !!targetId ||
    name !== "" ||
    spec !== "" ||
    kind !== "processing-preset";
  useUnsavedChanges(open && (dirty || publish.isPending));
  const close = () => {
    if (!open || submitting.current || publish.isPending || confirming) return;
    if (!dirty) return setOpen(false);
    confirm(
      {
        title: "放弃未发布的模板修改？",
        description: "当前模板修改尚未发布。",
        confirmLabel: "放弃修改",
        cancelLabel: "继续编辑",
        contentProps: { onFocusCapture: revealFocusedModalAction },
      },
      () => setOpen(false),
    );
  };
  return (
    <TaskDialog
      title="发布共享模板"
      open={open}
      footer={null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      pending={publish.isPending}
      onClosed={() => {
        if (active.current) onClose();
      }}
      size="lg"
    >
      <ErrorNotice error={error || extractionError || publish.error} />
      <>
        <div className="space-y-5">
          <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
            发布位置
            <ChoiceSelect
              aria-label="发布位置"
              value={existing}
              clearable
              placeholder="创建新模板"
              options={templates.map((t) => ({
                value: t.id,
                label: (
                  <Metadata className="flex-col items-start">
                    <span>{t.name}</span>
                    <span className="text-muted-foreground">v{t.version}</span>
                  </Metadata>
                ),
              }))}
              onValueChange={(id) => {
                if (submitting.current) return;
                revision.current++;
                setExtractionError(null);
                setExisting(id);
                const t = templates.find((t) => t.id === id);
                setKind(t?.kind || "processing-preset");
                setName(t?.name || "");
                setTargetId(undefined);
                setSpec("");
                setReviewed(false);
              }}
              disabled={publish.isPending || !open}
            />
          </label>
          <div className="form-grid grid gap-4 sm:grid-cols-2 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
            <label>
              模板名称
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={publish.isPending || !open}
              />
            </label>
            <label>
              模板类型
              <ChoiceSelect
                aria-label="模板类型"
                disabled={!!selected || publish.isPending || !open}
                value={kind}
                options={[
                  { value: "processing-preset", label: "节点处理预设" },
                  { value: "client-profile", label: "客户端配置模板" },
                ]}
                onValueChange={(value) => {
                  if (value === undefined || submitting.current) return;
                  revision.current++;
                  setExtractionError(null);
                  setKind(value);
                  setTargetId(undefined);
                  setSpec("");
                  setReviewed(false);
                }}
              />
            </label>
          </div>
          <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
            从自己的已保存配置提取
            <ChoiceSelect
              aria-label="从自己的已保存配置提取"
              value={targetId}
              options={(kind === "processing-preset"
                ? collections
                : profiles
              ).map((t) => ({ value: t.id, label: t.name }))}
              onValueChange={(v) => {
                if (v === undefined || submitting.current) return;
                revision.current++;
                setExtractionError(null);
                setTargetId(v);
                setSpec("");
                setReviewed(false);
              }}
              disabled={publish.isPending || !open}
            />
          </label>
          <ActionButton
            disabled={!targetId || publish.isPending || !open}
            onClick={() => {
              if (!active.current || !open || submitting.current || extracting.current !== null || !targetId) return;
              const version = ++revision.current;
              extracting.current = version;
              setExtractionError(null);
              setReviewed(false);
              sanitize.mutate({ version, kind, targetId });
            }}
            variant="outline"
            pending={!!sanitize.isPending}
          >
            提取可共享结构
          </ActionButton>
          {spec && (
            <>
              <p className="muted text-sm text-muted-foreground">
                连接和资源地址已替换成绑定位置。请检查名称、规则和 DNS
                地址，不要公开私人信息。
              </p>
              <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                共享结构
                <Textarea
                  rows={14}
                  className="json-editor min-h-48 font-mono text-xs"
                  value={spec}
                  onChange={(e) => {
                    if (submitting.current) return;
                    revision.current++;
                    setExtractionError(null);
                    setSpec(e.target.value);
                    setReviewed(false);
                  }}
                  disabled={publish.isPending || !open}
                />
              </label>
              <Label className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
                <Checkbox
                  checked={reviewed}
                  onCheckedChange={(checked) => {
                    if (submitting.current || extracting.current !== null) return;
                    setReviewed(checked === true);
                  }}
                  disabled={publish.isPending || sanitize.isPending || !open}
                />
                我已检查内容，确认可以供工作空间用户使用
              </Label>
            </>
          )}
        </div>
      </>
      <div className="form-footer mt-6 flex flex-wrap items-center justify-end gap-2">
        <ActionButton
          disabled={publish.isPending || !open}
          onClick={close}
          variant="outline"
        >
          取消
        </ActionButton>
        <ActionButton
          ref={submitButton}
          aria-label={`发布 v${(selected?.version || 0) + 1}`}
          aria-busy={publish.isPending}
          disabled={
            !open || sanitize.isPending ||
            (!publish.isPending && (!reviewed || !name.trim() || !spec))
          }
          onClick={() => {
            if (
              !active.current ||
              !open ||
              submitting.current ||
              extracting.current !== null ||
              publish.isPending ||
              confirming ||
              !reviewed ||
              !name.trim() ||
              !spec
            )
              return;
            submitting.current = true;
            const submit = submitButton.current;
            const dialog = submit?.closest('[role="dialog"]');
            if (submit && dialog?.contains(document.activeElement))
              submit.focus();
            publish.mutate({
              id: selected?.id || newID("template"),
              name,
              kind,
              expectedVersion: selected?.version || 0,
              spec,
            });
          }}
          variant="default"
          pending={!!publish.isPending}
        >
          发布 v{(selected?.version || 0) + 1}
        </ActionButton>
      </div>
    </TaskDialog>
  );
}
