import { describe, it, expect } from "vitest";
import {
  bytesLabel,
  bitrateLabel,
  dateLabel,
  resetCountdown,
  moveItem,
  groupErrors,
  parseAction,
  actionValue,
  redact,
} from "./model";
describe("user-visible subscription facts", () => {
  it("shows a configured UTC+8 reset without browser timezone ambiguity", () =>
    expect(dateLabel("2026-11-01T00:00:00+08:00", "UTC+8")).toBe(
      "2026/11/01 00:00",
    ));
  it("does not turn unknown usage into zero", () => {
    expect(bytesLabel(undefined)).toBe("—");
    expect(bytesLabel(0)).toBe("0 B");
    expect(bytesLabel(3 * 1024 ** 3)).toBe("3 GiB");
  });
  it("counts down from the actual reset instant and does not invent a date", () => {
    expect(resetCountdown(undefined)).toBe(null);
    expect(
      resetCountdown(
        "2026-11-01T00:00:00+08:00",
        Date.parse("2026-10-30T20:00:00+08:00"),
      ),
    ).toBe("1 天 4 小时");
  });
});
describe("keyboard editing and stable routing references", () => {
  it("reorders without mutating the original list", () => {
    const input = ["entry", "relay", "exit"];
    expect(moveItem(input, 2, 1)).toEqual(["entry", "exit", "relay"]);
    expect(input).toEqual(["entry", "relay", "exit"]);
  });
  it("keeps group identity in rules rather than display names", () =>
    expect(parseAction(actionValue({ kind: "group", ref: "work_uk" }))).toEqual(
      { kind: "group", ref: "work_uk" },
    ));
  it("identifies a nested strategy cycle", () =>
    expect(
      groupErrors([
        {
          id: "one",
          name: "日常",
          kind: "manual",
          members: [{ kind: "group", ref: "two" }],
        },
        {
          id: "two",
          name: "工作",
          kind: "manual",
          members: [{ kind: "group", ref: "one" }],
        },
      ]),
    ).toContain("策略组不能循环引用。"));
  it("accepts a dynamic group without fixed members", () =>
    expect(
      groupErrors([
        {
          id: "one",
          name: "香港",
          kind: "manual",
          members: [],
          dynamic: { region: "HK" },
        },
      ]),
    ).toEqual([]));
  it("redacts credentials in preview without changing node names", () => {
    const text = redact(
      '{"name":"London","password":"secret-value","uuid":"secret-id"}',
    );
    expect(text).toContain("London");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("secret-id");
  });
});
describe("server artifact privacy", () => {
  it("masks native-core credential spellings as well as normalized fields", () => {
    const value = redact(
      '{"privateKey":"key-value","accounts":[{"user":"login-value","pass":"pass-value"}],"clients":[{"id":"uuid-value"}]}',
    );
    for (const secret of [
      "key-value",
      "login-value",
      "pass-value",
      "uuid-value",
    ])
      expect(value).not.toContain(secret);
  });
});
it("never exposes an uploaded TLS private key in preview artifacts", () => {
  expect(
    redact(
      "-----BEGIN PRIVATE KEY-----\nsynthetic-key-material\n-----END PRIVATE KEY-----",
    ),
  ).not.toContain("synthetic-key-material");
  expect(redact('{"privateKeyPem":"synthetic-key-material"}')).not.toContain(
    "synthetic-key-material",
  );
});

it("formats stored byte rates in the same decimal Mbps as policy editing", () => {
  expect(bitrateLabel(12500000)).toBe("100 Mbps");
  expect(bitrateLabel(1)).toBe("0.000008 Mbps");
  expect(bitrateLabel(undefined)).toBe("—");
});
