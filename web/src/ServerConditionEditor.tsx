import { useId, useRef } from "react";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import type { MatchExpression, ServerProgram } from "./types";
import {
  conditionDepthLimit, conditionEditable, conditionInputError, conditionTreeDepth,
  hasStructuredConditions, leafConditionOptions, selectableConditionResources,
  understoodConditionTree,
} from "./server-condition-model";
export { conditionEditable, conditionInputError } from "./server-condition-model";

type Props = {
  program: ServerProgram;
  schemaVersion: string;
  match: MatchExpression;
  label: string;
  onChange: (match: MatchExpression) => void;
};

export function ServerConditionEditor(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root} tabIndex={-1} role="group" aria-label={`${props.label}编辑器`} className="min-w-0">
    <ConditionNode {...props} depth={0} focusAfterRemove={() => root.current?.focus()} />
  </div>;
}
function ConditionNode({ program, schemaVersion, match, label, onChange, depth, onRemove, focusAfterRemove }: Props & {
  depth: number;
  onRemove?: () => void;
  focusAfterRemove: () => void;
}) {
  const id = useId();
  const { confirm, confirming } = useDiscardConfirmation(label);
  const latest = useRef({ match, program, onRemove, onChange });
  latest.current = { match, program, onRemove, onChange };
  if (depth > conditionDepthLimit || !conditionEditable(program, schemaVersion, match)) {
    return <div className="min-w-0 rounded-md border p-3"><p className="text-sm font-medium">{label}</p><p className="text-sm text-muted-foreground">此条件保留原样，请在完整 JSON 中修改。</p></div>;
  }
  const structured = hasStructuredConditions(program);
  const group = ["and", "or", "not"].includes(match.op);
  const children = match.children || [];
  const removable = understoodConditionTree(match);
  const resources = selectableConditionResources(program);
  const error = group ? (!children.length ? "请为分组添加条件。" : match.op === "not" && children.length !== 1 ? "取反必须包含一个条件，请在完整 JSON 中修复。" : undefined) : conditionInputError(program, schemaVersion, match);
  const canWrap = structured && depth + conditionTreeDepth(match) < conditionDepthLimit;
  const change = (next: MatchExpression) => onChange(next);
  const remove = (unwrap: boolean) => confirm({
    title: `${label}${unwrap ? "移除分组" : "删除条件"}`,
    description: unwrap ? (match.op === "not" ? "移除取反后，将直接匹配其中的条件。" : "移除分组，保留其中的条件。") : "删除此条件及其子条件，会改变规则匹配范围。",
    confirmLabel: unwrap ? "移除分组" : "删除条件", cancelLabel: "取消",
  }, (stillCurrent) => {
    if (!stillCurrent() || latest.current.match !== match || latest.current.program !== program) return;
    focusAfterRemove();
    if (unwrap) latest.current.onChange(children[0]);
    else latest.current.onRemove?.();
  });
  const add = (op: string) => change({ ...match, children: [...children, { op, value: op === "resource" ? resources[0].id : "" }] });
  const leafOptions = [...leafConditionOptions, ...(structured ? [{ value: "resource", label: "规则资源", disabled: resources.length === 0 && match.op !== "resource" }] : [])];
  return <fieldset className={depth < 2 ? "min-w-0 space-y-3 rounded-md border p-2 sm:p-3" : "min-w-0 space-y-3 border-0 p-0"}>
    <legend className="max-w-full break-words px-1 text-sm font-medium">{label}</legend>
    {group ? <>
      {match.op === "not" ? <p className="text-sm">不满足以下条件</p> : <ChoiceSelect
        aria-label={`${label}组合方式`} value={match.op}
        options={[{ value: "and", label: "满足全部条件" }, { value: "or", label: "满足任一条件" }]}
        onValueChange={(op) => { if (op === "and" || op === "or") change({ ...match, op }); }} />}
      {children.map((child, index) => <ConditionNode key={index} program={program} schemaVersion={schemaVersion}
        match={child} depth={depth + 1} focusAfterRemove={focusAfterRemove} label={`${label}子条件 ${index + 1}`}
        onChange={(next) => change({ ...match, children: children.map((current, at) => at === index ? next : current) })}
        onRemove={match.op !== "not" && children.length > 1 ? () => change({ ...match, children: children.filter((_, at) => at !== index) }) : undefined} />)}
      {depth < conditionDepthLimit && (match.op !== "not" || children.length === 0) && <div className="flex flex-wrap gap-2">
        <ActionButton type="button" variant="outline" aria-label={`${label}添加域名条件`} onClick={() => add("domain")}>添加条件</ActionButton>
        {resources.length > 0 && <ActionButton type="button" variant="outline" aria-label={`${label}添加资源条件`} onClick={() => add("resource")}>添加资源条件</ActionButton>}
      </div>}
    </> : <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <ChoiceSelect aria-label={`${label}类型`} value={match.op} options={leafOptions}
        onValueChange={(op) => {
          if (!op || op === match.op || !leafOptions.some((option) => option.value === op && !("disabled" in option && option.disabled))) return;
          // Leaf type changes are explicit. Never silently carry a resource ID as a domain.
          const value = op === "resource" ? resources[0]?.id : match.op === "resource" ? "" : match.value;
          if (value !== undefined) change({ ...match, op, value });
        }} />
      {match.op === "resource" ? <ChoiceSelect aria-label={`${label}资源`} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
        value={match.value || ""} options={[
          ...(!resources.some((resource) => resource.id === match.value) ? [{ value: match.value || "", label: `不可用资源：${match.value || "未选择"}`, disabled: true }] : []),
          ...resources.map((resource) => ({ value: resource.id, label: resource.name || resource.id, description: resource.name ? resource.id : undefined })),
        ]} onValueChange={(value) => { if (value !== undefined && resources.some((resource) => resource.id === value)) change({ ...match, value }); }} /> : <Input
          aria-label={`${label}值`} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
          value={match.value || ""} onChange={(event) => change({ ...match, value: event.target.value })} />}
    </div>}
    {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {canWrap && ["and", "or", "not"].map((op) => <ActionButton key={op} type="button" variant="outline"
        aria-label={`${label}${op === "not" ? "取反" : op === "and" ? "组合全部条件" : "组合任一条件"}`}
        onClick={() => change({ op, children: [match] })}>{op === "not" ? "取反" : op === "and" ? "组合全部条件" : "组合任一条件"}</ActionButton>)}
      {group && children.length === 1 && removable && <ActionButton type="button" variant="outline" aria-label={`${label}移除分组`} disabled={confirming} onClick={() => remove(true)}>移除分组</ActionButton>}
      {onRemove && removable && <ActionButton type="button" variant="outline" aria-label={`${label}删除条件`} disabled={confirming} onClick={() => remove(false)}>删除条件</ActionButton>}
    </div>
  </fieldset>;
}
