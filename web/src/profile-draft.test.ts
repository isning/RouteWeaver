import { expect, it } from "vitest";
import { emptyProfile } from "./model";
import {
  parseDraftIR,
  toPersistableProfile,
  type DraftProfile,
} from "./profile-draft";

it.each([null, undefined, 42, "direct", [], {}, { kind: null }])(
  "never produces a request for absent or malformed action %j",
  (action) => {
    const profile = emptyProfile() as DraftProfile;
    profile.ir.rules = [
      {
        id: "r1",
        match: { op: "domain", value: "example.com" },
        action: action as never,
      },
    ];
    const before = JSON.stringify(profile);
    expect(toPersistableProfile(profile)).toEqual({
      ok: false,
      issues: [{ ruleId: "r1", index: 0, message: "请选择此规则的流量去向" }],
    });
    expect(JSON.stringify(profile)).toBe(before);
  },
);
it("preserves rule order, identity and every chosen/unknown action field without inheriting the default", () => {
  const profile = emptyProfile();
  profile.ir.defaultAction = { kind: "endpoint", ref: "airport" };
  profile.ir.rules = [
    {
      id: "r2",
      match: { op: "domain", value: "two.example" },
      action: {
        kind: "future-action",
        ref: "kept",
        extension: { secret: "kept" },
      } as never,
    },
    {
      id: "r1",
      match: { op: "domain", value: "one.example" },
      action: { kind: "direct" },
    },
  ];
  profile.ir.name = "Retained local IR name";
  const before = structuredClone(profile.ir.rules);
  const result = toPersistableProfile(profile);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.profile.ir.rules).toEqual(before);
    expect(result.profile.ir.name).toBe("Retained local IR name");
  }
  expect(profile.ir.rules).toEqual(before);
});
it("round trips truthful local null while preserving unsupported JSON content", () => {
  const profile = emptyProfile();
  const ir = {
    ...profile.ir,
    futureField: { kept: true },
    rules: [
      {
        id: "r1",
        match: { op: "future-match", extension: [1, 2] },
        action: null,
      },
    ],
  };
  expect(parseDraftIR(JSON.parse(JSON.stringify(ir)))).toEqual(ir);
  expect(toPersistableProfile({ ...profile, ir: parseDraftIR(ir) }).ok).toBe(
    false,
  );
});
it("rejects action-absent JSON without mutating its other content", () => {
  const ir = {
    ...emptyProfile().ir,
    rules: [{ id: "r1", match: { op: "domain", value: "example.com" } }],
  };
  const before = structuredClone(ir);
  expect(() => parseDraftIR(ir)).toThrow("规则 1 的 action");
  expect(ir).toEqual(before);
});
it("rejects an unreadable rules container instead of silently sending no rules", () => {
  const p = emptyProfile();
  expect(
    toPersistableProfile({ ...p, ir: { ...p.ir, rules: null } } as never).ok,
  ).toBe(false);
});
