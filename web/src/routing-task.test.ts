import { expect, it } from "vitest";
import { emptyProfile } from "./model";
import { bindCreatedGroup, groupUses } from "./routing-task";

it("creates one ordinary group for the named rule without rejecting unrelated edits", () => {
  const profile = emptyProfile();
  profile.name = "Changed while choosing";
  profile.ir.rules = [
    {
      id: "other",
      match: { op: "domain", value: "other.example" },
      action: { kind: "reject" },
    },
    {
      id: "chosen",
      match: { op: "domain-suffix", value: "example.com" },
      action: { kind: "direct" },
    },
  ];
  const before = structuredClone(profile);
  const group = {
    id: "travel",
    name: "Travel",
    kind: "manual",
    members: [
      { kind: "endpoint", ref: "airport-a" },
      { kind: "endpoint", ref: "platform-a" },
    ],
  };
  const result = bindCreatedGroup(
    profile,
    { kind: "rule", id: "chosen", expected: { kind: "direct" } },
    group,
    ["platform-a"],
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.profile.ir.groups).toEqual([group]);
  expect(result.profile.ir.rules).toEqual([
    {
      id: "other",
      match: { op: "domain", value: "other.example" },
      action: { kind: "reject" },
    },
    {
      id: "chosen",
      match: { op: "domain-suffix", value: "example.com" },
      action: { kind: "group", ref: "travel" },
    },
  ]);
  expect(result.profile.platformEntryIds).toEqual(["platform-a"]);
  expect(result.profile.name).toBe("Changed while choosing");
  expect(result.profile.ir.defaultAction).toEqual({ kind: "direct" });
  expect(profile).toEqual(before);
  expect(
    bindCreatedGroup(
      result.profile,
      { kind: "rule", id: "chosen", expected: { kind: "direct" } },
      group,
      ["platform-a"],
    ).ok,
  ).toBe(false);
});

it("names direct incoming uses without treating an unused parent as live routing", () => {
  const profile = emptyProfile();
  profile.ir.defaultAction = { kind: "group", ref: "leaf" };
  profile.ir.rules = [
    {
      id: "work",
      match: { op: "domain", value: "example.com" },
      action: { kind: "group", ref: "leaf" },
    },
  ];
  profile.ir.groups = [
    { id: "leaf", name: "Leaf", kind: "manual", members: [{ kind: "direct" }] },
    {
      id: "parent",
      name: "Unused parent",
      kind: "manual",
      members: [
        { kind: "group", ref: "leaf" },
        { kind: "group", ref: "leaf" },
      ],
    },
  ];
  expect(groupUses(profile.ir, "leaf")).toEqual([
    { location: { kind: "default" }, label: "用于默认流量" },
    { location: { kind: "rule", id: "work" }, label: "用于规则 1" },
    {
      location: { kind: "group", id: "parent" },
      label: "被「Unused parent」组引用",
    },
  ]);
  expect(groupUses(profile.ir, "parent")).toEqual([]);
});

it.each(["removed", "changed", "ambiguous"])(
  "refuses a %s rule target without changing any draft data",
  (condition) => {
    const profile = emptyProfile();
    const rule = {
      id: "work",
      match: { op: "domain", value: "example.com" },
      action: { kind: "reject" },
    };
    profile.ir.rules =
      condition === "removed"
        ? []
        : condition === "ambiguous"
          ? [rule, rule]
          : [rule];
    const before = structuredClone(profile);
    expect(
      bindCreatedGroup(
        profile,
        { kind: "rule", id: "work", expected: null },
        {
          id: "group",
          name: "Group",
          kind: "manual",
          members: [{ kind: "direct" }],
        },
        [],
      ),
    ).toEqual({ ok: false });
    expect(profile).toEqual(before);
  },
);

it("binds an incomplete rule by stable identity after reorder while retaining unknown neighboring intent", () => {
  const profile = emptyProfile();
  const draft = {
    ...profile,
    ir: {
      ...profile.ir,
      nativeOverride: { extra: "kept" } as never,
      rules: [
        {
          id: "other",
          match: { op: "future", children: [] },
          action: { kind: "reject" },
        },
        {
          id: "work",
          match: { op: "domain", value: "example.com" },
          action: null,
        },
      ],
    },
  };
  const result = bindCreatedGroup(
    draft,
    { kind: "rule", id: "work", expected: null },
    { id: "new", name: "New", kind: "manual", members: [{ kind: "direct" }] },
    [],
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.profile.ir.rules[0]).toEqual(draft.ir.rules[0]);
  expect(result.profile.ir.rules[1]).toEqual({
    id: "work",
    match: { op: "domain", value: "example.com" },
    action: { kind: "group", ref: "new" },
  });
  expect(result.profile.ir.nativeOverride).toEqual({ extra: "kept" });
});
