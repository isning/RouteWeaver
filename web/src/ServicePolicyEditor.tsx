import { NumericInput } from "@/ui-patterns/numeric-input";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { TaskSheet } from "@/ui-patterns/task-overlays";
import { MultiChoice } from "@/ui-patterns/choice-select";
import { Input } from "@/components/ui/input";
import { useForm, AppField, AppForm } from "@/ui-patterns/form";
import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import { useEffect, useRef, useState } from "react";
import { APIError } from "./api";
import { ErrorNotice, QueryState } from "./components";
import { newID } from "./model";
import type { Service, UserRecord } from "./types";
import type { NamedRecord, ServicePolicyEditContext } from "./access-policy-model";
import { usePolicyChange } from "./AccessPolicy";
import { CycleFields, LimitFields } from "./PolicyFields";
import { loadServicePolicyEditContext } from "./service-policy-edit";
import { ServicePolicyComparison } from "./ServicePolicyComparison";
import { useUnsavedChanges } from "./navigation";
import { revealFocusedDrawerControl } from "./drawer-control-visibility";
type DraftCopy = {
    service: Service;
    quotaGiB: unknown;
    baseline: ServicePolicyEditContext["record"];
};
type Props = {
    initial: Service | null;
    users: UserRecord[];
    services: Service[];
    routes: NamedRecord[];
    onClose: () => void;
};
function newPlan(id: string): Service {
    return { id, name: "", quotaBytes: 100 * 1024 ** 3, routeIds: [], onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0,
        cycle: { mode: "monthly", day: 1, timezone: "UTC+8", anchor: new Date().toISOString() } };
}
export function ServicePolicyEditor(props: Props) {
    const [creation, setCreation] = useState<{
        id: string;
        seed?: DraftCopy;
        retained: DraftCopy[];
    }>(() => ({ id: newID("service"), retained: [] }));
    const id = props.initial?.id || creation.id;
    return <ServiceEditSession key={`${props.initial ? "edit" : "create"}:${id}`} {...props} id={id} seed={props.initial ? undefined : creation.seed} retained={props.initial ? [] : creation.retained} restartCreation={(draft, retained) => setCreation({ id: newID("service"), seed: draft, retained })}/>;
}
function ServiceEditSession({ id, seed, retained: initialRetained, restartCreation, ...props }: Props & {
    id: string;
    seed?: DraftCopy;
    retained: DraftCopy[];
    restartCreation: (draft: DraftCopy | undefined, retained: DraftCopy[]) => void;
}) {
    const [context, setContext] = useState<ServicePolicyEditContext | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [generation, setGeneration] = useState(0);
    const [retained, setRetained] = useState(initialRetained);
    const confirm = useConfirm();
    useUnsavedChanges(!context && retained.length > 0);
    const closeLoading = () => {
        if (!retained.length) {
            props.onClose();
            return;
        }
        confirm({
            title: "放弃保留的未保存草稿？", description: "关闭后将无法恢复这些草稿副本。", confirmLabel: "放弃草稿并关闭", cancelLabel: "继续编辑",
            destructive: true,
            onConfirm: props.onClose
        });
    };
    useEffect(() => {
        let current = true;
        const controller = new AbortController();
        setError(null);
        loadServicePolicyEditContext(id, controller.signal).then((loaded) => {
            if (!current)
                return;
            if (!!props.initial !== loaded.precondition.exists) {
                setError(new APIError(props.initial ? "此方案已不存在，不能将旧编辑内容当作新方案保存。" : "此方案标识已存在，请使用新标识重新新建。", 409));
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
        return <TaskSheet title={props.initial ? `编辑 ${props.initial.name}` : "新建服务方案"} open onOpenChange={open => {
                if (!open)
                    (closeLoading)();
            }} size="lg" bodyProps={{ className: "space-y-6" }}>
    <QueryState loading={!error} error={error} retry={() => setAttempt((value) => value + 1)}><></></QueryState>
    {!props.initial && error instanceof APIError && error.status === 409 && <ActionButton onClick={() => restartCreation(seed, retained)} variant="outline">使用新标识重新新建</ActionButton>}
  </TaskSheet>;
    return <ServicePolicyDraft key={generation} {...props} context={context} seed={seed} retained={retained} discardRetained={(index) => setRetained((values) => values.filter((_value, position) => position !== index))} acceptLatest={(latest, draft) => { setRetained((values) => [...values, draft]); setContext(latest); setGeneration((value) => value + 1); }} restartCreation={(draft) => restartCreation(draft, [...retained, draft])}/>;
}
function ServicePolicyDraft({ context, seed, retained, discardRetained, acceptLatest, restartCreation, ...props }: Props & {
    context: ServicePolicyEditContext;
    seed?: DraftCopy;
    retained: DraftCopy[];
    discardRetained: (index: number) => void;
    acceptLatest: (context: ServicePolicyEditContext, draft: DraftCopy) => void;
    restartCreation: (draft: DraftCopy) => void;
}) {
    const confirm = useConfirm();
    const [form] = useForm();
    const [value] = useState<Service>(() => structuredClone(context.record?.service || (seed ? { ...seed.service, id: context.target.id } : newPlan(context.target.id))));
    const [latest, setLatest] = useState<ServicePolicyEditContext | null>(null);
    const [latestError, setLatestError] = useState<Error | null>(null);
    const [latestPending, setLatestPending] = useState(false);
    const [conflicted, setConflicted] = useState(false);
    const latestGeneration = useRef(0);
    const latestController = useRef<AbortController | null>(null);
    const policy = usePolicyChange({ mode: "guarded-service", users: props.users, services: props.services, routes: props.routes, retainedDrafts: retained, onApplied: props.onClose });
    useEffect(() => () => { latestGeneration.current++; latestController.current?.abort(); }, []);
    useEffect(() => {
        if (policy.error instanceof APIError && policy.error.status === 409)
            setConflicted(true);
    }, [policy.error]);
    const baselineConflictVisible = policy.error instanceof APIError && policy.error.status === 409 &&
        typeof policy.error.details === "object" && policy.error.details !== null &&
        "code" in policy.error.details && policy.error.details.code === "POLICY_EDIT_BASELINE_CHANGED";
    const draft = (): Service => {
        const { quotaGiB, ...values } = form.getFieldsValue(true);
        return { ...value, ...values, id: value.id, cycle: { ...value.cycle, ...values.cycle }, quotaBytes: Math.round(quotaGiB * 1024 ** 3) };
    };
    const draftCopy = (): DraftCopy => structuredClone({ service: draft(), quotaGiB: form.getFieldValue("quotaGiB"), baseline: context.record });
    const invalidateLatest = () => {
        latestGeneration.current++;
        latestController.current?.abort();
        setLatest(null);
        setLatestError(null);
        setLatestPending(false);
    };
    const readLatest = async () => {
        invalidateLatest();
        const owner = latestGeneration.current;
        const controller = new AbortController();
        latestController.current = controller;
        setLatestPending(true);
        try {
            const result = await loadServicePolicyEditContext(value.id, controller.signal);
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
            title: "使用最新版本重新编辑？", description: "编辑区将换成最新保存的方案。本次草稿会保留为未保存副本，不会自动合并。", confirmLabel: "使用最新版本", cancelLabel: "保留当前编辑",
            onConfirm: () => {
                if (owner === latestGeneration.current)
                    acceptLatest(incoming, previous);
            }
        });
    };
    return <TaskSheet title={context.precondition.exists ? `编辑 ${value.name}` : "新建服务方案"} open onOpenChange={open => {
            if (!open)
                (policy.requestClose)();
        }} pending={!(!policy.closingBlocked)} size="lg" bodyProps={{ className: "space-y-6" }}>
    {retained.length > 0 && <Accordion type="multiple">{(retained.map((saved, index) => ({ key: `${index}`, label: index === retained.length - 1 ? "\u4E0A\u4E00\u7248\u8349\u7A3F\uFF08\u672A\u4FDD\u5B58\uFF09" : `较早草稿 ${index + 1}（未保存）`, children: <>
      <ServicePolicyComparison resource={{ target: { kind: "service", id: saved.service.id }, before: saved.baseline, after: { service: saved.service } }} title="保留的草稿" showAll draftQuota={{ value: saved.quotaGiB }} beforeLabel="当时打开的版本" afterLabel="保留的草稿"/>
      <ActionButton onClick={() => discardRetained(index)} variant="destructive">丢弃此草稿副本</ActionButton>
    </> }))).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4">{section.children}</AccordionContent></AccordionItem>)}</Accordion>}
    <AppForm form={form} onFocusCapture={revealFocusedDrawerControl} initialValues={{ ...value, onlineIpLimit: value.onlineIpLimit || 0, connectionLimit: value.connectionLimit || 0, entryRateBps: value.entryRateBps || 0, quotaGiB: !context.record && seed ? seed.quotaGiB : value.quotaBytes / 1024 ** 3 }} onValuesChange={() => { invalidateLatest(); policy.clearError(); }} onFinish={() => policy.propose({ service: draft() }, context.precondition)}>
      <ErrorNotice error={policy.error} focusRef={policy.errorFocusRef}/>
      {conflicted && <section className="space-y-4 rounded-lg border bg-muted/30 p-4" aria-label="处理方案版本变化">
        {!baselineConflictVisible && <p>草稿尚未保存，请核对最新版本。</p>}
        <ActionButton onClick={readLatest} pending={latestPending} disabled={policy.closingBlocked} variant="outline">查看最新版本</ActionButton>
        <ErrorNotice error={latestError}/>
        {latest && <>
          {latest.record ? <ServicePolicyComparison resource={{ target: latest.target, before: context.record, after: latest.record }} title="已保存的方案变化" beforeLabel="打开时保存" afterLabel="最新保存"/> : <p>{context.precondition.exists ? "方案已不存在，当前草稿不会自动新建同名方案。" : "方案仍未创建，可用当前草稿重新预览。"}</p>}
          {context.precondition.exists && latest.record && <ActionButton onClick={useLatest} disabled={policy.closingBlocked} variant="outline">使用最新版本重新编辑</ActionButton>}
          {!context.precondition.exists && latest.record && <ActionButton onClick={() => restartCreation(draftCopy())} disabled={policy.closingBlocked} variant="outline">使用新标识另建方案</ActionButton>}
        </>}
      </section>}
        <AppField name="name" label="服务方案名称" rules={[{ required: true, whitespace: true }]}>
          <Input />
        </AppField>
        <fieldset className="policy-field-group space-y-4 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">流量与重置</legend>
          <AppField name="quotaGiB" label="周期额度（GiB，0 为不限额）" rules={[
            { required: true },
            {
                validator: (_, v) => Number.isSafeInteger(v * 1024 ** 3) && v >= 0
                    ? Promise.resolve()
                    : Promise.reject(new Error("额度必须能表示为安全范围内的整数字节")),
            },
        ]} trigger="onValueChange">
            <NumericInput min={0} max={Number.MAX_SAFE_INTEGER / 1024 ** 3}/>
          </AppField>
          <CycleFields planDefaults/>
          <p className="muted text-sm text-muted-foreground">
            用户组首次设置账号周期时使用；已有周期和用量继续保留，方案额度按优先级选用一份，个人覆盖优先。
          </p>
        </fieldset>
        <fieldset className="policy-field-group space-y-4 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">线路权限</legend>
          <AppField name="routeIds" label="方案授权线路" trigger="onValueChange">
            <MultiChoice options={props.routes.map((r) => ({ value: r.id, label: r.name }))}/>
          </AppField>
        </fieldset>
        <Accordion type="multiple">{([
            {
                key: "limits",
                label: "\u5728\u7EBF\u3001\u5E76\u53D1\u4E0E\u901F\u7387\u9650\u5236",
                children: <LimitFields />,
            },
        ]).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4">{section.children}</AccordionContent></AccordionItem>)}</Accordion>

      <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <ActionButton disabled={policy.closingBlocked} onClick={policy.requestClose} variant="outline">取消</ActionButton>
        <ActionButton type="submit" aria-label="预览影响" aria-busy={policy.pending} pending={policy.pending} variant="default">预览影响</ActionButton>
      </div>
    </AppForm>
    {policy.dialog}
  </TaskSheet>;
}
