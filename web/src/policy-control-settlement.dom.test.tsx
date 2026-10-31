// @vitest-environment jsdom
// Authored public-control contract tests; runtime unrun for this layer.
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";
import { AppForm, AppField } from "@/ui-patterns/form";
import { PolicyDateInput } from "./PolicyDateInput";
import { ByteQuantityInput } from "./ByteQuantityInput";
import { CycleFields } from "./PolicyFields";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal("ResizeObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function FormValues() {
  return <AppField noStyle shouldUpdate>
    {({ getFieldsValue }) => <output aria-label="Form values">{JSON.stringify(getFieldsValue(true))}</output>}
  </AppField>;
}
const values = () => JSON.parse(screen.getByLabelText("Form values").textContent!);
const originalDate = "2026-02-03T04:05:06.123456789+05:30";
function DateProbe() {
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  return <AppForm initialValues={{ date: originalDate }}>
    <AppField name="date" label="Date">
      <PolicyDateInput onOpenChange={setOpen} onPendingChange={setPending} />
    </AppField>
    <output aria-label="Picker open">{String(open)}</output>
    <output aria-label="Pending selection">{String(pending)}</output>
    <FormValues />
  </AppForm>;
}
function nextDay() {
  const cells = screen.getAllByRole("button", { name: "2026年2月4日" });
  expect(cells).toHaveLength(1);
  return cells[0];
}

it("reports open and tentative date selection without changing Form until confirmation", async (context) => {
  const owner = ownedClickScenario(context);
  render(<DateProbe />);
  const field = screen.getByLabelText("Date") as HTMLInputElement;
  await owner.click(() => field);
  expect(screen.getByLabelText("Picker open").textContent).toBe("true");
  expect(screen.getByLabelText("Pending selection").textContent).toBe("false");
  const day = await waitFor(() => { owner.assertActive(); return nextDay(); });
  owner.assertActive();
  expect(screen.getByRole("dialog", { name: "选择日期与时间" }).contains(day)).toBe(true);
  expect(day.closest('[data-slot="popover-content"]')).not.toBeNull();
  await owner.click(() => day);
  expect(screen.getByLabelText("Pending selection").textContent).toBe("true");
  expect(values()).toEqual({ date: originalDate });
  await owner.click(() => field);
  owner.assertActive();
  expect(field.isConnected && document.activeElement === field).toBe(true);
  await userEvent.keyboard("{Escape}");
  owner.assertActive();
  await waitFor(() => {
    owner.assertActive();
    expect(screen.getByLabelText("Picker open").textContent).toBe("false");
    expect(screen.getByLabelText("Pending selection").textContent).toBe("false");
  });
  expect(values()).toEqual({ date: originalDate });
  await owner.click(() => field);
  const secondDay = await waitFor(() => { owner.assertActive(); return nextDay(); });
  owner.assertActive();
  await owner.click(() => secondDay);
  expect(screen.getByLabelText("Pending selection").textContent).toBe("true");
  await owner.click(() => screen.getByRole("button", { name: "确定" }));
  await waitFor(() => {
    owner.assertActive();
    expect(screen.getByLabelText("Picker open").textContent).toBe("false");
    expect(screen.getByLabelText("Pending selection").textContent).toBe("false");
    expect(values()).toEqual({ date: "2026-02-03T22:35:06.123Z" });
  });
});

function NumberProbe() {
  const [raw, setRaw] = useState<string | null>(null), [resetKey, setResetKey] = useState(0);
  return <AppForm initialValues={{ quota: 1073741824 }}>
    <AppField name="quota" label="Quota">
      <ByteQuantityInput unit="GiB" onInput={setRaw} inputResetKey={resetKey} />
    </AppField>
    <Button type="button">Outside</Button>
    <Button type="button" onClick={() => { setRaw(null); setResetKey((key) => key + 1); }}>Discard input</Button>
    <output aria-label="Captured input">{JSON.stringify(raw)}</output>
    <FormValues />
  </AppForm>;
}
it("exposes unaccepted numeric text and resets only its inner control on explicit request", async (context) => {
  const owner = ownedClickScenario(context);
  render(<NumberProbe />);
  const field = screen.getByLabelText("Quota") as HTMLInputElement;
  await owner.click(() => field);
  owner.change(() => field, { target: { value: "-" } });
  expect(screen.getByLabelText("Captured input").textContent).toBe('"-"');
  expect(values()).toEqual({ quota: 1073741824 });
  await owner.click(() => screen.getByRole("button", { name: "Outside" }));
  expect(field.value).toBe("-");
  expect(screen.getByLabelText("Captured input").textContent).toBe('"-"');
  await owner.click(() => screen.getByRole("button", { name: "Discard input" }));
  expect((screen.getByLabelText("Quota") as HTMLInputElement).value).toBe("1");
  expect(screen.getByLabelText("Captured input").textContent).toBe("null");
  expect(values()).toEqual({ quota: 1073741824 });
});

const originalCycle = { mode: "monthly", day: 15, days: 7, anchor: originalDate, timezone: "UTC+8" };
function CycleProbe() {
  const [raw, setRaw] = useState<string | null>(null), [resetKey, setResetKey] = useState(0);
  return <AppForm initialValues={{ cycle: originalCycle }}>
    <CycleFields modeDisabled={raw !== null} numericControls={{
      day: { onInput: setRaw, resetKey }, days: { onInput: setRaw, resetKey },
    }} />
    <Button type="button" onClick={() => { setRaw(null); setResetKey((key) => key + 1); }}>Discard cycle input</Button>
    <output aria-label="Captured cycle input">{JSON.stringify(raw)}</output>
    <FormValues />
  </AppForm>;
}
it("exposes both account-cycle numeric inputs while mode gating and inner reset preserve Form settings", async (context) => {
  const owner = ownedClickScenario(context);
  render(<CycleProbe />);
  const day = await screen.findByLabelText("每月几号") as HTMLInputElement;
  owner.assertActive();
  await owner.click(() => day);
  owner.change(() => day, { target: { value: "-" } });
  expect(screen.getByLabelText("Captured cycle input").textContent).toBe('"-"');
  expect((screen.getByRole("combobox", { name: "流量重置规则" }) as HTMLInputElement).disabled).toBe(true);
  expect(values()).toEqual({ cycle: originalCycle });
  await owner.click(() => screen.getByRole("button", { name: "Discard cycle input" }));
  expect((screen.getByLabelText("每月几号") as HTMLInputElement).value).toBe("15");
  expect((screen.getByRole("combobox", { name: "流量重置规则" }) as HTMLInputElement).disabled).toBe(false);
  await owner.click(() => screen.getByRole("combobox", { name: "流量重置规则" }));
  const fixedDays = await screen.findByRole("option", { name: "固定天数周期" });
  owner.assertActive();
  await owner.click(() => fixedDays);
  const days = await screen.findByLabelText("每周期天数") as HTMLInputElement;
  owner.assertActive();
  await owner.click(() => days);
  owner.change(() => days, { target: { value: "." } });
  expect(screen.getByLabelText("Captured cycle input").textContent).toBe('"."');
  expect((screen.getByRole("combobox", { name: "流量重置规则" }) as HTMLInputElement).disabled).toBe(true);
  await owner.click(() => screen.getByRole("button", { name: "Discard cycle input" }));
  expect((screen.getByLabelText("每周期天数") as HTMLInputElement).value).toBe("7");
  expect(values()).toEqual({ cycle: { ...originalCycle, mode: "fixed-days" } });
});
