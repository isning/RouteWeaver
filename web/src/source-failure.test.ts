import { describe, expect, it } from "vitest";
import {
  sourceFailureText,
  sourceHasFailure,
  sourceIssueText,
  sourceStatusUnknown,
} from "./source-failure";
import type { Source } from "./types";
const source = (extra: Partial<Source> = {}): Source => ({
  id: "fixture",
  name: "Fixture",
  kind: "url",
  enabled: true,
  ...extra,
});
const generic = "导入未完成。请检查来源设置和内容后重试。";
describe("source-specific typed failure presentation", () => {
  it.each([
    [
      "source_url_not_allowed",
      "无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。",
    ],
    [
      "source_address_not_public",
      "订阅地址指向内网或保留地址，无法获取。请改用公开可访问的 HTTPS 订阅地址。",
    ],
    ["source_fetch_failed", "未能获取订阅内容。请检查链接是否有效，然后重试。"],
    ["source_fetch_timeout", "获取订阅内容超时。请稍后重试。"],
    [
      "source_content_too_large",
      "订阅内容过大，无法导入。请减少内容后重新导入。",
    ],
    ["source_parse_failed", "订阅内容未能导入。请检查格式和连接设置后重试。"],
    ["source_import_incomplete", "订阅未能完整导入。请检查内容后重试。"],
  ])("maps %s without reading transport detail", (lastErrorCode, copy) => {
    expect(
      sourceFailureText(
        source({
          refreshStatus: "failed",
          lastErrorCode,
          lastError: "https://private.invalid/?secret=never-display",
        }),
      ),
    ).toBe(copy);
  });
  it.each([undefined, "unknown", "constructor", "toString", "__proto__"])(
    "safely handles unknown code %s",
    (lastErrorCode) => {
      expect(
        sourceFailureText(
          source({
            refreshStatus: "failed",
            lastErrorCode,
            lastError: "secret-detail",
          }),
        ),
      ).toBe(generic);
    },
  );
  it.each([
    "accepted",
    "unchanged",
    "paused",
    "review-required",
    "unknown-future-state",
  ])("does not turn stale metadata into failure for %s", (refreshStatus) => {
    const value = source({
      refreshStatus,
      lastError: "old failure",
      lastErrorCode: "source_url_not_allowed",
    });
    expect(sourceHasFailure(value)).toBe(false);
    expect(sourceFailureText(value)).toBeNull();
  });
  it("supports missing-status legacy errors but never trusts their code", () => {
    expect(
      sourceFailureText(
        source({
          lastError: "legacy private detail",
          lastErrorCode: "source_url_not_allowed",
        }),
      ),
    ).toBe(generic);
    expect(
      sourceHasFailure(source({ lastErrorCode: "source_url_not_allowed" })),
    ).toBe(false);
    expect(sourceFailureText(source())).toBeNull();
  });
});

it("distinguishes unknown status from success and failure without trusting its code", () => {
  const unknown = source({
    refreshStatus: "future-status",
    lastError: "private legacy detail",
    lastErrorCode: "source_url_not_allowed",
  });
  expect(sourceStatusUnknown(unknown)).toBe(true);
  expect(sourceHasFailure(unknown)).toBe(false);
  expect(sourceFailureText(unknown)).toBeNull();
  expect(sourceIssueText(unknown)).toBe(
    "暂时无法确认来源状态。请重新打开来源后再试。",
  );
});
