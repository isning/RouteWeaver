import { describe, expect, it } from "vitest";
import { measuredBytes, observationStatus } from "./observability-model";
describe("provider measurement inputs", () => {
  it("keeps decimal and binary units distinct with exact integer-byte arithmetic", () => {
    expect(measuredBytes("2.5", "TB")).toBe(2500000000000);
    expect(measuredBytes("2", "TiB")).toBe(2199023255552);
    expect(measuredBytes("0", "bytes")).toBe(0);
  });
  it("rejects missing, negative, fractional-byte and unsafe-integer measurements", () => {
    for (const value of ["", "-1", "0.5", "9007199254740992"])
      expect(() => measuredBytes(value, "bytes")).toThrow();
  });
  it("does not label initial or stale resource samples as live", () => {
    expect(observationStatus(null, 0)).toBe("尚未收到观测");
    expect(
      observationStatus(
        "2026-01-01T00:00:00Z",
        Date.parse("2026-01-01T01:00:00Z"),
      ),
    ).toBe("较早的观测");
    expect(
      observationStatus(
        "2026-01-01T00:00:00Z",
        Date.parse("2026-01-01T00:05:00Z"),
      ),
    ).toBe("最近观测");
  });
});
