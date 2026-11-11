import { serviceCountInteger, serviceQuotaBytes, serviceRateBytes } from "./service-quota-input";
import { NumericInput } from "@/ui-patterns/numeric-input";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { TaskSheet, useTaskReturnFocus } from "@/ui-patterns/task-overlays";
import { MultiChoice } from "@/ui-patterns/choice-select";
import { Input } from "@/components/ui/input";
import { useForm, AppField, AppForm } from "@/ui-patterns/form";
import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { revealFocusedDrawerControl, revealFocusedDrawerControlAfterAccordionOpen } from "./drawer-control-visibility";
const countFields = ["onlineIpLimit", "connectionLimit"] as const;
type CountField = typeof countFields[number];
type CountText = Partial<Record<CountField, string>>;
const countLabels: Record<CountField, string> = { onlineIpLimit: "在线 IP 上限", connectionLimit: "并发逻辑流上限" };
type DraftCopy = {
    service: Service;
    quotaGiB: unknown;
    quotaText?: string;
    rateText?: string;
    countText?: CountText;
    baseline: ServicePolicyEditContext["record"];
};
type Props = {
    initial: Service | null;
    users: UserRecord[];
    services: Service[];
    routes: NamedRecord[];
    onClose: () => void;
    returnFocus?: HTMLElement | null;
};
function newPlan(id: string): Service {
    return { id, name: "", quotaBytes: 100 * 1024 ** 3, routeIds: [], onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0,
        cycle: { mode: "monthly", day: 1, timezone: "UTC+8", anchor: new Date().toISOString() } };
}
export function ServicePolicyEditor(props: Props) {
    const returnFocus = useTaskReturnFocus(props.returnFocus);
    const [creation, setCreation] = useState<{
        id: string;
        seed?: DraftCopy;
        retained: DraftCopy[];
    }>(() => ({ id: newID("service"), retained: [] }));
    const id = props.initial?.id || creation.id;
    return <ServiceEditSession key={`${props.initial ? "edit" : "create"}:${id}`} {...props} returnFocus={returnFocus} id={id} seed={props.initial ? undefined : creation.seed} retained={props.initial ? [] : creation.retained} restartCreation={(draft, retained) => setCreation({ id: newID("service"), seed: draft, retained })}/>;
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
        return <TaskSheet returnFocus={props.returnFocus} title={props.initial ? `编辑 ${props.initial.name}` : "新建服务方案"} open onOpenChange={open => {
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
    const acceptedQuota = useRef(value.quotaBytes);
    const pendingQuota = useRef<string | null>(null);
    const [unfinishedQuota, setUnfinishedQuota] = useState<string | null>(null);
    const [quotaKey, setQuotaKey] = useState(0);
    const acceptedRate = useRef(value.entryRateBps ?? 0);
    const initialRateText = !context.record ? seed?.rateText : undefined;
    const rawRateText = useRef(initialRateText);
    const pendingRate = useRef<string | null>(initialRateText !== undefined && serviceRateBytes(initialRateText) === undefined ? initialRateText : null);
    const [unfinishedRate, setUnfinishedRate] = useState(pendingRate.current);
    const [rateKey, setRateKey] = useState(0);
    const acceptedCounts = useRef({ onlineIpLimit: value.onlineIpLimit ?? 0, connectionLimit: value.connectionLimit ?? 0 });
    const countText = useRef<CountText>({ ...(!context.record ? seed?.countText : undefined) });
    const [rawCounts, setRawCounts] = useState(countText.current);
    const [countKeys, setCountKeys] = useState({ onlineIpLimit: 0, connectionLimit: 0 });
    const [limitSections, setLimitSections] = useState<string[]>([]);
    const [latest, setLatest] = useState<ServicePolicyEditContext | null>(null);
    const [latestError, setLatestError] = useState<Error | null>(null);
    const [latestPending, setLatestPending] = useState(false);
    const [conflicted, setConflicted] = useState(false);
    const latestGeneration = useRef(0);
    const latestController = useRef<AbortController | null>(null);
    const policy = usePolicyChange({ mode: "guarded-service", users: props.users, services: props.services, routes: props.routes, retainedDrafts: retained, onApplied: props.onClose });
    // The active restarted draft owns its unsaved edits independently of the
    // retained comparison copy, which can be discarded separately.
    useLayoutEffect(() => {
        if (!context.record && seed) policy.clearError();
    }, [context, seed]);
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
        return { ...value, ...values, ...acceptedCounts.current, id: value.id, cycle: { ...value.cycle, ...values.cycle }, quotaBytes: acceptedQuota.current, entryRateBps: acceptedRate.current };
    };
    const draftCopy = (): DraftCopy => structuredClone({ service: draft(), quotaGiB: acceptedQuota.current / 1024 ** 3, quotaText: pendingQuota.current ?? undefined, rateText: rawRateText.current, countText: countText.current, baseline: context.record });
    const invalidateLatest = () => {
        latestGeneration.current++;
        latestController.current?.abort();
        setLatest(null);
        setLatestError(null);
        setLatestPending(false);
    };
    const inputQuota = (text: string) => {
        invalidateLatest();
        policy.clearError();
        const bytes = serviceQuotaBytes(text);
        if (bytes !== undefined) acceptedQuota.current = bytes;
        pendingQuota.current = bytes === undefined ? text : null;
        setUnfinishedQuota(pendingQuota.current);
    };
    const discardQuota = () => {
        pendingQuota.current = null;
        setUnfinishedQuota(null);
        form.setFieldValue("quotaGiB", acceptedQuota.current / 1024 ** 3);
        setQuotaKey((key) => key + 1);
        invalidateLatest();
        policy.clearError();
    };
    const rateReady = () => pendingRate.current === null && Number.isSafeInteger(acceptedRate.current) && acceptedRate.current >= 0;
    const inputRate = (text: string) => {
        rawRateText.current = text;
        invalidateLatest();
        policy.clearError();
        const bytes = serviceRateBytes(text);
        if (bytes !== undefined) acceptedRate.current = bytes;
        pendingRate.current = bytes === undefined ? text : null;
        setUnfinishedRate(pendingRate.current);
    };
    const discardRate = () => {
        rawRateText.current = undefined;
        pendingRate.current = null;
        setUnfinishedRate(null);
        form.setFieldValue("entryRateBps", acceptedRate.current);
        setRateKey((key) => key + 1);
        invalidateLatest();
        policy.clearError();
    };
    const countReady = (field: CountField) => {
        const raw = countText.current[field];
        return raw === undefined
            ? Number.isSafeInteger(acceptedCounts.current[field]) && acceptedCounts.current[field] >= 0
            : serviceCountInteger(raw) !== undefined;
    };
    const countsReady = () => countFields.every(countReady);
    const inputCount = (field: CountField, text: string) => {
        countText.current = { ...countText.current, [field]: text };
        setRawCounts(countText.current);
        const count = serviceCountInteger(text);
        if (count !== undefined) acceptedCounts.current[field] = count;
        invalidateLatest();
        policy.clearError();
    };
    const discardCount = (field: CountField) => {
        const remaining = { ...countText.current };
        delete remaining[field];
        countText.current = remaining;
        setRawCounts(remaining);
        form.setFieldValue(field, acceptedCounts.current[field]);
        setCountKeys((keys) => ({ ...keys, [field]: keys[field] + 1 }));
        invalidateLatest();
        policy.clearError();
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
    return <TaskSheet returnFocus={props.returnFocus} title={context.precondition.exists ? `编辑 ${value.name}` : "新建服务方案"} open onOpenChange={open => {
            if (!open)
                (policy.requestClose)();
        }} pending={!(!policy.closingBlocked)} size="lg" bodyProps={{ className: "space-y-6" }}>
    {retained.length > 0 && <Accordion type="multiple">{(retained.map((saved, index) => ({ key: `${index}`, label: index === retained.length - 1 ? "\u4E0A\u4E00\u7248\u8349\u7A3F\uFF08\u672A\u4FDD\u5B58\uFF09" : `较早草稿 ${index + 1}（未保存）`, children: <>
      <ServicePolicyComparison resource={{ target: { kind: "service", id: saved.service.id }, before: saved.baseline, after: { service: saved.service } }} title="保留的草稿" showAll draftQuota={saved.quotaText !== undefined ? { value: saved.quotaText } : undefined} draftRate={saved.rateText !== undefined ? { value: saved.rateText } : undefined} draftCounts={saved.countText} beforeLabel="当时打开的版本" afterLabel="保留的草稿"/>
      <ActionButton onClick={() => discardRetained(index)} variant="destructive">丢弃此草稿副本</ActionButton>
    </> }))).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4">{section.children}</AccordionContent></AccordionItem>)}</Accordion>}
    <AppForm form={form} submitErrorFocusOwner={value} onFocusCapture={revealFocusedDrawerControl} onSubmitCapture={() => {
        // Remount the invalid field before Form validates, so its ordinary
        // submit-error owner can reveal and focus the actual editable control.
        if ((!rateReady() || !countsReady()) && !limitSections.includes("limits"))
            flushSync(() => setLimitSections(["limits"]));
    }} initialValues={{ ...value, onlineIpLimit: value.onlineIpLimit || 0, connectionLimit: value.connectionLimit || 0, entryRateBps: value.entryRateBps || 0, quotaGiB: !context.record && seed ? seed.quotaGiB : value.quotaBytes / 1024 ** 3 }} onValuesChange={() => { invalidateLatest(); policy.clearError(); }} onFinish={() => { if (!policy.closingBlocked && pendingQuota.current === null && rateReady() && countsReady()) policy.propose({ service: draft() }, context.precondition); }}>
      <ErrorNotice error={policy.error} focusRef={policy.errorFocusRef}/>
      {conflicted && <section className="space-y-4 rounded-lg border bg-muted/30 p-4" aria-label="处理方案版本变化">
        {!baselineConflictVisible && <p>草稿尚未保存，请核对最新版本。</p>}
        <ActionButton onClick={readLatest} pending={latestPending} disabled={policy.closingBlocked} variant="outline">查看最新版本</ActionButton>
        <ErrorNotice error={latestError}/>
        {latest && <>
          {latest.record ? <ServicePolicyComparison resource={{ target: latest.target, before: context.record, after: latest.record }} title="已保存的方案变化" beforeLabel="打开时保存" afterLabel="最新保存"/> : <p>{context.precondition.exists ? "方案已不存在，当前草稿不会自动新建同名方案。" : "方案仍未创建，可用当前草稿重新预览。"}</p>}
          {context.precondition.exists && latest.record && <ActionButton onClick={useLatest} disabled={policy.closingBlocked} variant="outline">使用最新版本重新编辑</ActionButton>}
          {!context.precondition.exists && latest.record && <ActionButton onClick={() => { if (pendingQuota.current === null && rateReady() && countsReady()) restartCreation(draftCopy()); }} disabled={policy.closingBlocked || unfinishedQuota !== null || unfinishedRate !== null || !countsReady()} variant="outline">使用新标识另建方案</ActionButton>}
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
                validator: () => pendingQuota.current === null && Number.isSafeInteger(acceptedQuota.current) && acceptedQuota.current >= 0
                    ? Promise.resolve()
                    : Promise.reject(new Error("额度必须能表示为安全范围内的整数字节")),
            },
        ]} trigger="onValueChange" validateTrigger="onInputText">
            <NumericInput min={0} max={Number.MAX_SAFE_INTEGER / 1024 ** 3} resetKey={quotaKey} onInputText={inputQuota}/>
          </AppField>
          {unfinishedQuota !== null && <div role="status" className="space-y-2">
            <p>额度输入「{unfinishedQuota}」无法表示为安全范围内的整数字节；当前额度为 {acceptedQuota.current} 字节。请修正输入，或保留当前额度。</p>
            <ActionButton onClick={discardQuota} variant="outline">放弃未完成输入，保留当前额度</ActionButton>
          </div>}
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
        <Accordion type="multiple" value={limitSections} onValueChange={setLimitSections}>{([
            {
                key: "limits",
                label: "\u5728\u7EBF\u3001\u5E76\u53D1\u4E0E\u901F\u7387\u9650\u5236",
                children: <LimitFields rateInput={{ onInput: inputRate, valid: rateReady, resetKey: rateKey, initialInputText: rawRateText.current }} countInputs={Object.fromEntries(countFields.map(field => [field, {
                    onInput: (text: string) => inputCount(field, text), valid: () => countReady(field), resetKey: countKeys[field], initialInputText: rawCounts[field],
                }]))}/>,
            },
        ]).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4 px-1" onAnimationEnd={revealFocusedDrawerControlAfterAccordionOpen}>{section.children}</AccordionContent></AccordionItem>)}</Accordion>
        {unfinishedRate !== null && <div role="status" className="space-y-2">
          <p>限速输入「{unfinishedRate}」暂不可用。请修正 Mbps 数值，或保留上一个有效限速。</p>
          <ActionButton onClick={discardRate} variant="outline">放弃本次输入，保留上一个有效限速</ActionButton>
        </div>}
        {countFields.filter(field => rawCounts[field] !== undefined && !countReady(field)).map(field => <div key={field} role="status" className="space-y-2">
          <p>{countLabels[field]}输入「{rawCounts[field]}」暂不可用。请填写非负整数，或保留上一个有效上限。</p>
          <ActionButton onClick={() => discardCount(field)} variant="outline">{field === "onlineIpLimit" ? "放弃输入，保留 IP 上限" : "放弃输入，保留并发上限"}</ActionButton>
        </div>)}

      <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <ActionButton disabled={policy.closingBlocked} onClick={policy.requestClose} variant="outline">取消</ActionButton>
        <ActionButton type="submit" aria-label="预览影响" aria-busy={policy.pending} keepFocusableWhilePending pending={policy.pending} variant="default">预览影响</ActionButton>
      </div>
    </AppForm>
    {policy.dialog}
  </TaskSheet>;
}
