import type { ActionRef, Profile, ProfileIR, Rule } from "./types";

/** Incomplete intent belongs only to this editor, never the persisted IR. */
export type DraftRule = Omit<Rule, "action"> & { action: ActionRef | null };
export type DraftIR = Omit<ProfileIR, "rules"> & { rules: DraftRule[] };
export type DraftProfile = Omit<Profile, "ir"> & { ir: DraftIR };
export interface RuleDestinationIssue {
  ruleId: string | null;
  index: number;
  message: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const actionObject = (value: unknown): value is ActionRef =>
  record(value) && typeof value.kind === "string";

/** Preserve unknown kinds/fields. Domain validation still owns action semantics. */
export function parseDraftIR(value: unknown): DraftIR {
  if (
    !record(value) ||
    !Array.isArray(value.groups) ||
    !Array.isArray(value.rules) ||
    !value.runtime ||
    !value.defaultAction
  )
    throw new Error("请保留 groups、rules、runtime 和 defaultAction 字段。");
  for (const [index, rule] of value.rules.entries()) {
    if (!record(rule) || !(rule.action === null || actionObject(rule.action)))
      throw new Error(
        `规则 ${index + 1} 的 action 需为动作对象或 null（尚未选择流量去向）。`,
      );
  }
  return value as unknown as DraftIR;
}

/** No defaults, filtering or mutation: a request must contain every chosen action. */
export function toPersistableProfile(
  draft: DraftProfile,
):
  | { ok: true; profile: Profile }
  | { ok: false; issues: RuleDestinationIssue[] } {
  const rules: unknown = draft?.ir?.rules;
  if (!Array.isArray(rules))
    return {
      ok: false,
      issues: [
        {
          ruleId: null,
          index: -1,
          message: "规则结构无法读取，请检查配置意图 JSON。",
        },
      ],
    };
  const issues: RuleDestinationIssue[] = [];
  for (const [index, rule] of rules.entries()) {
    if (!record(rule) || !actionObject(rule.action))
      issues.push({
        ruleId: record(rule) && typeof rule.id === "string" ? rule.id : null,
        index,
        message: "请选择此规则的流量去向",
      });
  }
  if (issues.length) return { ok: false, issues };
  // This cast narrows only action:null after the exhaustive guard above.
  return {
    ok: true,
    profile: {
      ...draft,
      ir: { ...draft.ir, rules: rules as Rule[] },
    },
  };
}
