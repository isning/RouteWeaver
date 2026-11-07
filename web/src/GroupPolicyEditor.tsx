import { NumericInput } from "@/ui-patterns/numeric-input";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { TaskSheet, useTaskReturnFocus } from "@/ui-patterns/task-overlays";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { Input } from "@/components/ui/input";
import { useForm, AppField, AppForm } from "@/ui-patterns/form";
import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import { useEffect, useRef, useState } from "react";
import { APIError } from "./api";
import { ErrorNotice, QueryState } from "./components";
import { newID } from "./model";
import type { Service, UserRecord } from "./types";
import type { GroupPolicyEditContext, GroupReferenceLabels, NamedRecord, UserGroup } from "./access-policy-model";
import { usePolicyChange } from "./AccessPolicy";
import { loadGroupPolicyEditContext } from "./service-policy-edit";
import { GroupPolicyComparison } from "./GroupPolicyComparison";
import { useUnsavedChanges } from "./navigation";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
type DraftCopy = {
    group: UserGroup;
    baseline: GroupPolicyEditContext["record"];
    references?: GroupReferenceLabels;
};
const referencesFor = (group: UserGroup | null, references?: GroupReferenceLabels): GroupReferenceLabels => ({
    users: references?.users.filter((entry) => group?.memberIds?.includes(entry.id)) ?? [],
    services: references?.services.filter((entry) => group?.serviceId === entry.id) ?? [],
});
type Props = {
    initial: UserGroup | null;
    users: UserRecord[];
    services: Service[];
    routes: NamedRecord[];
    onClose: () => void;
    returnFocus?: HTMLElement | null;
};
const newGroup = (id: string): UserGroup => ({ id, name: "", serviceId: "", priority: 0, memberIds: [] });
const options = (records: NamedRecord[]) => records.map((record) => ({ value: record.id,
    label: records.some((other) => other.id !== record.id && other.name === record.name) ? `${record.name}（${record.id}）` : record.name }));
