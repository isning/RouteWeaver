import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Notice } from "@/ui-patterns/notice";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/ui-patterns/confirmations";
import { toast } from "sonner";
import { ActionButton } from "@/ui-patterns/actions";
import { invalidateOutputInputs } from "./output-comparison";
import { RoutingReview } from "./RoutingSummary";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, list, post, request, saveRecord } from "./api";
import {
  ProfileDraftConflict,
  profileDraftChanged,
} from "./ProfileDraftConflict";
import {
  basicChoices,
  basicProfile,
  basicSelection,
  chatGPTDomains,
  type BasicSelection,
} from "./basic-routing-model";
import { clientTargets } from "./client-targets";
import {
  CodePreview,
  EmptyState,
  ErrorNotice,
  PageHeader,
  QueryState,
  Section,
} from "./components";
import { emptyProfile, newID, redact } from "./model";
import { useUnsavedChanges } from "./navigation";
import type {
  Output,
  OutputCreation,
  Overview,
  PlatformEntry,
  Preview,
  Profile,
  Source,
} from "./types";
type Props = {
  initial?: Profile;
  output?: Output;
  onClose: () => void;
  onPublished: (output: Output) => void;
  onAdvanced: (profile: Profile, isNew: boolean, dirty: boolean) => void;
  onSources: () => void;
};
export function BasicRouting(props: Props) {
  const [empty] = useState(() => ({ ...emptyProfile(), name: "日常订阅" }));
  const profile = useQuery({
    queryKey: ["basic-profile", props.output?.profileId],
    queryFn: () =>
      request<Profile>(`/me/profiles/${props.output!.profileId}/reveal`),
    enabled: !!props.output && !props.initial,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const initial = props.initial || profile.data;
  return (
    <QueryState
      loading={!!props.output && !props.initial && profile.isPending} paused={profile.isPaused} loadingLayout="form"
      error={profile.error}
      retry={() => profile.refetch()}
    >
      {initial &&
      (!basicSelection(initial) ||
        (props.output &&
          (props.output.mode !== "full" ||
            props.output.target.adapterId !== initial.target.adapterId ||
            props.output.target.version !== initial.target.version))) ? (
        <>
          <PageHeader title="调整分流" back={props.onClose} />
          <Section title={initial.name}>
            <p>
              这份配置包含自定义分组、规则、高级设置或独立的客户端版本。继续在完整编辑器中调整，保留原有配置。
            </p>
            <ActionButton
              onClick={() => props.onAdvanced(initial, false, false)}
              variant="default"
            >
              继续编辑完整配置
            </ActionButton>
          </Section>
        </>
      ) : (
        (!props.output || initial) && (
          <BasicRoutingEditor
            key={initial?.id || empty.id}
            {...props}
            initial={initial || empty}
            isNew={!initial}
          />
        )
      )}
    </QueryState>
  );
}
function BasicRoutingEditor({
  initial,
  isNew,
  output,
  onClose,
  onPublished,
  onAdvanced,
  onSources,
}: Props & {
  initial: Profile;
  isNew: boolean;
}) {
  const [selection, setSelection] = useState<BasicSelection>(() => ({
    ...(basicSelection(initial) || {
      name: initial.name,
      adapterId: initial.target.adapterId,
      chatEndpointId: "",
      defaultEndpointId: "",
    }),
    ...(output ? { adapterId: output.target.adapterId } : {}),
  }));
  const [dirty, setDirty] = useState(false);
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
  const [reviewedInputs, setReviewedInputs] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const revisionToken = useRef(initial.revisionToken);
  const saved = useRef(!isNew),
    version = useRef(0),
    outputID = useRef(newID("output"));
  const message = toast,
    confirm = useConfirm();
  const client = useQueryClient();
  useUnsavedChanges(dirty);
  const entries = useQuery({
    queryKey: ["platform-entries"],
    queryFn: () => list<PlatformEntry>("/me/platform-entries"),
  });
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => list<Source>("/me/sources"),
  });
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => request<Overview>("/me/overview"),
    retry: false,
  });
  const choices = basicChoices(
    entries.data || [],
    sources.data || [],
    overview.data?.routes || [],
  );
  const inputStamp = JSON.stringify([
    entries.data,
    sources.data,
    overview.data?.routes,
  ]);
  const reviewCurrent =
    !!preview &&
    !dirty &&
    reviewedInputs === inputStamp &&
    !entries.isFetching &&
    !sources.isFetching &&
    !entries.isError &&
    !sources.isError;
  const selected = (id: string) => choices.find((choice) => choice.id === id);
  const labels = (id: string) =>
    selected(id)?.label ||
    `${initial.ir.endpoints.find((endpoint) => endpoint.id === id)?.name || "原选线路"}（当前不可选）`;
  const missing = [
    ...new Set(
      [selection.chatEndpointId, selection.defaultEndpointId].filter(
        (id) => id && !selected(id),
      ),
    ),
  ];
  const options = [
    ...(["平台线路", "我的机场"] as const).map((section) => ({
      label: section,
      options: choices
        .filter((c) => c.section === section)
        .map((c) => ({ value: c.id, label: c.label })),
    })),
    ...(missing.length
      ? [
          {
            label: "原有选择",
            options: missing.map((id) => ({
              value: id,
              label: labels(id),
              disabled: true,
            })),
          },
        ]
      : []),
  ];
  const payload = () => ({
    ...basicProfile(initial, selection, choices),
    revisionToken: revisionToken.current,
  });
  const update = (patch: Partial<BasicSelection>) => {
    version.current++;
    setSelection((s) => ({ ...s, ...patch }));
    setDirty(true);
    setPreview(null);
    setError(null);
  };
  const valid = () => {
    if (!selection.name.trim()) throw new Error("请填写订阅名称。");
    if (!selection.chatEndpointId || !selection.defaultEndpointId)
      throw new Error("请分别选择 ChatGPT 和其他流量使用的线路。");
    if (missing.length)
      throw new Error("原选线路当前不可用，请明确选择替代线路后再保存。");
  };
  const saveDraft = async () => {
    if (draftConflict)
      throw new Error("请先处理配置版本变化，当前输入已保留。");
    valid();
    const atVersion = version.current;
    const draft = payload();
    invalidateOutputInputs(client, draft.id);
    try {
      const result = await saveRecord<Profile>(
        "me/profiles",
        draft,
        !saved.current,
      );
      revisionToken.current = result.revisionToken;
    } catch (error) {
      if (profileDraftChanged(error)) {
        setDraftConflict(true);
        setDirty(true);
        setPreview(null);
      }
      throw error;
    } finally {
      invalidateOutputInputs(client, draft.id);
    }
    saved.current = true;
    client.invalidateQueries({ queryKey: ["profiles"] });
    client.invalidateQueries({ queryKey: ["outputs"] });
    if (atVersion === version.current) setDirty(false);
    return { draft, atVersion };
  };
  const save = useMutation({
    mutationFn: saveDraft,
    onSuccess: () => message.success("分流草稿已保存，订阅尚未发布"),
    onError: setError,
  });
  const inspect = useMutation({
    mutationFn: async () => {
      const stamp = inputStamp;
      const { draft, atVersion } = await saveDraft();
      const creation: OutputCreation = {
        id: outputID.current,
        name: draft.name,
        profileId: draft.id,
        target: draft.target,
        mode: "full",
      };
      const result = output
        ? await post<Preview>(`/me/profiles/${draft.id}/preview`, {
            outputId: output.id,
            target: output.target,
            mode: output.mode,
          })
        : await post<Preview>("/me/outputs/preview", creation);
      if (
        result.valid !== true ||
        !result.artifacts?.length ||
        !result.previewDigest ||
        (!output &&
          (result.previewScope !== "new-output" ||
            result.outputId !== creation.id))
      )
        throw new Error("这份配置未通过预览，请检查线路和客户端选择。");
      return { result, creation, atVersion, stamp };
    },
    onSuccess: ({ result, creation, atVersion, stamp }) => {
      if (atVersion === version.current) {
        setPreview(result);
        setReviewedCreation(creation);
        setReviewedInputs(stamp);
        setError(null);
      }
    },
    onError: setError,
  });
  const finishPublication = (result: Output) => {
    setDirty(false);
    setPendingCreation(null);
    client.invalidateQueries({ queryKey: ["outputs"] });
    client.invalidateQueries({ queryKey: ["profiles"] });
    message.success(output ? "订阅已更新" : "订阅已发布");
    onPublished(result);
  };
  const recover = useMutation({
    mutationFn: async () => {
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
    onSuccess: finishPublication,
  });
  const publish = useMutation({
    mutationFn: async (
      retry?: OutputCreation & {
        previewDigest: string;
      },
    ) => {
      let attempt = retry;
      if (!attempt) {
        if (!preview || !reviewCurrent)
          throw new Error("配置或线路已变化，请重新查看修改。");
        if (output)
          return post<Output>(`/me/outputs/${output.id}/publish`, {
            previewDigest: preview.previewDigest,
          });
        if (!reviewedCreation || !preview.previewDigest)
          throw new Error("请先查看这份新订阅的输出预览。");
        attempt = { ...reviewedCreation, previewDigest: preview.previewDigest };
      }
      try {
        return await post<Output>("/me/outputs", attempt);
      } catch (failure) {
        const rejected =
          failure instanceof APIError &&
          failure.status >= 400 &&
          failure.status < 500;
        // A definitive rejection is not made uncertain by a later read failure.
        // Only a prior uncertain attempt may still have an accepted receipt.
        if (rejected && !creationWasUncertain.current) throw failure;
        if (!rejected) creationWasUncertain.current = true;
        setPendingCreation(attempt);
        // Reconcile only this reviewed creation, not an unrelated publication
        // that happens to have the same stable output identity.
        const existing = await list<Output>("/me/outputs").catch(() => {
          if (rejected) throw failure;
          // A lost response followed by an unavailable lookup is still unknown.
          // Preserve the same reviewed attempt so retry can recover its receipt.
          throw new APIError(
            "无法确认订阅是否已发布。请重试以核对同一份订阅，当前选择已保留。",
            0,
          );
        });
        const found = Array.isArray(existing)
          ? existing.find(
              (item) =>
                item.id === attempt.id &&
                item.profileId === attempt.profileId &&
                item.status === "published" &&
                item.creationReviewDigest === attempt.previewDigest,
            )
          : undefined;
        if (found) return found;
        // A rejected replay with a completed lookup permits a fresh review of
        // this same identity. Keep its uncertainty history: an older receipt
        // may still appear later, but cannot prove a revised digest succeeded.
        if (rejected) setPendingCreation(null);
        throw failure;
      }
    },
    onSuccess: finishPublication,
    onError: (failure) => {
      setError(failure);
      if (
        failure instanceof APIError &&
        (failure.status === 409 || (output && failure.status === 0))
      ) {
        setPreview(null);
      }
    },
  });
  const busy =
    save.isPending ||
    inspect.isPending ||
    publish.isPending ||
    recover.isPending;
  const locked = busy || !!pendingCreation;
  const leave = (action: () => void) =>
    dirty
      ? confirm({
          title: "放弃尚未保存的分流修改？",
          description: "已发布的订阅保留原版本。",
          confirmLabel: "放弃修改",
          cancelLabel: "继续编辑",
          onConfirm: action,
        })
      : action();
  const advanced = () => {
    // Keep unavailable selections attached to their original references rather
    // than silently dropping them during an advanced-editor handoff.
    const draft = payload();
    if (missing.length) {
      draft.sourceIds = initial.sourceIds;
      draft.platformEntryIds = initial.platformEntryIds;
      draft.ir.endpoints = initial.ir.endpoints;
    }
    onAdvanced(draft, !saved.current, dirty || isNew);
  };
  return (
    <>
      <PageHeader
        title={output ? "调整分流" : "设置订阅"}
        back={() => {
          if (!busy) leave(onClose);
        }}
      />
      <QueryState
        loading={entries.isPending || sources.isPending} paused={entries.isPaused || sources.isPaused} loadingLayout="form"
        error={entries.error || sources.error}
        retry={() => {
          entries.refetch();
          sources.refetch();
        }}
      >
        {!choices.length && !missing.length ? (
          <Section>
            <EmptyState
              title="还没有可用线路"
              description="可以联系管理员开通平台线路，或添加自己的机场后继续。"
              action={
                <ActionButton
                  onClick={() => leave(onSources)}
                  variant="default"
                >
                  添加我的机场
                </ActionButton>
              }
            />
          </Section>
        ) : (
          <>
            <Section title={output ? "配置草稿" : "日常连接"}>
              {output && (
                <p className="muted text-sm text-muted-foreground">
                  这里编辑已保存的草稿；发布后才会更新客户端订阅。
                </p>
              )}
              {draftConflict && (
                <ProfileDraftConflict
                  profileID={initial.id}
                  onClose={onClose}
                />
              )}
              <ErrorNotice error={profileDraftChanged(error) ? null : error} />
              <div className="settings-form grid gap-5 sm:grid-cols-2">
                <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                  订阅名称
                  <Input
                    aria-label="订阅名称"
                    value={selection.name}
                    disabled={locked}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </label>
                <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                  使用的客户端
                  <ChoiceSelect
                    aria-label="使用的客户端"
                    value={selection.adapterId}
                    disabled={locked || !!output}
                    options={clientTargets.map((t) => ({
                      value: t.value,
                      label: t.value === "mihomo" ? "Mihomo" : "sing-box",
                    }))}
                    onValueChange={(adapterId) => {
                      if (adapterId === undefined) return;
                      return update({ adapterId });
                    }}
                  />
                </label>
                <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                  ChatGPT 使用的线路
                  <ChoiceSelect
                    aria-label="ChatGPT 使用的线路"
                    placeholder="选择平台线路或我的机场"
                    value={selection.chatEndpointId || undefined}
                    disabled={locked}
                    options={options}
                    onValueChange={(chatEndpointId) => {
                      if (chatEndpointId === undefined) return;
                      return update({ chatEndpointId });
                    }}
                  />
                </label>
                <label className="standalone-label grid min-w-0 gap-2 text-sm font-medium">
                  其他流量使用的线路
                  <ChoiceSelect
                    aria-label="其他流量使用的线路"
                    placeholder="明确选择默认线路"
                    value={selection.defaultEndpointId || undefined}
                    disabled={locked}
                    options={options}
                    onValueChange={(defaultEndpointId) => {
                      if (defaultEndpointId === undefined) return;
                      return update({ defaultEndpointId });
                    }}
                  />
                </label>
              </div>
              {missing.length > 0 && (
                <Notice
                  tone="warning"
                  title="原选线路当前不可选。已保留原选择，请明确替换后再保存。"
                />
              )}
              <Accordion type="multiple">
                {[
                  {
                    key: "advanced",
                    label: "高级设置",
                    children: (
                      <>
                        <p>ChatGPT 分流匹配：{chatGPTDomains.join("、")}。</p>
                        <p>
                          更多应用、规则顺序、集合处理、DNS
                          和原生配置可在完整编辑器中调整。
                        </p>
                        <ActionButton
                          disabled={locked || draftConflict}
                          onClick={advanced}
                          variant="outline"
                        >
                          打开完整编辑器
                        </ActionButton>
                        <ActionButton
                          disabled={locked}
                          onClick={() => leave(onSources)}
                          variant="link"
                        >
                          管理我的机场
                        </ActionButton>
                      </>
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
              <div className="form-footer mt-6 flex flex-wrap items-center justify-end gap-2">
                <ActionButton
                  disabled={locked || draftConflict}
                  onClick={() => {
                    if (draftConflict) return;
                    setError(null);
                    save.mutate();
                  }}
                  variant="outline"
                >
                  保存草稿
                </ActionButton>
                <ActionButton
                  disabled={locked || draftConflict}
                  onClick={() => {
                    if (draftConflict) return;
                    setPreview(null);
                    setError(null);
                    inspect.mutate();
                  }}
                  variant="default"
                  pending={!!inspect.isPending}
                >
                  保存并查看修改
                </ActionButton>
              </div>
            </Section>
            {preview && !dirty && !reviewCurrent && (
              <Notice
                tone="info"
                title={
                  pendingCreation
                    ? "线路信息已变化，请先核对上次发布结果。"
                    : "线路信息已变化，请重新查看修改。"
                }
              />
            )}
            {reviewCurrent && preview && (
              <section
                className="surface space-y-5 rounded-lg border bg-card p-5 [&>h2]:font-semibold"
                aria-label="发布前确认"
              >
                <h2>发布前确认</h2>
                <RoutingReview
                  published={preview.publishedRoutingSummary}
                  candidate={preview.routingSummary}
                  creation={!output}
                />
                <dl className="grid gap-1 rounded-lg bg-muted/50 p-4 text-sm [&>dt]:text-muted-foreground [&>dd]:font-medium">
                  <dt>客户端</dt>
                  <dd>
                    {selection.adapterId === "mihomo" ? "Mihomo" : "sing-box"}
                  </dd>
                </dl>
                <p>
                  {output
                    ? "确认后更新当前订阅，沿用当前订阅链接。"
                    : "确认后创建这份订阅，随后可以获取链接。"}
                </p>
                <Accordion type="multiple">
                  {[
                    {
                      key: "output",
                      label: "查看生成配置",
                      children: preview.artifacts?.map((artifact) => (
                        <div key={artifact.path}>
                          <h3>{artifact.path}</h3>
                          <CodePreview content={redact(artifact.content)} />
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
                    disabled={locked}
                    onClick={() => setPreview(null)}
                    variant="outline"
                  >
                    继续调整
                  </ActionButton>
                  <ActionButton
                    disabled={
                      inspect.isPending || save.isPending || recover.isPending
                    }
                    onClick={() => publish.mutate()}
                    variant={pendingCreation ? "outline" : "default"}
                    pending={!!publish.isPending}
                  >
                    {output ? "发布修改" : "发布并获取订阅"}
                  </ActionButton>
                </div>
              </section>
            )}
          </>
        )}
      </QueryState>
      {pendingCreation && (
        <Section title="上次发布待确认">
          <p>
            核对或重试均使用上次提交的「{pendingCreation.name}
            」及其固定配置。
          </p>
          <ErrorNotice error={recover.error} />
          <ActionButton
            disabled={busy}
            onClick={() => recover.mutate()}
            variant="outline"
            pending={!!recover.isPending}
          >
            核对上次发布结果
          </ActionButton>
          <ActionButton
            disabled={busy}
            onClick={() => publish.mutate(pendingCreation)}
            variant="default"
            pending={!!publish.isPending}
          >
            重试上次发布
          </ActionButton>
        </Section>
      )}
    </>
  );
}
