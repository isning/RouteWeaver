import { describe, expect, it } from "vitest";
import {
  stagesFor,
  strategyAssignments,
  fleetStrategyIssue,
} from "./fleet-model";

describe("fleet execution order", () => {
  it("submits a simultaneous selection in one stage", () => {
    expect(
      stagesFor(
        ["b", "a", "c"],
        strategyAssignments(["b", "a", "c"], "together"),
      ),
    ).toEqual([["b", "a", "c"]]);
  });
  it("executes sequentially in explicit selection order", () => {
    expect(
      stagesFor(
        ["b", "a", "c"],
        strategyAssignments(["b", "a", "c"], "sequential"),
      ),
    ).toEqual([["b"], ["a"], ["c"]]);
  });
  it("uses the first selected instance as canary without an empty later stage", () => {
    expect(
      stagesFor(
        ["b", "a", "c"],
        strategyAssignments(["b", "a", "c"], "canary"),
      ),
    ).toEqual([["b"], ["a", "c"]]);
    expect(stagesFor(["b"], strategyAssignments(["b"], "canary"))).toEqual([
      ["b"],
    ]);
  });
  it("still requires explicit targets and continuous custom stages", () => {
    expect(() => stagesFor([], {})).toThrow("至少一个实例");
    expect(() => stagesFor(["a", "b"], { a: 1, b: 3 })).toThrow("阶段不能留空");
    expect(stagesFor(["a", "b", "c"], { a: 2, b: 1, c: 2 })).toEqual([
      ["b"],
      ["a", "c"],
    ]);
  });
});

describe("fleet stage limit", () => {
  const ids = Array.from({ length: 21 }, (_, index) => `target-${index}`);
  it("permits twenty sequential targets and explains why twenty-one cannot preview", () => {
    expect(fleetStrategyIssue("sequential", 20)).toBeUndefined();
    expect(
      stagesFor(
        ids.slice(0, 20),
        strategyAssignments(ids.slice(0, 20), "sequential"),
      ),
    ).toHaveLength(20);
    expect(fleetStrategyIssue("sequential", 21)).toContain("20 个实例");
    expect(() =>
      stagesFor(ids, strategyAssignments(ids, "sequential")),
    ).toThrow("20 个执行阶段");
  });
  it("keeps all twenty-one selected targets available for grouped strategies", () => {
    expect(fleetStrategyIssue("canary", 21)).toBeUndefined();
    expect(stagesFor(ids, strategyAssignments(ids, "canary"))).toEqual([
      ["target-0"],
      ids.slice(1),
    ]);
    expect(fleetStrategyIssue("custom", 21)).toBeUndefined();
    expect(stagesFor(ids, {})).toEqual([ids]);
  });
});