// Local ownership deliberately mirrors ServicePolicyEditor. The transport guard
// and preview/apply state machine are shared; no independent token/session exists.
export function GroupPolicyEditor(props: Props) {
    const returnFocus = useTaskReturnFocus(props.returnFocus);
    const [creation, setCreation] = useState<{
        id: string;
        seed?: DraftCopy;
        retained: DraftCopy[];
    }>(() => ({ id: newID("group"), retained: [] }));
    const id = props.initial?.id || creation.id;
    return <GroupEditSession key={`${props.initial ? "edit" : "create"}:${id}`} {...props} returnFocus={returnFocus} id={id} seed={props.initial ? undefined : creation.seed} retained={props.initial ? [] : creation.retained} restartCreation={(draft, retained) => setCreation({ id: newID("group"), seed: draft, retained })}/>;
}
function GroupEditSession({ id, seed, retained: initialRetained, restartCreation, ...props }: Props & {
    id: string;
    seed?: DraftCopy;
    retained: DraftCopy[];
    restartCreation: (draft: DraftCopy | undefined, retained: DraftCopy[]) => void;
}) {
    const [context, setContext] = useState<GroupPolicyEditContext | null>(null);
    const [error, setError] = useState<Error | null>(null), [attempt, setAttempt] = useState(0), [generation, setGeneration] = useState(0);
    const [retained, setRetained] = useState(initialRetained);
    const { confirm: confirmDiscard, confirming } = useDiscardConfirmation(id);
    useUnsavedChanges(!context && retained.length > 0);
    const closeLoading = () => {
        if (confirming) return;
        if (!retained.length) {
            props.onClose();
            return;
        }
        confirmDiscard({
            title: "放弃保留的未保存草稿？", description: "关闭后将无法恢复这些草稿副本。", confirmLabel: "放弃草稿并关闭", cancelLabel: "继续编辑",
        }, props.onClose);
    };
    useEffect(() => {
        let current = true;
        const controller = new AbortController();
        setError(null);
        loadGroupPolicyEditContext(id, controller.signal).then((loaded) => {
            if (!current)
                return;
            if (!!props.initial !== loaded.precondition.exists) {
                setError(new APIError(props.initial ? "此用户组已不存在，不能将旧编辑内容当作新用户组保存。" : "此用户组标识已存在，请使用新标识重新新建。", 409));
                return;
            }
            setContext(loaded);
        }, (failure: Error) => {
            if (current)
                setError(failure);
        });
        return () => { current = false; controller.abort(); };
    }, [id, attempt]);
    if (!context)
        return <TaskSheet returnFocus={props.returnFocus} title={props.initial ? `编辑 ${props.initial.name}` : "新建用户组"} open onOpenChange={open => {
                if (!open)
                    (closeLoading)();
            }} size="lg" bodyProps={{ className: "space-y-6" }}>
    <QueryState loading={!error} error={error} retry={() => setAttempt((value) => value + 1)}><></></QueryState>
    {!props.initial && error instanceof APIError && error.status === 409 && <ActionButton onClick={() => restartCreation(seed, retained)} variant="outline">使用新标识重新新建</ActionButton>}
  </TaskSheet>;
    return <GroupPolicyDraft key={generation} {...props} context={context} seed={seed} retained={retained} discardRetained={(index) => setRetained((values) => values.filter((_value, position) => position !== index))} acceptLatest={(latest, draft) => { setRetained((values) => [...values, draft]); setContext(latest); setGeneration((value) => value + 1); }} restartCreation={(draft) => restartCreation(draft, [...retained, draft])}/>;
}
function GroupPolicyDraft({ context, seed, retained, discardRetained, acceptLatest, restartCreation, ...props }: Props & {
    context: GroupPolicyEditContext;
    seed?: DraftCopy;
    retained: DraftCopy[];
    discardRetained: (index: number) => void;
    acceptLatest: (context: GroupPolicyEditContext, draft: DraftCopy) => void;
    restartCreation: (draft: DraftCopy) => void;
}) {
    const confirm = useConfirm();
    const [form] = useForm();
    const [value] = useState<UserGroup>(() => structuredClone(context.record?.group || (seed ? { ...seed.group, id: context.target.id } : newGroup(context.target.id))));
    const [latest, setLatest] = useState<GroupPolicyEditContext | null>(null), [latestError, setLatestError] = useState<Error | null>(null);
    const [latestPending, setLatestPending] = useState(false), [conflicted, setConflicted] = useState(false);
    const latestGeneration = useRef(0), latestController = useRef<AbortController | null>(null);
    const policy = usePolicyChange({ mode: "guarded-group", users: props.users, services: props.services, routes: props.routes, retainedDrafts: retained, onApplied: props.onClose });
    useEffect(() => () => { latestGeneration.current++; latestController.current?.abort(); }, []);
    useEffect(() => {
        if (policy.error instanceof APIError && policy.error.status === 409)
            setConflicted(true);
    }, [policy.error]);
    const baselineConflictVisible = policy.error instanceof APIError && policy.error.status === 409 &&
        typeof policy.error.details === "object" && policy.error.details !== null && "code" in policy.error.details && policy.error.details.code === "POLICY_EDIT_BASELINE_CHANGED";
    // The guarded group task owns this exact store-conflict response. Other
    // statuses/envelopes and latest-version read errors keep their own message.
    const stalePolicyConflict = policy.error instanceof APIError && policy.error.status === 409 &&
        policy.error.message === "resource changed; reload and retry" &&
        typeof policy.error.details === "object" && policy.error.details !== null &&
        Object.keys(policy.error.details).length === 1 && "detail" in policy.error.details &&
        policy.error.details.detail === policy.error.message;
    const draft = (): UserGroup => ({ ...value, ...form.getFieldsValue(true), id: value.id });
    const draftCopy = (): DraftCopy => structuredClone({ group: draft(), baseline: context.record, references: context.references });
    const invalidateLatest = () => { latestGeneration.current++; latestController.current?.abort(); setLatest(null); setLatestError(null); setLatestPending(false); };
    const readLatest = async () => {
        invalidateLatest();
        const owner = latestGeneration.current, controller = new AbortController();
        latestController.current = controller;
        setLatestPending(true);
        try {
            const result = await loadGroupPolicyEditContext(value.id, controller.signal);
            if (owner === latestGeneration.current)
                setLatest(result);
        }
        catch (error) {
            if (owner === latestGeneration.current)
                setLatestError(error as Error);
        }
        finally {
            if (owner === latestGeneration.current)
                setLatestPending(false);
        }
    };
    const useLatest = () => {
        if (!latest?.record || !context.precondition.exists)
            return;
        const incoming = latest, previous = draftCopy(), owner = latestGeneration.current;
        confirm({
            title: "使用最新版本重新编辑？", description: "编辑区将换成最新保存的用户组。本次草稿会保留为未保存副本，不会自动合并。", confirmLabel: "使用最新版本", cancelLabel: "保留当前编辑",
            onConfirm: () => {
                if (owner === latestGeneration.current)
                    acceptLatest(incoming, previous);
            }
        });
    };
    return <TaskSheet returnFocus={props.returnFocus} title={context.precondition.exists ? `编辑 ${value.name}` : "新建用户组"} open onOpenChange={open => {
            if (!open)
                (policy.requestClose)();
        }} pending={!(!policy.closingBlocked)} size="lg" bodyProps={{ className: "space-y-6" }}>
    {retained.length > 0 && <Accordion type="multiple">{(retained.map((saved, index) => ({ key: `${index}`, label: index === retained.length - 1 ? "\u4E0A\u4E00\u7248\u8349\u7A3F\uFF08\u672A\u4FDD\u5B58\uFF09" : `较早草稿 ${index + 1}（未保存）`, children: <>
      <GroupPolicyComparison resource={{ target: { kind: "group", id: saved.group.id }, before: saved.baseline, after: { group: saved.group }, references: { before: referencesFor(saved.baseline?.group ?? null, saved.references), after: referencesFor(saved.group, saved.references) } }} title="保留的草稿" showAll beforeLabel="当时打开的版本" afterLabel="保留的草稿"/>
      <ActionButton onClick={() => discardRetained(index)} variant="destructive">丢弃此草稿副本</ActionButton>
    </> }))).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4">{section.children}</AccordionContent></AccordionItem>)}</Accordion>}
    <AppForm form={form} initialValues={value} onValuesChange={() => { invalidateLatest(); policy.clearError(); }} onFinish={() => { if (!policy.closingBlocked) policy.propose({ group: draft() }, context.precondition); }}>
      <ErrorNotice error={policy.error} focusRef={policy.errorFocusRef} presentation={stalePolicyConflict ? {
          title: "操作未完成", recovery: "草稿尚未保存，请核对最新版本。", detailsLabel: "查看技术详情",
      } : undefined}/>
      {conflicted && <section className="space-y-4 rounded-lg border bg-muted/30 p-4" aria-label="处理用户组版本变化">
        {!baselineConflictVisible && !stalePolicyConflict && <p>草稿尚未保存，请核对最新版本。</p>}
        <ActionButton onClick={readLatest} pending={latestPending} disabled={policy.closingBlocked} variant="outline">查看最新版本</ActionButton><ErrorNotice error={latestError}/>
        {latest && <>
          {latest.record ? <GroupPolicyComparison resource={{ target: latest.target, before: context.record, after: latest.record, references: { before: referencesFor(context.record?.group ?? null, context.references), after: referencesFor(latest.record.group, latest.references) } }} title="已保存的用户组变化" beforeLabel="打开时保存" afterLabel="最新保存"/> : <p>{context.precondition.exists ? "用户组已不存在，当前草稿不会自动新建同名用户组。" : "用户组仍未创建，可用当前草稿重新预览。"}</p>}
          {context.precondition.exists && latest.record && <ActionButton onClick={useLatest} disabled={policy.closingBlocked} variant="outline">使用最新版本重新编辑</ActionButton>}
          {!context.precondition.exists && latest.record && <ActionButton onClick={() => restartCreation(draftCopy())} disabled={policy.closingBlocked} variant="outline">使用新标识另建用户组</ActionButton>}
        </>}
      </section>}
      <AppField name="name" label="用户组名称" rules={[{ required: true, whitespace: true, message: "请输入用户组名称" }]}><Input /></AppField>
      <AppField name="serviceId" label="组服务方案" rules={[{ required: true, message: "请选择服务方案" }]} trigger="onValueChange"><ChoiceSelect options={options(props.services)}/></AppField>
      <AppField name="memberIds" label="组成员" trigger="onValueChange"><MultiChoice options={options(props.users)}/></AppField>
      <AppField name="priority" label="用户组优先级" description="数值越大越优先。同一优先级不能给同一用户分配不同方案。" rules={[{ required: true }, { type: "integer", min: -2147483648, max: 2147483647, message: "请输入有效的 32 位整数优先级" }]} trigger="onValueChange"><NumericInput precision={0} min={-2147483648} max={2147483647}/></AppField>
      <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4"><ActionButton disabled={policy.closingBlocked} onClick={policy.requestClose} variant="outline">取消</ActionButton><ActionButton type="submit" aria-label="预览影响" aria-busy={policy.pending} keepFocusableWhilePending pending={policy.pending} variant="default">预览影响</ActionButton></div>
    </AppForm>
    {policy.dialog}
  </TaskSheet>;
}
