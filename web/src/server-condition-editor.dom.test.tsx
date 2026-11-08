// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { ServerConditionEditor, conditionInputError } from "./ServerConditionEditor";
import type { MatchExpression, RuleResource, ServerProgram } from "./types";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const base = {
  instance: { id: "core", hostId: "host", name: "Core", adapterId: "routeweaver/sing-box", version: "1.14.4" },
  listener: { id: "entry", name: "Entry", instanceId: "core", connection: { protocol: "socks", host: "0.0.0.0", port: 1080 } },
  rules: [], defaultAction: { kind: "direct" },
} as ServerProgram;
const resource: RuleResource = { id: "work", name: "工作域名", revision: "1", digest: `sha256:${"0".repeat(64)}`, format: "sing-box-source", formatVersion: 5, location: "local", path: "rules/work.json", updatePolicy: "pinned" };
function Harness({ initial, program = base }: { initial: MatchExpression; program?: ServerProgram }) {
  const [match, setMatch] = useState(initial);
  return <UIProviders><ServerConditionEditor program={program} schemaVersion="1.0" label="规则条件" match={match} onChange={setMatch} />
    <output aria-label="当前条件">{JSON.stringify(match)}</output>
    <button type="button" disabled={!!conditionInputError(program, "1.0", match)}>保存</button>
  </UIProviders>;
}
const current = () => JSON.parse(screen.getByLabelText("当前条件").textContent || "null");

it("wraps a leaf, adds and edits a sibling without normalizing the original", async () => {
  const user = userEvent.setup();
  render(<Harness initial={{ op: "domain-suffix", value: "EXAMPLE.test", children: [] }} />);
  await user.click(screen.getByRole("button", { name: "规则条件组合全部条件" }));
  await user.click(screen.getByRole("button", { name: "规则条件添加域名条件" }));
  expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText("规则条件子条件 2值"), "other.test");
  expect(current()).toEqual({ op: "and", children: [{ op: "domain-suffix", value: "EXAMPLE.test", children: [] }, { op: "domain", value: "other.test" }] });
  expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
});

it("preserves an unknown subtree while editing a known sibling and offers no destructive removal for it", async () => {
  const user = userEvent.setup();
  const unknown = { op: "future", value: "opaque", extension: { payload: [1, 2] } } as MatchExpression;
  render(<Harness initial={{ op: "or", children: [unknown, { op: "domain", value: "before.test" }] }} />);
  await user.clear(screen.getByLabelText("规则条件子条件 2值"));
  await user.type(screen.getByLabelText("规则条件子条件 2值"), "after.test");
  expect(current()).toEqual({ op: "or", children: [unknown, { op: "domain", value: "after.test" }] });
  expect(screen.queryByRole("button", { name: "规则条件子条件 1删除条件" })).toBeNull();
  expect(screen.queryByRole("button", { name: "规则条件组合全部条件" })).toBeNull();
});

