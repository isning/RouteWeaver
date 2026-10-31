import type { DraftIR, DraftProfile } from "./profile-draft";
import type { ActionRef, Group } from "./types";

/** This is a local editing command, not a new persisted routing object. */
export type RoutingTarget =
  | { kind: "default"; expected: ActionRef }
  | { kind: "rule"; id: string; expected: ActionRef | null };

export type GroupUse = {
  location: { kind: "default" } | { kind: "rule" | "group"; id: string };
  label: string;
};

/** Structural incoming references only: not traffic or resolved membership. */
export function groupUses(ir: DraftIR, id: string): GroupUse[] {
  const references = (action: ActionRef | null) =>
    action?.kind === "group" && action.ref === id;
  return [
    ...(references(ir.defaultAction)
      ? [{ location: { kind: "default" as const }, label: "用于默认流量" }]
      : []),
    ...ir.rules.flatMap((rule, index) =>
      references(rule.action)
        ? [
            {
              location: { kind: "rule" as const, id: rule.id },
              label: `用于规则 ${index + 1}`,
            },
          ]
        : [],
    ),
    ...ir.groups.flatMap((group) =>
      group.members.some(references)
        ? [
            {
              location: { kind: "group" as const, id: group.id },
              label: `被「${group.name}」组引用`,
            },
          ]
        : [],
    ),
  ];
}

export function bindCreatedGroup(
  profile: DraftProfile,
  target: RoutingTarget,
  group: Group,
  eligibleEntryIds: readonly string[],
): { ok: true; profile: DraftProfile } | { ok: false } {
  const rules =
    target.kind === "rule"
      ? profile.ir.rules.filter((rule) => rule.id === target.id)
      : [];
  const current =
    target.kind === "default"
      ? profile.ir.defaultAction
      : rules.length === 1
        ? rules[0].action
        : undefined;
  if (
    current === undefined ||
    JSON.stringify(current) !== JSON.stringify(target.expected) ||
    profile.ir.groups.some((existing) => existing.id === group.id)
  )
    return { ok: false };
  const action: ActionRef = { kind: "group", ref: group.id };
  const addedEntries = group.members
    .filter(
      (member) =>
        member.kind === "endpoint" &&
        eligibleEntryIds.includes(member.ref || ""),
    )
    .map((member) => member.ref!);
  return {
    ok: true,
    profile: {
      ...profile,
      ...(addedEntries.length
        ? {
            platformEntryIds: [
              ...new Set([
                ...(profile.platformEntryIds || []),
                ...addedEntries,
              ]),
            ],
          }
        : {}),
      ir: {
        ...profile.ir,
        groups: [...profile.ir.groups, group],
        ...(target.kind === "default"
          ? { defaultAction: action }
          : {
              rules: profile.ir.rules.map((rule) =>
                rule.id === target.id ? { ...rule, action } : rule,
              ),
            }),
      },
    },
  };
}
