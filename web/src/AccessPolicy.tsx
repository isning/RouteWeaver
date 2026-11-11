import { Metadata } from "@/ui-patterns/metadata";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { PageNavigation } from "@/ui-patterns/page-navigation";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { Notice } from "@/ui-patterns/notice";
import { ActionButton } from "@/ui-patterns/actions";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { DataTable, TableRowActions } from "./DataTable";
import { previewEntitlementPolicyEdit, previewGroupPolicyEdit, previewServicePolicyEdit } from "./service-policy-edit";
import { revealFocusedPolicyModalControl, wrapPolicyModalTab } from "./drawer-control-visibility";
import { ServicePolicyComparison } from "./ServicePolicyComparison";
import { EntitlementPolicyComparison } from "./EntitlementPolicyComparison";
import { GroupPolicyComparison } from "./GroupPolicyComparison";
import { GroupPolicyEditor } from "./GroupPolicyEditor";
import { invalidateOutputInputs } from "./output-comparison";
import { useUnsavedChanges } from "./navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, list, post } from "./api";
import { bytesLabel, bitrateLabel, dateLabel } from "./model";
import { EmptyState, ErrorNotice, KeyValue, QueryState, Section, type ErrorNoticeFocusHandle, } from "./components";
import type { Service, UserRecord } from "./types";
import { policyDifferenceFields, policySource, policyStatus, type EffectivePolicy, type NamedRecord, type PolicyChange, type PolicyEditPrecondition, type PolicyPreview, type ServicePolicyResource, type GroupPolicyResource, type EntitlementPolicyResource, type PolicySummaryField, type UserGroup, } from "./access-policy-model";
type PolicyDisplayField = {
    key: PolicySummaryField;
    label: string;
    value: string;
    detail?: string | string[];
    statusColor?: "green" | "orange";
};
// Display formatting is shared by the saved summary and the paired review.
// Exact comparison remains the responsibility of policyDifferenceFields.
function policyDisplayFields(policy: EffectivePolicy, services: NamedRecord[], routes: NamedRecord[]): PolicyDisplayField[] {
    const serviceId = policy.serviceId;
    const serviceName = serviceId
        ? (policy.service?.id === serviceId ? policy.service.name : undefined) ||
            services.find((service) => service.id === serviceId)?.name ||
            serviceId
        : "无方案";
    const values: [
        string,
        string,
        PolicySummaryField
    ][] = [
        ["服务方案", serviceName, "service"],
        [
            "周期额度",
            policy.quotaBytes ? bytesLabel(policy.quotaBytes) : "不限额",
            "quotaBytes",
        ],
        [
            "在线 IP 上限",
            policy.onlineIpLimit ? `${policy.onlineIpLimit} 个` : "不限制",
            "onlineIpLimit",
        ],
        [
            "并发逻辑流上限",
            policy.connectionLimit ? `${policy.connectionLimit} 条` : "不限制",
            "connectionLimit",
        ],
        [
            "每个逻辑入口速率",
            policy.entryRateBps ? bitrateLabel(policy.entryRateBps) : "不限制",
            "entryRateBps",
        ],
        [
            "授权线路",
            (policy.routeIds || [])
                .map((id) => {
                // Legacy and managed routes cannot share a service identity.
                // An inconsistent catalog must not silently choose either name.
                const matches = routes.filter((route) => route.id === id);
                return matches.length === 1 ? matches[0].name || id : id;
            })
                .join("、") || "无",
            "routes",
        ],
    ];
    return [
        {
            key: "status",
            label: "状态",
            value: policyStatus[policy.status] || policy.status,
            statusColor: policy.status === "active" ? "green" : "orange",
        },
        ...values.map(([label, value, key]) => ({
            key,
            label,
            value,
            detail: policySource(policy.provenance[key], services, policy.service),
        })),
        {
            key: "validity",
            label: "开通 / 到期",
            value: `${dateLabel(policy.entitlement.startsAt)} / ${policy.entitlement.expiresAt ? dateLabel(policy.entitlement.expiresAt) : "不过期"}`,
        },
        {
            key: "cycle",
            label: "账号周期",
            value: {
                monthly: `每月 ${policy.entitlement.cycle.day || 1} 日`,
                anniversary: "按周期起点日每月重置",
                "fixed-days": `每 ${policy.entitlement.cycle.days} 天`,
                none: "不自动重置",
            }[policy.entitlement.cycle.mode] || policy.entitlement.cycle.mode,
            detail: policy.entitlement.cycle.anchor
                ? [`起点 ${dateLabel(policy.entitlement.cycle.anchor)}`, `时区 ${policy.entitlement.cycle.timezone || "UTC+8"}`]
                : undefined,
        },
    ];
}
function PolicyFieldValue({ field }: {
    field: PolicyDisplayField;
}) {
    if (field.key === "status")
        return <Badge variant="secondary">{field.value}</Badge>;
    return (<>
      <span>{field.value}</span>
      {field.detail && field.detail !== field.value && (<small className="muted block text-sm text-muted-foreground" >
          {Array.isArray(field.detail) ? <Metadata>{field.detail.map((item) => <span key={item}>{item}</span>)}</Metadata> : field.detail}
        </small>)}
    </>);
}
export function PolicySummary({ policy, services, routes, visibleFields, }: {
    policy: EffectivePolicy;
    services: NamedRecord[];
    routes: NamedRecord[];
    visibleFields?: PolicySummaryField[];
}) {
    const fields = policyDisplayFields(policy, services, routes).filter((field) => !visibleFields || visibleFields.includes(field.key));
    if (visibleFields?.length === 0)
        return <p className="muted text-sm text-muted-foreground">当前生效授权保持不变</p>;
    const row = (field: PolicyDisplayField) => (<KeyValue key={field.key} label={field.label}>
      <PolicyFieldValue field={field}/>
    </KeyValue>);
    return (<div className="space-y-3">
      {fields
            .filter((field) => field.key === "status")
            .map((field) => (<PolicyFieldValue key={field.key} field={field}/>))}
      <div className="key-value-list grid gap-3">
        {fields
            .filter((field) => !["status", "validity", "cycle"].includes(field.key))
            .map(row)}
      </div>
      {fields
            .filter((field) => ["validity", "cycle"].includes(field.key))
            .map(row)}
    </div>);
}
const policyLimitFields: PolicySummaryField[] = [
    "quotaBytes", "onlineIpLimit", "connectionLimit", "entryRateBps",
];
function sourceServiceId(source: string | undefined) {
    const value = source?.endsWith("+direct") ? source.slice(0, -7) : source;
    return value?.startsWith("service:") ? value.slice(8) : undefined;
}
// Consolidate only explicit numeric sources whose identity is known in this
// review. Catalog/ID fallbacks stay local; display-string equality is not proof.
function sharedLimitSource(policy: EffectivePolicy, fields: PolicyDisplayField[]) {
    const source = policy.provenance[fields[0].key];
    if (!source || fields.some((field) => policy.provenance[field.key] !== source))
        return undefined;
    if (source === "individual" || source === "account")
        return source;
    const serviceId = sourceServiceId(source);
    if (serviceId && source === `service:${serviceId}` &&
        policy.service?.id === serviceId && policy.service.name)
        return source;
    return undefined;
}
function PolicyComparison({ effect, userName, showUserId, services, routes, showFull, }: {
    effect: PolicyPreview["affected"][number];
    userName: string;
    showUserId?: boolean;
    services: NamedRecord[];
    routes: NamedRecord[];
    showFull: boolean;
}) {
    const id = useId();
    const before = policyDisplayFields(effect.before, services, routes);
    const after = policyDisplayFields(effect.after, services, routes);
    const visibleFields = showFull
        ? undefined
        : policyDifferenceFields(effect.before, effect.after);
    const fields = before.filter((field) => !visibleFields || visibleFields.includes(field.key));
    const limits = fields.filter((field) => policyLimitFields.includes(field.key));
    const grouped = limits.length > 1;
    const beforeSource = grouped ? sharedLimitSource(effect.before, limits) : undefined;
    const afterSource = grouped ? sharedLimitSource(effect.after, limits) : undefined;
    const sharedSources = [beforeSource !== undefined, afterSource !== undefined];
    const hasSharedSource = sharedSources.some(Boolean);
    const identitiesByLabel = new Map<string, Set<string>>();
    const identityLabel = (reference: string, policy: EffectivePolicy) => policySource(`service:${reference}`, services, policy.service);
    const sourceReference = (field: PolicyDisplayField, policy: EffectivePolicy) => ["service", "routes", ...policyLimitFields].includes(field.key)
        ? sourceServiceId(policy.provenance[field.key])
        : undefined;
    for (const policy of [effect.before, effect.after]) {
        for (const field of fields) {
            for (const reference of [
                field.key === "service" ? policy.serviceId : undefined,
                sourceReference(field, policy),
            ]) {
                if (!reference)
                    continue;
                const label = identityLabel(reference, policy);
                const identities = identitiesByLabel.get(label) || new Set<string>();
                identities.add(reference);
                identitiesByLabel.set(label, identities);
            }
        }
    }
    const disambiguate = (field: PolicyDisplayField, policy: EffectivePolicy) => {
        let value = field;
        if (field.key === "service" && policy.serviceId &&
            (identitiesByLabel.get(identityLabel(policy.serviceId, policy))?.size || 0) > 1)
            value = { ...value, value: `${value.value}（ID：${policy.serviceId}）` };
        const reference = sourceReference(field, policy);
        if (reference &&
            (identitiesByLabel.get(identityLabel(reference, policy))?.size || 0) > 1)
            value = { ...value, detail: `${value.detail}（ID：${reference}）` };
        return value;
    };
    const pair = (field: PolicyDisplayField) => {
        return [
            disambiguate(field, effect.before),
            disambiguate(after.find((value) => value.key === field.key)!, effect.after),
        ];
    };
    const sourcePair = hasSharedSource ? pair(limits[0]) : undefined;
    const renderRow = (field: PolicyDisplayField) => {
        const isLimit = policyLimitFields.includes(field.key);
        return (<TableRow role="row" key={field.key}>
        <TableHead scope="row" role="rowheader" id={`${id}-${field.key}`}>{field.label}</TableHead>
        {pair(field).map((value, index) => {
                const column = index === 0 ? "before" : "after";
                const shared = isLimit && sharedSources[index];
                return (<TableCell className="whitespace-normal [overflow-wrap:anywhere]" key={column} role="cell" aria-label={!shared && value.detail && value.detail !== value.value ? `${value.value} ${Array.isArray(value.detail) ? value.detail.join(" ") : value.detail}` : undefined} headers={`${id}-${field.key} ${id}-${column}`} aria-describedby={shared ? `${id}-source-${column}` : undefined}>
              <PolicyFieldValue field={shared ? { ...value, detail: undefined } : value}/>
            </TableCell>);
            })}
      </TableRow>);
    };
    const firstLimit = grouped ? fields.indexOf(limits[0]) : -1;
    const lastLimit = grouped ? fields.indexOf(limits[limits.length - 1]) : -1;
    return (<section className="policy-comparison-user space-y-3" aria-labelledby={`${id}-user`}>
      <h3 id={`${id}-user`} aria-label={showUserId ? `${userName}，账号标识：${effect.userId}` : undefined}>{userName}{showUserId && <span className="block text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]"> 账号标识：<code>{effect.userId}</code></span>}</h3>
      {fields.length ? (<Table className="policy-comparison-table w-full table-fixed text-sm [&_th]:p-2 [&_td]:p-2 sm:[&_th]:p-3 sm:[&_td]:p-3 [&_th]:whitespace-normal [&_td]:whitespace-normal [&_th]:[overflow-wrap:anywhere] [&_td]:[overflow-wrap:anywhere] [&_th]:text-left [&_th]:font-medium [&_td]:align-top [&_tr]:border-b [&_thead]:bg-muted/50 [&_td]:break-words" role="table" aria-labelledby={`${id}-user`}>
          <TableHeader role="rowgroup">
            <TableRow role="row">
              <TableHead scope="col" role="columnheader" className="policy-comparison-field-heading text-left font-medium">
                授权项
              </TableHead>
              <TableHead scope="col" role="columnheader" id={`${id}-before`}>
                变更前
              </TableHead>
              <TableHead scope="col" role="columnheader" id={`${id}-after`}>
                变更后
              </TableHead>
            </TableRow>
          </TableHeader>
          {grouped ? (<>
              {firstLimit > 0 && <TableBody role="rowgroup">{fields.slice(0, firstLimit).map(renderRow)}</TableBody>}
              <TableBody role="rowgroup" aria-labelledby={`${id}-limits`}>
                <TableRow role="row">
                  <TableHead scope="rowgroup" role="rowheader" colSpan={3} className="policy-comparison-group-heading text-left text-sm font-semibold" id={`${id}-limits`}>周期额度与访问限制</TableHead>
                </TableRow>
                {sourcePair && (<TableRow role="row" className="policy-comparison-source text-xs text-muted-foreground">
                    <TableHead scope="row" role="rowheader" id={`${id}-source`}>
                      {sharedSources.every(Boolean) && beforeSource !== afterSource ? "来源变更" : "来源"}
                    </TableHead>
                    {sourcePair.map((value, index) => {
                        const column = index === 0 ? "before" : "after";
                        return <TableCell className="whitespace-normal [overflow-wrap:anywhere]" key={column} role="cell" id={`${id}-source-${column}`} headers={`${id}-source ${id}-${column}`}>{sharedSources[index] ? value.detail : "见各项"}</TableCell>;
                    })}
                  </TableRow>)}
                {limits.map(renderRow)}
              </TableBody>
              {lastLimit < fields.length - 1 && <TableBody role="rowgroup">{fields.slice(lastLimit + 1).map(renderRow)}</TableBody>}
            </>) : <TableBody role="rowgroup">{fields.map(renderRow)}</TableBody>}
        </Table>) : (<p className="muted text-sm text-muted-foreground">当前生效授权保持不变</p>)}
    </section>);
}
// A separate task can share the editor's lifetime without entering policy data.
export type PolicyCloseCompanion = {
    pending: boolean;
    dirty: boolean;
    revision: unknown;
    label: string;
    discardDescription: string;
};
export function usePolicyChange({ mode, retainedDrafts, users, services, routes, onApplied, closeCompanion, }: {
    mode: "guarded-service" | "guarded-group" | "guarded-entitlement" | "legacy-replacement";
    retainedDrafts?: readonly object[];
    closeCompanion?: PolicyCloseCompanion;
    users: NamedRecord[];
    services: NamedRecord[];
    routes: NamedRecord[];
    onApplied: () => void;
}) {
    type ReviewTarget = {
        kind: "服务方案" | "用户组" | "用户";
        id: string;
        name: string;
    };
    const client = useQueryClient(), message = toast;
    const { confirm: confirmDiscard, confirming } = useDiscardConfirmation(useId());
    const [review, setReview] = useState<{
        change: PolicyChange;
        preview: PolicyPreview;
        target: ReviewTarget | null;
    } | null>(null), [confirmed, setConfirmed] = useState(false), [showFull, setShowFull] = useState(false), [showRules, setShowRules] = useState(false), [reviewPage, setReviewPage] = useState(1), [error, setError] = useState<Error | null>(null);
    const [reviewClosed, setReviewClosed] = useState(true);
    const appliedReview = useRef<number | null>(null);
    const hasRetainedDraft = !!retainedDrafts?.length;
    // Disposal consent belongs to this exact local copy set, not merely its count.
    useLayoutEffect(() => setConfirmed(false), [retainedDrafts, closeCompanion?.revision]);
    const [failureFocus, setFailureFocus] = useState<{
        error: Error;
        version: number;
        context: "editor" | "review";
    } | null>(null);
    const consumedFocus = useRef<typeof failureFocus>(null);
    const editorErrorFocus = useRef<ErrorNoticeFocusHandle>(null);
    const reviewErrorFocus = useRef<ErrorNoticeFocusHandle>(null);
    const [dirty, setDirty] = useState(false);
    const draftRevision = useRef(0);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; draftRevision.current++; };
    }, []);
    const requestFailureFocus = (error: Error, version: number, context: "editor" | "review") => {
        // Session recovery owns authentication failures. A stale local proposal
        // cannot move focus even if its transport callback still completes.
        if (version !== draftRevision.current ||
            (error instanceof APIError && [401, 403].includes(error.status)))
            return;
        setFailureFocus({ error, version, context });
    };
    const preview = useMutation({
        mutationFn: ({ change, precondition, }: {
            change: PolicyChange;
            precondition?: PolicyEditPrecondition;
            version: number;
            target: ReviewTarget | null;
        }) => mode === "guarded-service"
            ? previewServicePolicyEdit(change, precondition)
            : mode === "guarded-group"
                ? previewGroupPolicyEdit(change, precondition)
                : mode === "guarded-entitlement"
                    ? previewEntitlementPolicyEdit(change, precondition)
                    : mode === "legacy-replacement"
                        ? post<PolicyPreview>("/access-policy/preview", change)
                        : Promise.reject(new APIError("未指定授权编辑方式，当前草稿尚未保存。", 428)),
        onSuccess: (result, { change, version, target }) => {
            if (!mounted.current || version !== draftRevision.current)
                return;
            setFailureFocus(null);
            setError(null);
            setConfirmed(false);
            setShowFull(false);
            setShowRules(false);
            setReviewPage(1);
            setReviewClosed(false);
            setReview({ change, preview: result, target });
        },
        onError: (error, { version }) => {
            if (mounted.current && version === draftRevision.current) {
                setError(error);
                requestFailureFocus(error, version, review ? "review" : "editor");
            }
        },
    });
    const refreshPolicyData = () => {
        for (const queryKey of [
            ["admin-state"],
            ["user-groups"],
            ["effective-policy"],
            ["entitlement"],
            ["overview"],
            ["platform-entries"],
        ])
            client.invalidateQueries({ queryKey });
    };
    const apply = useMutation({
        onMutate: () => {
            const version = draftRevision.current;
            invalidateOutputInputs(client);
            return { version };
        },
        onSettled: () => invalidateOutputInputs(client),
        mutationFn: () => post<PolicyPreview>("/access-policy/apply", {
            change: review!.change,
            revision: review!.preview.revision,
        }),
        onSuccess: (_result, _variables, owner) => {
            refreshPolicyData();
            if (!mounted.current || owner?.version !== draftRevision.current)
                return;
            setFailureFocus(null);
            appliedReview.current = owner.version;
            setReview(null);
            setError(null);
            message.success("平台授权已更新");
        },
        onError: (e, _variables, owner) => {
            // This exact server contract is emitted only after the policy commit.
            // Generic 500s, transport failures and message-only matches are not
            // evidence of a committed policy.
            const auditMissing = e instanceof APIError && e.status === 500 &&
                typeof e.details === "object" && e.details !== null &&
                "detail" in e.details && e.details.detail === "policy applied; audit could not be recorded";
            if (auditMissing)
                refreshPolicyData();
            if (!mounted.current || owner?.version !== draftRevision.current)
                return;
            if (auditMissing) {
                const warning = new Error("平台授权已更新，但审计记录未能保存。请核对最新授权和审计记录，不要重复提交本次变更。当前输入和保留的草稿未清除。");
                // Retire the consumed review without invoking onApplied: that
                // callback closes editors and discards their retained drafts.
                appliedReview.current = null;
                setReview(null);
                setConfirmed(false);
                setError(warning);
                requestFailureFocus(warning, owner.version, "editor");
                return;
            }
            setError(e);
            if (e instanceof APIError && e.status === 409) {
                setReview(null);
                setConfirmed(false);
            }
            if (owner)
                requestFailureFocus(e, owner.version, e instanceof APIError && e.status === 409 ? "editor" : "review");
        },
    });
    useLayoutEffect(() => {
        if (!failureFocus || consumedFocus.current === failureFocus)
            return;
        const currentContext = review ? "review" : "editor";
        if (failureFocus.error !== error || failureFocus.version !== draftRevision.current ||
            failureFocus.context !== currentContext) {
            consumedFocus.current = failureFocus;
            setFailureFocus(null);
            return;
        }
        if (preview.isPending || apply.isPending)
            return;
        // rc-dialog restores the trigger before afterOpenChange(false). Only this
        // known closing lifecycle may defer the editor handoff after a 409.
        if (failureFocus.context === "editor" && !reviewClosed)
            return;
        consumedFocus.current = failureFocus;
        (failureFocus.context === "review" ? reviewErrorFocus : editorErrorFocus).current?.focus();
        // Hidden, inactive or absent targets are dropped, never retried on a later
        // catalog render, session recovery or manual editing action.
        setFailureFocus(null);
    }, [failureFocus, error, review, reviewClosed, preview.isPending, apply.isPending]);
    useUnsavedChanges(dirty || hasRetainedDraft || preview.isPending || apply.isPending);
    const propose = (change: PolicyChange, precondition?: PolicyEditPrecondition) => {
        if (closeCompanion?.pending) return;
        setFailureFocus(null);
        setError(null);
        const proposedChange = structuredClone(change);
        // Freeze display context with the submitted change, not later catalog reads.
        // This metadata is local to review and never part of the API payload.
        const target: ReviewTarget | null = proposedChange.service
            ? {
                kind: "服务方案",
                id: proposedChange.service.id,
                name: proposedChange.service.name,
            }
            : proposedChange.group
                ? {
                    kind: "用户组",
                    id: proposedChange.group.id,
                    name: proposedChange.group.name,
                }
                : proposedChange.entitlement
                    ? {
                        kind: "用户",
                        id: proposedChange.entitlement.userId,
                        name: users.find((user) => user.id === proposedChange.entitlement?.userId)?.name || "",
                    }
                    : null;
        preview.mutate({
            change: proposedChange,
            precondition: precondition ? structuredClone(precondition) : undefined,
            version: ++draftRevision.current,
            target,
        });
    };
    const dismissReview = () => {
        setFailureFocus(null);
        setReview(null);
    };
    // Disambiguate against the whole review, not just its current page.
    // Missing catalog records use their ID and participate in label collisions.
    const accountLabel = (id: string) => users.find(user => user.id === id)?.name || id;
    const accountIdentities = new Map<string, Set<string>>();
    for (const effect of review?.preview.affected ?? []) {
        const label = accountLabel(effect.userId);
        const ids = accountIdentities.get(label) ?? new Set<string>();
        ids.add(effect.userId);
        accountIdentities.set(label, ids);
    }
    const dialog = (<TaskDialog title="确认授权变更" bodyProps={{ className: "space-y-5" }} open={!!review} footer={<div className={"flex flex-wrap items-center gap-2"}>
          <ActionButton disabled={apply.isPending} onClick={dismissReview} variant="outline">
            返回编辑
          </ActionButton>
          <ActionButton disabled={!confirmed || !!review?.preview.blockers?.length || !!closeCompanion?.pending} aria-label="更新授权" aria-busy={apply.isPending} keepFocusableWhilePending pending={apply.isPending} onClick={() => { if (!closeCompanion?.pending) apply.mutate(); }} variant="default">
            更新授权
          </ActionButton>
        </div>} onOpenChange={open => {
            if (!open)
                (() => !apply.isPending && dismissReview())();
        }} pending={!(!apply.isPending)} size="xl" onReady={() => (open => setReviewClosed(!open))(true)} onClosed={() => {
            setReviewClosed(true);
            const version = appliedReview.current;
            appliedReview.current = null;
            // Release review focus before removing its owning editor.
            if (version !== null && mounted.current && version === draftRevision.current)
                onApplied();
        }} contentProps={review ? { onFocusCapture: revealFocusedPolicyModalControl, onKeyDown: wrapPolicyModalTab } : undefined}>
      {review && (<>
          <ErrorNotice error={error} focusRef={reviewErrorFocus}/>
          {review.target && (<p>
              <strong>
                {review.target.kind}：{review.target.name || review.target.id}
              </strong>
            </p>)}
          {review.preview.resource?.target.kind === "service" && <ServicePolicyComparison resource={review.preview.resource as ServicePolicyResource}/>}
          {review.preview.resource?.target.kind === "group" && <GroupPolicyComparison resource={review.preview.resource as GroupPolicyResource}/>}
          {review.preview.resource?.target.kind === "entitlement" && <EntitlementPolicyComparison resource={review.preview.resource as EntitlementPolicyResource} services={services}/>}
          {review.preview.resource?.target.kind === "entitlement" && review.preview.resource.before === null && <p>保存后将使用此账号周期；之后加入用户组时，继续沿用此周期。</p>}
          {review.preview.resource && <h3 className="border-t pt-5 text-base font-medium">现有账号影响</h3>}
          {review.preview.blockers?.length > 0 && (<Notice tone="error" title="暂时无法更新授权">{<ul className="list-disc space-y-2 pl-5">
                  {review.preview.blockers.map((b, i) => (<li key={i}>{b}</li>))}
                </ul>}</Notice>)}
          {!review.preview.blockers?.length && (<p>
              {review.preview.affected.length
                    ? `涉及 ${review.preview.affected.length} 位用户。`
                    : "现有用户授权不变。"}
            </p>)}
          {review.preview.affected.length > 0 && (<>
              <label className="flex items-start gap-2 text-sm leading-relaxed"><Checkbox checked={showFull} onCheckedChange={checked => (event => setShowFull(event.target.checked))({ target: { checked: checked === true } })}/>
                显示完整授权
              </label>
              <ul className="policy-review-users divide-y rounded-lg border">{review.preview.affected.slice((reviewPage - 1) * 5, reviewPage * 5).map(effect => <li key={effect.userId} className="p-4"><PolicyComparison effect={effect} userName={accountLabel(effect.userId)} showUserId={(accountIdentities.get(accountLabel(effect.userId))?.size ?? 0) > 1} services={services} routes={routes} showFull={showFull}/></li>)}</ul>
              {review.preview.affected.length > 5 && <PageNavigation page={reviewPage} pageSize={5} total={review.preview.affected.length} onPageChange={setReviewPage}/>}
              <p className="muted text-sm text-muted-foreground">切换方案或续期后，保留已有用量。</p>
            </>)}
          <Accordion value={showRules ? ["rules"] : []} onValueChange={(keys) => setShowRules(keys.includes("rules"))} type="multiple">{([
                {
                    key: "rules",
                    label: "\u6388\u6743\u89C4\u5219",
                    children: (<>
                    <p>多个用户组按优先级选用一份方案额度，个人覆盖优先。</p>
                    {review.preview.affected.length === 0 && (<p>切换方案或续期后，保留已有用量。</p>)}
                  </>),
                },
            ]).map(section => <AccordionItem key={section.key} value={String(section.key)}><AccordionTrigger>{section.label}</AccordionTrigger><AccordionContent className="space-y-3">{section.children}</AccordionContent></AccordionItem>)}</Accordion>
          <p className="muted text-sm text-muted-foreground">
            受管入口配置需单独应用。
          </p>
          <label className="flex items-start gap-2 text-sm leading-relaxed"><Checkbox checked={confirmed} onCheckedChange={checked => (e => setConfirmed(e.target.checked))({ target: { checked: checked === true } })}/>
            {closeCompanion?.dirty
                ? `我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃${closeCompanion.label}${hasRetainedDraft ? "与保留的未保存草稿副本" : ""}`
                : hasRetainedDraft ? "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃保留的未保存草稿副本" : "我已核对本次授权变更"}
          </label>
        </>)}
    </TaskDialog>);
    return {
        propose,
        closingBlocked: preview.isPending || apply.isPending || appliedReview.current !== null || !!closeCompanion?.pending,
        requestClose: () => {
            if (preview.isPending || apply.isPending || appliedReview.current !== null || closeCompanion?.pending || confirming)
                return;
            if (!dirty && !hasRetainedDraft && !closeCompanion?.dirty) {
                onApplied();
                return;
            }
            confirmDiscard({
                title: closeCompanion?.dirty
                    ? `放弃${dirty || hasRetainedDraft ? "授权修改与" : ""}${closeCompanion.label}？`
                    : "放弃尚未保存的授权修改？",
                description: closeCompanion?.dirty
                    ? `${dirty ? "当前授权修改尚未保存。" : ""}${hasRetainedDraft ? "保留的授权草稿尚未保存。" : ""}${closeCompanion.discardDescription}放弃后将无法恢复。`
                    : "当前修改尚未保存。放弃后将无法恢复。",
                confirmLabel: "放弃修改",
                cancelLabel: "继续编辑",
            }, onApplied);
        },
        pending: preview.isPending,
        error: review ? null : error,
        errorFocusRef: editorErrorFocus,
        dialog,
        clearError: (markDirty = true) => {
            setFailureFocus(null);
            if (markDirty)
                setDirty(true);
            draftRevision.current++;
            setReview(null);
            setError(null);
        },
    };
}
export function UserGroups({ users, services, routes, }: {
    users: UserRecord[];
    services: Service[];
    routes: NamedRecord[];
}) {
    const query = useQuery({
        queryKey: ["user-groups"],
        queryFn: () => list<UserGroup>("/user-groups"),
    });
    const [editing, setEditing] = useState<{
        initial: UserGroup | null;
    } | null>(null);
    const inventoryKnown = query.data !== undefined;
    return (<Section variant="plain" title="用户组" description="以组分配服务方案；个人指定方案优先，多组按优先级选定一个方案及其额度。" extra={<div className="flex flex-wrap gap-2">
        {inventoryKnown && <ActionButton className="scroll-m-1" onClick={() => void query.refetch({ cancelRefetch: false })}
          pending={query.isFetching || query.isPaused} keepFocusableWhilePending variant="outline">刷新用户组</ActionButton>}
        <ActionButton onClick={() => setEditing({ initial: null })} variant="outline">
          新建用户组
        </ActionButton></div>}>
      {inventoryKnown && query.isError && <Notice tone="error" title="暂时无法刷新用户组">
        <p>{query.error.message}</p><p>列表暂未更新，请刷新重试。</p>
      </Notice>}
      {inventoryKnown && (query.isFetching || query.isPaused) && <p role="status" className="text-sm text-muted-foreground">
        {query.isPaused ? "等待网络连接后刷新用户组。" : "正在刷新用户组…"}
      </p>}
      <QueryState loading={query.isPending} paused={query.isPaused} loadingLayout="table" error={inventoryKnown ? null : query.error} retry={() => query.refetch()}>
        {query.data?.length ? (<DataTable rowKey="id" rows={query.data} columns={[
                { title: "用户组", accessor: "name" },
                {
                    title: "服务方案",
                    render: (_, g) => services.find((s) => s.id === g.serviceId)?.name ||
                        g.serviceId,
                },
                { title: "成员", render: (_, g) => `${g.memberIds?.length || 0} 位` },
                { title: "优先级", accessor: "priority" },
                {
                    title: "操作",
                    align: "right",
                    render: (_, g) => (<TableRowActions name={g.name}>
                    <ActionButton aria-label={`编辑 ${g.name}`} onClick={() => setEditing({ initial: g })} variant="outline">
                      编辑
                    </ActionButton>
                  </TableRowActions>),
                },
            ]} minWidth={560}/>) : query.isSuccess && query.fetchStatus === "idle" ? (<p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">暂无用户组</p>) : null}
      </QueryState>
      {editing && (<GroupPolicyEditor key={editing.initial?.id || "create"} initial={editing.initial} users={users} services={services} routes={routes} onClose={() => setEditing(null)}/>)}
    </Section>);
}
