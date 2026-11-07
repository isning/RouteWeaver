import { NumericInput } from "@/ui-patterns/numeric-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DataTable } from "./DataTable";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { TaskSheet, useTaskReturnFocus } from "@/ui-patterns/task-overlays";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Notice } from "@/ui-patterns/notice";
import { ChoiceSelect, MultiChoice } from "@/ui-patterns/choice-select";
import { ActionButton } from "@/ui-patterns/actions";
import { useConfirm } from "@/ui-patterns/confirmations";
import { useForm, AppField, AppForm } from "@/ui-patterns/form";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ByteQuantityInput } from "./ByteQuantityInput";
import { PolicyDateInput } from "./PolicyDateInput";
import { isPolicyTimestamp } from "./policy-date-model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, post, request } from "./api";
import { dateLabel } from "./model";
import type { Entitlement, Service, UserRecord } from "./types";
import type { EntitlementPolicyEditContext, NamedRecord } from "./access-policy-model";
import { loadEntitlementPolicyEditContext } from "./service-policy-edit";
import { EntitlementPolicyComparison } from "./EntitlementPolicyComparison";
import { revealFocusedDrawerControl, revealFocusedUsageResetControl } from "./drawer-control-visibility";
import { PolicySummary, usePolicyChange } from "./AccessPolicy";
import { ErrorNotice, QueryState, Section, KeyValue } from "./components";
import { CycleFields, wholeNumberRules, byteQuantityRules, } from "./PolicyFields";
// Go's zero time represents an implicit start, not a date chosen by the user.
const zeroStart = "0001-01-01T00:00:00Z";
const overrideFields = [
    { key: "quotaOverride", label: "个人周期额度（GiB）", unit: "GiB" },
    {
        key: "onlineIpLimitOverride",
        label: "个人在线 IP 数上限",
        unit: undefined,
    },
    {
        key: "connectionLimitOverride",
        label: "个人并发逻辑流数上限",
        unit: undefined,
    },
    { key: "entryRateBpsOverride", label: "个人入口限速（Mbps）", unit: "Mbps" },
] as const;
// Only edited decimal text is checked here. Stored values must never be
// reconstructed from the rounded GiB/Mbps display when another field changes.
function exactEditedInteger(text: string, scale: number): number | undefined {
    // A paste-size resource guard, not a quota/rate maximum. Keep oversized
    // edits pending rather than spending unbounded work on BigInt parsing.
    if (text.length > 4096)
        return undefined;
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(text.trim());
    if (!match)
        return undefined;
    const fraction = match[3] ?? match[4] ?? "";
    const digits = ((match[2] ?? "") + fraction).replace(/^0+/, "");
    if (!digits)
        return 0;
    if (match[1] === "-")
        return undefined;
    // Normalize and bound the exponent lexically before numeric conversion.
    // A nonzero coefficient of <=4096 digits cannot yield a safe integer with
    // an exponent outside this range. Zero was handled without conversion.
    const exponentText = (match[5] ?? "0").replace(/^([+-]?)0+/, "$1") || "0";
    if (exponentText.replace(/^[+-]/, "").length > 6)
        return undefined;
    const exponent = Number(exponentText === "+" || exponentText === "-" ? "0" : exponentText);
    try {
        const product = (BigInt(digits) * BigInt(scale)).toString();
        const significant = product.replace(/0+$/, "");
        const shift = exponent - fraction.length + product.length - significant.length;
        if (shift < 0 || significant.length + shift > 16)
            return undefined;
        const integer = BigInt(significant + "0".repeat(shift));
        return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : undefined;
    }
    catch {
        return undefined;
    }
}
type EditorProps = {
    user: UserRecord;
    services: Service[];
    routes: NamedRecord[];
    // Display metadata only; selectable managed routes remain in routes.
    displayRoutes?: NamedRecord[];
    onClose: () => void;
    returnFocus?: HTMLElement | null;
};
type DraftCopy = {
    values: Record<string, any>;
    context: EntitlementPolicyEditContext;
};
export function UserPolicyEditor(props: EditorProps) {
    const returnFocus = useTaskReturnFocus(props.returnFocus);
    const [context, setContext] = useState<EntitlementPolicyEditContext | null>(null);
    const [error, setError] = useState<Error | null>(null), [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let current = true;
        const controller = new AbortController();
        setError(null);
        setContext(null);
        loadEntitlementPolicyEditContext(props.user.id, controller.signal).then((value) => {
            if (current)
                setContext(value);
        }, (error) => {
            if (current)
                setError(error);
        });
        return () => { current = false; controller.abort(); };
    }, [props.user.id, attempt]);
    if (!context || context.target.id !== props.user.id)
        return <TaskSheet returnFocus={returnFocus} title={`${props.user.name} 的服务授权`} open onOpenChange={open => {
                if (!open)
                    (props.onClose)();
            }} size="lg" bodyProps={{ className: "space-y-6" }}>
    <QueryState loading={!error} error={error} retry={() => setAttempt((value) => value + 1)}><></></QueryState>
  </TaskSheet>;
    return <UserPolicyForm key={props.user.id} {...props} returnFocus={returnFocus} initial={context} drawer/>;
}
// This entry accepts a coherent context, never an effective-policy-only seed.
export function UserPolicyForm({ initial, drawer = false, ...props }: EditorProps & {
    initial: EntitlementPolicyEditContext;
    drawer?: boolean;
}) {
    const returnFocus = useTaskReturnFocus(props.returnFocus);
    const [context, setContext] = useState(initial), [generation, setGeneration] = useState(0), [retained, setRetained] = useState<DraftCopy[]>([]);
    return <UserPolicyFields key={generation} {...props} returnFocus={returnFocus} drawer={drawer} context={context} retained={retained} acceptLatest={(latest, draft) => { setRetained((values) => [...values, draft]); setContext(latest); setGeneration((value) => value + 1); }}/>;
}
function UserPolicyFields({ user, context, services, routes, displayRoutes = routes, onClose, retained, acceptLatest, drawer, returnFocus }: EditorProps & {
    drawer: boolean;
    context: EntitlementPolicyEditContext;
    retained: DraftCopy[];
    acceptLatest: (latest: EntitlementPolicyEditContext, draft: DraftCopy) => void;
}) {
    const [form] = useForm();
    const confirm = useConfirm();
    const [snapshot] = useState(() => structuredClone(context.effective));
    const [ent] = useState(() => structuredClone(context.record?.entitlement ?? context.effective.entitlement));
    const policy = usePolicyChange({ mode: "guarded-entitlement", users: [user], services, routes: displayRoutes, retainedDrafts: retained, onApplied: onClose });
    const implicitStart = ent.startsAt === zeroStart;
    const init: Record<string, unknown> = { ...ent, startsAt: implicitStart ? "" : ent.startsAt };
    for (const field of overrideFields) {
        init[`${field.key}Enabled`] = ent[field.key] != null;
        init[field.key] = ent[field.key] ?? 0;
    }
    init.serviceMode = ent.serviceId ? "custom" : "inherit";
    init.routeMode = ent.routeIdsOverride == null ? "inherit" : ent.routeIdsOverride.length ? "custom" : "deny";
    init.routeIdsOverride = ent.routeIdsOverride || [];
    const [latest, setLatest] = useState<EntitlementPolicyEditContext | null>(null), [latestError, setLatestError] = useState<Error | null>(null);
    const [latestPending, setLatestPending] = useState(false), [conflicted, setConflicted] = useState(false);
    const intent = useRef(0), latestController = useRef<AbortController | null>(null);
    const [dateOpen, setDateOpen] = useState<Record<string, boolean>>({});
    const openRef = useRef<Record<string, boolean>>({});
    const [unfinished, setUnfinished] = useState<Record<string, string>>({});
    const unfinishedRef = useRef<Record<string, string>>({});
    const [numberKeys, setNumberKeys] = useState<Record<string, number>>({});
    const blocked = () => Object.values(openRef.current).some(Boolean) || Object.keys(unfinishedRef.current).length > 0;
    const invalidate = (dirty = true) => { intent.current++; latestController.current?.abort(); setLatest(null); setLatestError(null); setLatestPending(false); policy.clearError(dirty); };
    useEffect(() => () => { intent.current++; latestController.current?.abort(); }, []);
    useEffect(() => {
        if (policy.error instanceof APIError && policy.error.status === 409)
            setConflicted(true);
    }, [policy.error]);
    const baselineConflictVisible = policy.error instanceof APIError && policy.error.status === 409 && typeof policy.error.details === "object" && policy.error.details !== null && "code" in policy.error.details && policy.error.details.code === "POLICY_EDIT_BASELINE_CHANGED";
    const fieldPath = (key: string) => key.startsWith("cycle.") ? key.split(".") : key;
    const inputNumber = (key: string, text: string, scale = 1) => {
        invalidate();
        const accepted = form.getFieldValue(fieldPath(key));
        const exact = exactEditedInteger(text, scale);
        const represented = text.trim() === "" ? accepted == null : exact !== undefined;
        // Controls emit Number(raw) first. Correct a representable decimal's
        // floating multiplication residue before validation/preview; invalid
        // raw text remains pending until correction or explicit discard.
        if (exact !== undefined && exact !== accepted)
            form.setFieldValue(fieldPath(key), exact);
        const next = { ...unfinishedRef.current };
        if (represented)
            delete next[key];
        else
            next[key] = text;
        unfinishedRef.current = next;
        setUnfinished(next);
    };
    const discardNumber = (key: string) => { const next = { ...unfinishedRef.current }; delete next[key]; unfinishedRef.current = next; setUnfinished(next); setNumberKeys((keys) => ({ ...keys, [key]: (keys[key] || 0) + 1 })); invalidate(); };
    const numberLabel = (key: string) => overrideFields.find((field) => field.key === key)?.label ?? (key === "cycle.day" ? "每月几号" : "每周期天数");
    const displayNumber = (key: string) => {
        const value = form.getFieldValue(fieldPath(key)), unit = overrideFields.find((field) => field.key === key)?.unit;
        return value == null ? "未填写" : String(typeof value === "number" ? value / (unit === "GiB" ? 1024 ** 3 : unit === "Mbps" ? 1000000 / 8 : 1) : value);
    };
    const unfinishedNotice = (key: string) => Object.hasOwn(unfinished, key) && <div role="status"><p>{numberLabel(key)}的输入「{unfinished[key]}」尚未完成；当前数值为 {displayNumber(key)}。</p><ActionButton onClick={() => discardNumber(key)} variant="outline">放弃未完成输入，保留当前数值</ActionButton></div>;
    const dateCallbacks = (key: string) => ({ onOpenChange: (open: boolean) => {
            openRef.current = { ...openRef.current, [key]: open };
            setDateOpen(openRef.current);
            if (open)
                invalidate(false);
        }, onPendingChange: (pending: boolean) => {
            if (pending)
                invalidate();
        } });
    // Capture eligibility before a pointer dismisses the picker. These actions
    // use aria-disabled, not native disabled, so their owned start always arrives.
    const commandStartedBlocked = useRef(false);
    const commandStart = () => { commandStartedBlocked.current = blocked() || policy.closingBlocked; };
    const commandAllowed = () => { const staleStart = commandStartedBlocked.current; commandStartedBlocked.current = false; return !staleStart && !blocked() && !policy.closingBlocked; };
    const commandProps = { onPointerDownCapture: commandStart, onKeyDownCapture: (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ")
                commandStart();
        },
        // Match themed disabled paint without suppressing the owned start event.
        className: blocked() || policy.closingBlocked ? "opacity-50 cursor-not-allowed" : undefined };
    const readLatest = async () => {
        latestController.current?.abort();
        const owner = ++intent.current, controller = new AbortController();
        latestController.current = controller;
        setLatest(null);
        setLatestError(null);
        setLatestPending(true);
        try {
            const value = await loadEntitlementPolicyEditContext(user.id, controller.signal);
            if (intent.current === owner)
                setLatest(value);
        }
        catch (error) {
            if (intent.current === owner)
                setLatestError(error as Error);
        }
        finally {
            if (intent.current === owner)
                setLatestPending(false);
        }
    };
    const useLatest = () => {
        if (!commandAllowed() || !latest)
            return;
        const incoming = latest, owner = intent.current, previous = structuredClone({ values: form.getFieldsValue(true), context });
        confirm({
            title: "使用最新版本重新编辑？", description: "编辑区将换成最新保存的个人授权。本次草稿会保留为未保存副本，不会自动合并。", confirmLabel: "使用最新版本", cancelLabel: "保留当前编辑",
            onConfirm: () => {
                if (owner === intent.current && !blocked() && !policy.closingBlocked)
                    acceptLatest(incoming, previous);
            }
        });
    };
    const submit = (submitted: Record<string, any>) => {
        if (blocked() || policy.closingBlocked)
            return;
        const full = form.getFieldsValue(true);
        const values = { ...full, ...submitted, cycle: { ...ent.cycle, ...full.cycle, ...submitted.cycle } };
        const entitlement: Entitlement = {
            ...ent,
            userId: user.id,
            serviceId: values.serviceMode === "custom" ? values.serviceId : "",
            startsAt: implicitStart && !values.startsAt ? ent.startsAt : values.startsAt,
            expiresAt: values.expiresAt || undefined,
            cycle: values.cycle,
            paused: values.paused || false,
            routeIdsOverride: values.routeMode === "inherit"
                ? null
                : values.routeMode === "deny"
                    ? []
                    : values.routeIdsOverride,
        };
        for (const field of overrideFields)
            entitlement[field.key] = values[`${field.key}Enabled`]
                ? values[field.key]
                : null;
        policy.propose({ entitlement }, context.precondition);
    };
    const content = (<>
      {retained.length > 0 && <Accordion type="multiple">{(retained.map((copy, index) => ({ key: String(index), label: `保留的草稿 ${index + 1}（未保存）`, children: <RetainedEntitlementDraft copy={copy}/> }))).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4">{section.children}</AccordionContent></AccordionItem>)}</Accordion>}
      <Section title="当前生效授权" variant="plain" className="rounded-lg border bg-muted/30 p-4">
        <p className="muted text-sm text-muted-foreground">
          这是已保存的授权。下方修改后，先预览影响，再确认应用。
        </p>
        <PolicySummary policy={snapshot} services={services} routes={displayRoutes} visibleFields={[
            "status",
            "service",
            "quotaBytes",
            "routes",
            "validity",
        ]}/>
        <Accordion type="multiple">{([
            {
                key: "effective-details",
                label: "\u67E5\u770B\u9650\u901F\u3001\u5E76\u53D1\u4E0E\u91CD\u7F6E\u5468\u671F",
                children: (<PolicySummary policy={snapshot} services={services} routes={displayRoutes} visibleFields={[
                        "onlineIpLimit",
                        "connectionLimit",
                        "entryRateBps",
                        "cycle",
                    ]}/>),
            },
        ]).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4">{section.children}</AccordionContent></AccordionItem>)}</Accordion>
      </Section>
      <AppForm form={form} initialValues={init} onValuesChange={() => invalidate()} onFocusCapture={revealFocusedDrawerControl} onKeyDownCapture={(event) => {
            if (event.key === "Enter" && blocked()) {
                event.preventDefault();
            }
        }} onFinish={submit}>
        <ErrorNotice error={policy.error} focusRef={policy.errorFocusRef}/>
        {conflicted && <section className="space-y-4 rounded-lg border bg-muted/30 p-4" aria-label="处理个人授权版本变化">
          {!baselineConflictVisible && <p>草稿尚未保存，请核对最新版本。</p>}
          <ActionButton onClick={readLatest} pending={latestPending} disabled={policy.closingBlocked} variant="outline">查看最新版本</ActionButton><ErrorNotice error={latestError}/>
          {latest && <>
            {latest.record ? <EntitlementPolicyComparison services={services} resource={{ target: latest.target, before: context.record, after: latest.record }} title="已保存的个人授权变化" beforeLabel="打开时保存" afterLabel="最新保存"/> : <p>目前尚无个人授权设置。重新编辑将采用最新生效值，不会自动保存。</p>}
            <ActionButton {...commandProps} aria-disabled={blocked() || policy.closingBlocked} onClick={useLatest} variant="outline">使用最新版本重新编辑</ActionButton>
          </>}
        </section>}
        {Object.values(dateOpen).some(Boolean) && <p role="status">请先确认或取消日期选择，再预览或重新编辑。</p>}
        <Section title="方案与线路" variant="plain">
          <AppField name="serviceMode" label="方案来源" trigger="onValueChange">
            <RadioGroup>{([
        { value: "inherit", label: "\u7EE7\u627F\u7528\u6237\u7EC4\u65B9\u6848" },
        { value: "custom", label: "\u6307\u5B9A\u4E2A\u4EBA\u65B9\u6848" },
    ]).map(option => <label key={option.value} className="flex items-center gap-2 text-sm"><RadioGroupItem value={option.value}/>{option.label}</label>)}</RadioGroup>
          </AppField>
          <AppField noStyle shouldUpdate={(a, b) => a.serviceMode !== b.serviceMode}>
            {({ getFieldValue }) => getFieldValue("serviceMode") === "custom" ? (<AppField name="serviceId" label="个人指定方案" rules={[
                {
                    required: true,
                    message: "请选择个人方案，或切换为继承用户组方案",
                },
            ]} trigger="onValueChange">
                  <ChoiceSelect placeholder="选择服务方案" options={services.map((s) => ({
                value: s.id,
                label: s.name,
            }))}/>
                </AppField>) : (<p className="muted text-sm text-muted-foreground">
                  使用最高优先级用户组的方案；没有用户组时，使用账号设置与直接授权。
                </p>)}
          </AppField>
          <AppField name="routeMode" label="线路授权方式" trigger="onValueChange">
            <RadioGroup>{([
        { value: "inherit", label: "\u7EE7\u627F\u7EBF\u8DEF\u6388\u6743" },
        { value: "custom", label: "\u6307\u5B9A\u4E2A\u4EBA\u7EBF\u8DEF" },
        { value: "deny", label: "\u7981\u6B62\u6240\u6709\u7EBF\u8DEF" },
    ]).map(option => <label key={option.value} className="flex items-center gap-2 text-sm"><RadioGroupItem value={option.value}/>{option.label}</label>)}</RadioGroup>
          </AppField>
          <AppField noStyle shouldUpdate={(a, b) => a.routeMode !== b.routeMode}>
            {({ getFieldValue }) => getFieldValue("routeMode") === "custom" ? (<AppField name="routeIdsOverride" label="个人授权线路" description="仅允许所选线路，替换方案与直接授权的线路。" rules={[
                {
                    required: true,
                    type: "array",
                    min: 1,
                    message: "请至少选择一条线路；如需停用线路，请选择“禁止所有线路”",
                },
            ]} trigger="onValueChange">
                  <MultiChoice placeholder="选择允许使用的线路" options={routes.map((r) => ({
                value: r.id,
                label: r.name,
            }))}/>
                </AppField>) : getFieldValue("routeMode") === "deny" ? (<Notice tone="warning" title="应用后，该用户将无法使用任何线路。"/>) : (<p className="muted text-sm text-muted-foreground">
                  沿用当前方案与直接授权的线路；最终可用线路会显示在影响预览中。
                </p>)}
          </AppField>
        </Section>
        <Section title="服务有效期" variant="plain" className="border-t pt-5">
          <div className="form-grid grid gap-5 sm:grid-cols-2">
            <AppField name="startsAt" label="开通时间" required={!implicitStart} description={implicitStart
            ? "留空保留现有开通时间。"
            : "选择日期和时间；保留其他授权设置。"} rules={[
            {
                validator: (_, value) => (implicitStart && !value) ||
                    (typeof value === "string" && isPolicyTimestamp(value))
                    ? Promise.resolve()
                    : Promise.reject(new Error("请填写有效的开通时间并包含时区，例如 2026-10-20T08:00:00+08:00")),
            },
        ]}>
              <PolicyDateInput {...dateCallbacks("startsAt")} allowClear={implicitStart} placeholder={implicitStart ? "未单独设置" : "选择开通时间"}/>
            </AppField>
            <AppField name="expiresAt" label="到期时间（留空为不过期）">
              <PolicyDateInput {...dateCallbacks("expiresAt")} placeholder="不过期"/>
            </AppField>
          </div>
          <AppField name="paused" label="暂停平台服务" trigger="onCheckedChange" valuePropName="checked">
            <Switch />
          </AppField>
          <p className="muted text-sm text-muted-foreground">
            续期后保留已有用量；切换方案或用户组时，账号继续沿用已有周期。
          </p>
        </Section>
        <Accordion type="multiple">{([
            {
                key: "overrides",
                label: "\u4E2A\u4EBA\u989D\u5EA6\u4E0E\u9650\u5236",
                children: (<>
                  <p className="muted text-sm text-muted-foreground">
                    开启后以个人设置替换继承值。关闭恢复继承；数字 0
                    表示明确不限制。
                  </p>
                  {overrideFields.map(field => (<div key={field.key} className="space-y-3 rounded-lg border p-4">
                      <AppField name={`${field.key}Enabled`} label={`覆盖${field.label}`} trigger="onCheckedChange" valuePropName="checked">
                        <Checkbox disabled={Object.hasOwn(unfinished, field.key)}/>
                      </AppField>
                      <AppField noStyle shouldUpdate={(a, b) => a[`${field.key}Enabled`] !== b[`${field.key}Enabled`]}>
                        {({ getFieldValue }) => getFieldValue(`${field.key}Enabled`) && (<AppField name={field.key} label={field.label} trigger={field.unit ? "onChange" : "onValueChange"} rules={field.unit ? byteQuantityRules : wholeNumberRules}>
                              {field.unit ? (<ByteQuantityInput unit={field.unit} inputResetKey={numberKeys[field.key]} onInput={text => inputNumber(field.key, text, field.unit === "GiB" ? 1024 ** 3 : 1000000 / 8)}/>) : (<NumericInput key={numberKeys[field.key]} onInputText={text => inputNumber(field.key, text)} min={0} max={Number.MAX_SAFE_INTEGER}/>)}
                            </AppField>)}
                      </AppField>
                      {unfinishedNotice(field.key)}
                    </div>))}
                  <p className="muted text-sm text-muted-foreground">
                    在线 IP
                    跨入口去重；并发逻辑流跨入口累加，并不是设备数量。每个逻辑入口的速率由上下行与所有流共用。
                  </p>
                </>),
            },
            {
                key: "cycle",
                label: "\u9AD8\u7EA7\uFF1A\u8D26\u53F7\u6D41\u91CF\u5468\u671F",
                children: (<>
                  <CycleFields modeDisabled={Object.hasOwn(unfinished, "cycle.day") || Object.hasOwn(unfinished, "cycle.days")} numericControls={{ day: { onInput: text => inputNumber("cycle.day", text), resetKey: numberKeys["cycle.day"] }, days: { onInput: text => inputNumber("cycle.days", text), resetKey: numberKeys["cycle.days"] } }}/>
                  {unfinishedNotice("cycle.day")}{unfinishedNotice("cycle.days")}
                  <p className="muted text-sm text-muted-foreground">
                    周期变更可能改变后续重置日期，请在影响预览中核对。
                  </p>
                </>),
            },
        ]).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4">{section.children}</AccordionContent></AccordionItem>)}</Accordion>
        <div className="form-footer flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <ActionButton disabled={policy.closingBlocked} onClick={policy.requestClose} variant="outline">
            取消
          </ActionButton>
          <ActionButton {...commandProps} type="button" aria-disabled={blocked() || policy.closingBlocked} onClick={() => {
            if (commandAllowed())
                form.submit();
        }} aria-label="预览影响" aria-busy={policy.pending} keepFocusableWhilePending pending={policy.pending} variant="default">
            预览影响
          </ActionButton>
        </div>
      </AppForm>
      {policy.dialog}
    </>);
    return drawer ? <TaskSheet returnFocus={returnFocus} title={`${user.name} 的服务授权`} open onOpenChange={open => {
            if (!open)
                (policy.requestClose)();
        }} pending={!(!policy.closingBlocked)} size="lg" bodyProps={{ className: "space-y-6" }}>
    {content}<AdmissionStatus user={user}/><UsageReset user={user}/>
  </TaskSheet> : content;
}
function RetainedEntitlementDraft({ copy }: {
    copy: DraftCopy;
}) {
    const values = copy.values;
    const rows: [
        string,
        unknown
    ][] = [["方案来源", values.serviceMode], ["个人方案（ID，含未启用值）", values.serviceId], ["线路授权方式", values.routeMode], ["个人线路（ID，含未启用值）", values.routeIdsOverride], ["开通时间", values.startsAt], ["到期时间", values.expiresAt], ["暂停平台服务", values.paused]];
    for (const field of overrideFields) {
        rows.push([`覆盖${field.label}`, values[`${field.key}Enabled`]], [field.unit ? `${field.key === "quotaOverride" ? "个人周期额度（字节）" : "个人入口限速（字节/秒）"}，含未启用值` : `${field.label}（表单保存值）`, values[field.key]]);
    }
    for (const [key, label] of [["mode", "流量重置规则"], ["day", "每月几号"], ["days", "每周期天数"], ["anchor", "周期起点"], ["timezone", "周期时区"]])
        rows.push([label, values.cycle?.[key]]);
    return <section aria-label="保留的个人授权草稿" className="space-y-4 text-sm [overflow-wrap:anywhere]"><p>未保存的表单设置；未启用的输入也保留在此，不会自动合并。</p><dl className="divide-y">{rows.map(([label, value]) => <div key={label} className="grid gap-1 py-3 sm:grid-cols-2 sm:gap-4"><dt className="text-muted-foreground">{label}</dt><dd>{value === undefined ? "未设置" : value === "" ? "留空" : JSON.stringify(value)}</dd></div>)}</dl>
    <details><summary>当时打开的个人设置</summary><pre className="mt-3 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(copy.context.record, null, 2)}</pre></details>
  </section>;
}
function UsageReset({ user }: {
    user: UserRecord;
}) {
    const confirmReset = useConfirm();
    const [reason, setReason] = useState("");
    const message = toast, client = useQueryClient();
    const reset = useMutation({
        mutationFn: () => post(`/users/${user.id}/reset`, { reason }),
        onSuccess: () => {
            setReason("");
            client.invalidateQueries({ queryKey: ["overview"] });
            message.success("本周期用量已重置，历史记录与下次自动重置时间保留");
        },
    });
    return (<div data-policy-usage-reset onFocusCapture={revealFocusedUsageResetControl}>
    <Section title="手动重置用量">
      <p className="muted text-sm text-muted-foreground">
        清零本周期已用额度，保留历史记录与下次自动重置时间。
      </p>
      <ErrorNotice error={reset.error}/>
      <Textarea aria-label="重置原因" placeholder="记录重置原因" value={reason} onChange={(e) => setReason(e.target.value)}/>
      
        <ActionButton onClick={() => confirmReset({ title: `重置「${user.name}」的本周期用量？`, description: "本周期已用额度会清零，历史与自动重置日期保留。", confirmLabel: "确认重置", cancelLabel: "取消", destructive: true, onConfirm: () => reset.mutateAsync() })} disabled={!reason.trim()} pending={reset.isPending} className="mt-3.5" variant="destructive">
          重置本周期用量
        </ActionButton>
      
    </Section>
    </div>);
}
function AdmissionStatus({ user }: {
    user: UserRecord;
}) {
    const query = useQuery({
        queryKey: ["admission-status", user.id],
        queryFn: () => request<{
            asOf: string;
            maxLeaseSeconds: number;
            onlineIps: string[];
            activeStreams: number;
            entries: {
                instanceId: string;
                entryId: string;
                activeStreams: number;
                latestExpiry: string;
            }[];
        }>(`/users/${user.id}/admission-status`),
    });
    return (<Accordion type="multiple">{([
            {
                key: "online",
                label: "\u5F53\u524D\u5728\u7EBF IP \u4E0E\u5E76\u53D1\u6D41",
                children: (<>
              <ActionButton onClick={() => query.refetch()} pending={query.isFetching} variant="outline">
                刷新在线情况
              </ActionButton>
              <QueryState loading={query.isPending} paused={query.isPaused} loadingLayout="summary" error={query.error} retry={() => query.refetch()}>
                {query.data && (<>
                    <div className="space-y-1 text-sm text-muted-foreground">
                      <p>截至 {dateLabel(query.data.asOf)}</p>
                      <p>
                        按有效接入租约统计；断开但尚未回报的流最多保留{" "}
                        {query.data.maxLeaseSeconds} 秒。
                      </p>
                    </div>
                    <KeyValue label="在线 IP">
                      {query.data.onlineIps.length ? query.data.onlineIps.join("\u3001") : "\u65E0\u6709\u6548\u5728\u7EBF IP"}
                    </KeyValue>
                    <KeyValue label="并发逻辑流">
                      {query.data.activeStreams} 条
                    </KeyValue>
                    <DataTable rowKey={r => `${r.instanceId}-${r.entryId}`} rows={query.data.entries} columns={[
                            { title: "\u903B\u8F91\u5165\u53E3", accessor: "entryId" },
                            { title: "\u5E76\u53D1\u6D41", accessor: "activeStreams" },
                            {
                                title: "\u63A5\u5165\u6709\u6548\u81F3",
                                render: (_, r) => dateLabel(r.latestExpiry),
                            },
                        ]} pageSize={0} compact/>
                  </>)}
              </QueryState>
            </>),
            },
        ]).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-4">{section.children}</AccordionContent></AccordionItem>)}</Accordion>);
}