it("cancels then confirms subtree removal and leaves focus on the surviving editor", async () => {
  const user = userEvent.setup();
  const initial = { op: "and", children: [{ op: "domain", value: "first.test" }, { op: "domain", value: "second.test" }] };
  render(<Harness initial={initial} />);
  await user.click(screen.getByRole("button", { name: "规则条件子条件 2删除条件" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(current()).toEqual(initial);
  await user.click(screen.getByRole("button", { name: "规则条件子条件 2删除条件" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除条件" }));
  await waitFor(() => expect(current()).toEqual({ op: "and", children: [{ op: "domain", value: "first.test" }] }));
  expect(document.activeElement).toBe(screen.getByRole("group", { name: "规则条件编辑器" }));
});

it("selects only real compatible resources and retains an unavailable reference until explicitly changed", async () => {
  const user = userEvent.setup();
  const program = { ...base, resources: [resource, { ...resource, id: "private", ownerId: "someone" }, { ...resource, id: "wrong-format", format: "mihomo-yaml" }, { ...resource, id: "duplicate" }, { ...resource, id: "duplicate" }] };
  render(<Harness program={program} initial={{ op: "resource", value: "missing" }} />);
  expect(current()).toEqual({ op: "resource", value: "missing" });
  expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("combobox", { name: "规则条件资源" }));
  const list = await screen.findByRole("listbox");
  expect(list.textContent).not.toContain("private");
  expect(list.textContent).not.toContain("wrong-format");
  expect(list.textContent).not.toContain("duplicate");
  await user.click(within(list).getByText("工作域名"));
  expect(current()).toEqual({ op: "resource", value: "work" });
  expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps Xray groups and future extension fields read-only", () => {
  const initial = { op: "and", children: [{ op: "domain", value: "example.test" }] };
  render(<Harness program={{ ...base, instance: { ...base.instance, adapterId: "routeweaver/xray", version: "26.10.31" } }} initial={initial} />);
  expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  expect(current()).toEqual(initial);
});

it("rejects nested invalid values and references without mutating them", () => {
  const program = { ...base, resources: [resource] };
  expect(conditionInputError(program, "1.0", { op: "not", children: [] })).toBeTruthy();
  expect(conditionInputError(program, "1.0", { op: "and", children: [{ op: "ip-cidr", value: "192.0.2.1/99" }] })).toBeTruthy();
  expect(conditionInputError(program, "1.0", { op: "resource", value: "not-there" })).toBeTruthy();
  let match: MatchExpression = { op: "domain", value: "example.test" };
  for (let depth = 0; depth < 128; depth++) match = { op: "not", children: [match] };
  expect(conditionInputError(program, "1.0", match)).toBeUndefined();
  expect(conditionInputError(program, "1.0", { op: "not", children: [match] })).toBeTruthy();
});


it("preserves legacy unavailable resources without blocking an unrelated edit", () => {
  const program = { ...base, resources: [{ ...resource, digest: "digest-fixture", updatePolicy: "manual" }] };
  const initial = { op: "resource", value: "work" };
  render(<Harness program={program} initial={initial} />);
  expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  expect(current()).toEqual(initial);
  expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
});

it("does not apply a stale removal confirmation to a newer program", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const match = { op: "or", children: [{ op: "domain", value: "first.test" }, { op: "domain", value: "second.test" }] };
  const view = render(<UIProviders><ServerConditionEditor program={base} schemaVersion="1.0" label="规则条件" match={match} onChange={onChange} /></UIProviders>);
  await user.click(screen.getByRole("button", { name: "规则条件子条件 2删除条件" }));
  await screen.findByRole("alertdialog");
  view.rerender(<UIProviders><ServerConditionEditor program={{ ...base, defaultAction: { kind: "reject" } }} schemaVersion="1.0" label="规则条件" match={match} onChange={onChange} /></UIProviders>);
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除条件" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onChange).not.toHaveBeenCalled();
});

it("changes leaf and group selectors through their user controls", async () => {
  const user = userEvent.setup();
  render(<Harness initial={{ op: "domain", value: "example.test" }} />);
  await user.click(screen.getByRole("combobox", { name: "规则条件类型" }));
  await user.click(within(await screen.findByRole("listbox")).getByText("域名后缀"));
  expect(current()).toEqual({ op: "domain-suffix", value: "example.test" });
  await user.click(screen.getByRole("button", { name: "规则条件组合全部条件" }));
  await user.click(screen.getByRole("combobox", { name: "规则条件组合方式" }));
  await user.click(within(await screen.findByRole("listbox")).getByText("满足任一条件"));
  expect(current()).toEqual({ op: "or", children: [{ op: "domain-suffix", value: "example.test" }] });
});

it("allows nil optional lists but protects malformed scalar lists", () => {
  const initial = { op: "domain", value: "example.test" };
  const nilProgram = { ...base, principals: null, egress: null } as unknown as ServerProgram;
  const view = render(<Harness program={nilProgram} initial={initial} />);
  expect((screen.getByLabelText("规则条件值") as HTMLInputElement).value).toBe("example.test");
  for (const malformed of [false, 0, ""]) {
    view.rerender(<Harness program={{ ...base, principals: malformed } as unknown as ServerProgram} initial={initial} />);
    expect(screen.queryByLabelText("规则条件值")).toBeNull();
  }
});
