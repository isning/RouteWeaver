import { Notice } from "@/ui-patterns/notice";
import { ActionButton } from "@/ui-patterns/actions";
import { APIError } from "./api";
import { ErrorNotice } from "./components";
import type { ActionRef } from "./types";
import type { DraftIR } from "./profile-draft";
export type ActionLocation = {
    kind: "default";
} | {
    kind: "group" | "rule";
    id: string;
};
export interface MissingActionReference {
    code: "missing_action_reference";
    reference: {
        kind: "endpoint" | "group";
        id: string;
    };
    location: ActionLocation;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
/** Only this declared validation contract is actionable, never an English detail or arbitrary 400. */
export function missingActionReference(error: Error | null | undefined): MissingActionReference | null {
    if (!(error instanceof APIError) ||
        ![400, 422].includes(error.status) ||
        !record(error.details))
        return null;
    const issue = error.details.validation;
    if (!record(issue) || issue.code !== "missing_action_reference")
        return null;
    const { reference, location } = issue;
    if (!record(reference) ||
        (reference.kind !== "endpoint" && reference.kind !== "group") ||
        !identity(reference.id) ||
        !record(location))
        return null;
    let checkedLocation: ActionLocation;
    if (location.kind === "default" && location.id === undefined) {
        checkedLocation = { kind: "default" };
    }
    else if ((location.kind === "group" || location.kind === "rule") &&
        identity(location.id)) {
        checkedLocation = { kind: location.kind, id: location.id };
    }
    else
        return null;
    return {
        code: "missing_action_reference",
        reference: { kind: reference.kind, id: reference.id },
        location: checkedLocation,
    };
}
export function actionLocationKey(location: ActionLocation): string {
    return location.kind === "default"
        ? "default"
        : `${location.kind}:${location.id}`;
}
const matches = (action: ActionRef | null, issue: MissingActionReference) => !!action &&
    action.kind === issue.reference.kind &&
    action.ref === issue.reference.id;
/** Bind server metadata to this exact occurrence in the current draft, using identity rather than row index. */
export function actionRepair(ir: DraftIR, issue: MissingActionReference) {
    const location = issue.location;
    if (location.kind === "default")
        return matches(ir.defaultAction, issue)
            ? { title: "默认流量去向已不可用", action: "调整默认流量去向", tab: null }
            : null;
    if (location.kind === "group") {
        const groups = ir.groups.filter((group) => group.id === location.id);
        if (groups.length !== 1 ||
            !groups[0].members.some((member) => matches(member, issue)))
            return null;
        return {
            title: `策略组「${groups[0].name}」有不可用成员`,
            action: `调整策略组「${groups[0].name}」的成员`,
            tab: "groups",
        };
    }
    const rules = ir.rules.filter((rule) => rule.id === location.id);
    if (rules.length !== 1 || !matches(rules[0].action, issue))
        return null;
    const number = ir.rules.indexOf(rules[0]) + 1;
    return {
        title: `规则 ${number} 的流量去向已不可用`,
        action: `调整规则 ${number} 的去向`,
        tab: "rules",
    };
}
/** Each entry identifies an editable control; deduplication is local to that control only. */
export function missingActionOccurrences(ir: DraftIR, available: ReadonlySet<string>): MissingActionReference[] {
    const occurrences: MissingActionReference[] = [];
    const append = (action: ActionRef | null, location: ActionLocation) => {
        if (action === null)
            return;
        if ((action.kind !== "endpoint" && action.kind !== "group") ||
            !identity(action.ref) ||
            available.has(`${action.kind}:${action.ref}`))
            return;
        if (occurrences.some((item) => actionLocationKey(item.location) === actionLocationKey(location) &&
            item.reference.kind === action.kind &&
            item.reference.id === action.ref))
            return;
        occurrences.push({
            code: "missing_action_reference",
            reference: { kind: action.kind, id: action.ref },
            location,
        });
    };
    append(ir.defaultAction, { kind: "default" });
    ir.groups.forEach((group) => group.members.forEach((action) => append(action, { kind: "group", id: group.id })));
    ir.rules.forEach((rule) => append(rule.action, { kind: "rule", id: rule.id }));
    return occurrences;
}
export function ProfileValidationNotice({ error, ir, onRepair, }: {
    error: Error | null | undefined;
    ir: DraftIR;
    onRepair?: (issue: MissingActionReference) => void;
}) {
    const issue = missingActionReference(error);
    const repair = issue && onRepair ? actionRepair(ir, issue) : null;
    if (!issue || !repair)
        return <ErrorNotice error={error}/>;
    const title = `无法检查：${repair.title}`;
    return (<Notice tone="error" title={title} aria-label={title} className="profile-validation-notice" action={<ActionButton onClick={() => onRepair?.(issue)} variant="outline">{repair.action}</ActionButton>}>{<>
          <p>原选择已保留，请调整此处选择后重新检查。</p>
          <details>
            <summary>技术信息</summary>
            <p>{error?.message}</p>
          </details>
        </>}</Notice>);
}
