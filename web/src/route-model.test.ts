import { describe, it, expect } from "vitest";
import { connectHop, displayRouteName } from "./route-model";
describe("ordered path editing", () => {
  it("adds only a connected forward hop", () =>
    expect(connectHop(["fra"], "fra", "uk", 2)).toEqual(["fra", "uk"]));
  it("rejects a cycle without changing route", () =>
    expect(() => connectHop(["fra", "uk"], "uk", "fra", 2)).toThrow("循环"));
  it("rejects a branch", () =>
    expect(() => connectHop(["fra", "uk"], "fra", "lax", 3)).toThrow("末端"));
  it("refuses capacity overflow", () =>
    expect(() => connectHop(["fra", "uk"], "uk", "lax", 2)).toThrow("2"));
  it("creates reproducible names without changing identity", () =>
    expect(
      displayRouteName(
        {
          name: "英国专线",
          hops: ["fra", "uk"],
          engine: "sing-box",
          id: "abcdef123",
        },
        [
          { id: "fra", name: "FRA" },
          { id: "uk", name: "UK" },
        ],
      ),
    ).toBe("英国专线 · FRA → UK · sing-box"));
});
