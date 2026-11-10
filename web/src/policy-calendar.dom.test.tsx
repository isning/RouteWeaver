// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PolicyDateInput } from "./PolicyDateInput";
import { AppField, AppForm } from "./ui-patterns/form";
import { holdPopoverExit } from "./test-support/hold-popover-exit";
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("displays a timezone-explicit calendar without rewriting original precision on open or close", async () => {
  const change = vi.fn();
  render(
    <>
      <label htmlFor="date">开通时间</label>
      <PolicyDateInput
        id="date"
        value="2026-02-03T04:05:06.123456789+05:30"
        onChange={change}
      />
    </>,
  );
  const input = screen.getByLabelText("开通时间") as HTMLInputElement;
  expect(input.value).toBe("2026-02-03 06:35:06");
  expect(screen.getByText("UTC+8")).toBeTruthy();
  await userEvent.click(input);
  await userEvent.keyboard("{Escape}");
  expect(change).not.toHaveBeenCalled();
});
it("keeps invalid stored timestamps visible for explicit repair", () => {
  render(
    <label>
      日期
      <PolicyDateInput value="not-a-date" />
    </label>,
  );
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
    "not-a-date",
  );
});
it("commits a selected calendar day to its controlled RFC3339 value", async () => {
  const change = vi.fn();
  render(
    <>
      <label htmlFor="new-date">新日期</label>
      <PolicyDateInput id="new-date" onChange={change} />
    </>,
  );
  await userEvent.click(screen.getByLabelText("新日期"));
  const cell = screen.getAllByRole("button", { name: /\d+年\d+月\d+日/ })[10];
  await userEvent.click(cell);
  await userEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenCalled();
});
it("commits selected wall time in UTC+8 across a UTC date boundary", async () => {
  const change = vi.fn();
  render(
    <>
      <PolicyDateInput
        id="boundary"
        value="2026-02-03T04:05:06+05:30"
        onChange={change}
      />
    </>,
  );
  await userEvent.click(screen.getByRole("textbox"));
  const nextDay = screen.getByRole("button", { name: "2026年2月4日" });
  await userEvent.click(nextDay);
  expect(change).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenLastCalledWith("2026-02-03T22:35:06.000Z");
});
it("clears an optional expiry only through an explicit clear action", async () => {
  const change = vi.fn();
  render(<PolicyDateInput value="2026-02-03T00:00:00Z" onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "清除日期" }));
  expect(change).toHaveBeenLastCalledWith("");
});
it("does not normalize an impossible stored calendar date", () => {
  render(<PolicyDateInput value="2026-02-30T08:00:00+08:00" />);
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
    "2026-02-30T08:00:00+08:00",
  );
});

it("uses Chinese calendar weekday labels under the application locale", async () => {
  render(
    <>
      <PolicyDateInput />
    </>,
  );
  await userEvent.click(screen.getByRole("textbox"));
  expect(screen.getByText("一", { selector: "th" })).toBeTruthy();
  expect(screen.queryByText("Mo", { selector: "th" })).toBeNull();
});

it.each(["0001-01-01T00:00:00Z", "2026-02-03T04:05:06.123456789+05:30"])("preserves the exact unchanged instant when confirming %s", async value => {
 const change=vi.fn();render(<PolicyDateInput value={value} onChange={change}/>);
 const field=screen.getByRole("textbox") as HTMLInputElement;
 if(value.startsWith("0001"))expect(field.value).toBe("0001-01-01 08:00:00");
 await userEvent.click(field);
 await userEvent.click(screen.getByRole("button",{name:"确定"}));
 expect(change).toHaveBeenCalledWith(value);
});
it("bounds the picker to Radix available height without changing the stored date on cancellation", async () => {
  const change = vi.fn();
  render(<><label htmlFor="bounded-date">到期时间</label><PolicyDateInput id="bounded-date" value="2026-11-01T00:00:00Z" onChange={change} /></>);
  await userEvent.click(screen.getByLabelText("到期时间"));
  const picker = screen.getByRole("dialog", { name: "选择日期与时间" });
  // jsdom does not lay out Radix collision boundaries; this locks the explicit
  // size/scroll integration. Real viewport fitting is checked in the browser.
  expect(picker.classList.contains("max-h-(--radix-popover-content-available-height)")).toBe(true);
  expect(picker.classList.contains("overflow-y-auto")).toBe(true);
  expect(screen.getByRole("button", { name: "下个月" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "确定" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(change).not.toHaveBeenCalled();
});

// Run this public-control seam in separate processes with TZ=America/New_York,
// TZ=Australia/Lord_Howe and TZ=UTC. Changing TZ inside jsdom is not reliable.
it.each([
  ["2026-03-08T02:30:19.123456789+08:00", "2026-03-08 02:30:19"],
  ["2026-11-01T01:30:19.123456789+08:00", "2026-11-01 01:30:19"],
  ["2026-10-04T02:15:19.123456789+08:00", "2026-10-04 02:15:19"],
  ["2026-04-05T01:45:19.123456789+08:00", "2026-04-05 01:45:19"],
])("preserves fixed UTC+8 wall time and unchanged precision for %s", async (value, display) => {
  const change = vi.fn();
  render(<PolicyDateInput value={value} onChange={change} />);
  const field = screen.getByRole("textbox") as HTMLInputElement;
  expect(field.value).toBe(display);
  await userEvent.click(field);
  expect((screen.getByLabelText("时间（UTC+8）") as HTMLInputElement).value).toBe(display.slice(11));
  await userEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenCalledWith(value);
});

it.each([
  ["2026-03-07T02:30:19.123456789+08:00", "2026年3月8日", "2026-03-07T18:30:19.123Z"],
  ["2026-10-03T02:15:19.123456789+08:00", "2026年10月4日", "2026-10-03T18:15:19.123Z"],
  ["2026-10-31T01:30:19.123456789+08:00", "2026年11月1日", "2026-10-31T17:30:19.123Z"],
  ["2026-04-04T01:45:19.123456789+08:00", "2026年4月5日", "2026-04-04T17:45:19.123Z"],
])("selects a day without local DST normalization from %s", async (value, day, expected) => {
  const change = vi.fn();
  const pending = vi.fn();
  render(<PolicyDateInput value={value} onChange={change} onPendingChange={pending} />);
  await userEvent.click(screen.getByRole("textbox"));
  await userEvent.click(screen.getByRole("button", { name: day }));
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(change).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenCalledWith(expected);
  expect(pending).toHaveBeenLastCalledWith(false);
});

it("edits a DST-gap wall time, reverts exactly, and discards canceled edits", async () => {
  const value = "2026-03-08T01:30:19.123456789+08:00";
  const change = vi.fn();
  const pending = vi.fn();
  render(<PolicyDateInput value={value} onChange={change} onPendingChange={pending} />);
  await userEvent.click(screen.getByRole("textbox"));
  fireEvent.change(screen.getByLabelText("时间（UTC+8）"), { target: { value: "02:30:19" } });
  expect(pending).toHaveBeenLastCalledWith(true);
  fireEvent.change(screen.getByLabelText("时间（UTC+8）"), { target: { value: "01:30:19" } });
  expect(pending).toHaveBeenLastCalledWith(false);
  await userEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenCalledWith(value);
  change.mockClear();
  await userEvent.click(screen.getByRole("textbox"));
  fireEvent.change(screen.getByLabelText("时间（UTC+8）"), { target: { value: "02:30:19" } });
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(change).not.toHaveBeenCalled();
  expect(pending).toHaveBeenLastCalledWith(false);
  await userEvent.click(screen.getByRole("textbox"));
  expect((screen.getByLabelText("时间（UTC+8）") as HTMLInputElement).value).toBe("01:30:19");
  fireEvent.change(screen.getByLabelText("时间（UTC+8）"), { target: { value: "02:30:19" } });
  await userEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenCalledWith("2026-03-07T18:30:19.123Z");
});


it("ends an open date draft when its owning form becomes disabled without changing the stored value", async () => {
  const value = "2026-02-03T04:05:06.123456789+05:30";
  const changed = vi.fn(), opened = vi.fn(), pending = vi.fn(), finished = vi.fn();
  const view = (disabled: boolean) => <AppForm disabled={disabled} initialValues={{ date: value }} onValuesChange={changed} onFinish={finished}>
    <AppField name="date" label="到期时间"><PolicyDateInput onOpenChange={opened} onPendingChange={pending} /></AppField>
    <button type="submit" disabled={disabled}>保存</button>
  </AppForm>;
  const mounted = render(view(false));
  const user = userEvent.setup();
  const field = screen.getByLabelText("到期时间");
  await user.click(field);
  fireEvent.change(screen.getByLabelText("时间（UTC+8）"), { target: { value: "23:10:15" } });
  expect(pending).toHaveBeenLastCalledWith(true);
  mounted.rerender(view(true));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择日期与时间" })).toBeNull());
  expect(field).toHaveProperty("disabled", true);
  expect(field).toHaveProperty("value", "2026-02-03 06:35:06");
  expect(opened.mock.calls.map(([value]) => value)).toEqual([true, false]);
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "清除日期" }));
  expect(changed).not.toHaveBeenCalled();
  mounted.rerender(view(false));
  expect(screen.queryByRole("dialog", { name: "选择日期与时间" })).toBeNull();
  await user.click(field);
  expect(screen.getByLabelText("时间（UTC+8）")).toHaveProperty("value", "06:35:06");
  await user.click(screen.getByRole("button", { name: "确定" }));
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(finished).toHaveBeenCalledWith({ date: value }));
});

it("keeps an initially disabled date closed until the owning form is enabled", async () => {
  const changed = vi.fn(), opened = vi.fn();
  const view = (disabled: boolean) => <AppForm disabled={disabled} initialValues={{ date: "2026-02-03T00:00:00Z" }} onValuesChange={changed}>
    <AppField name="date" label="到期时间"><PolicyDateInput onOpenChange={opened} /></AppField>
  </AppForm>;
  const mounted = render(view(true));
  const user = userEvent.setup();
  const field = screen.getByLabelText("到期时间");
  await user.click(field);
  fireEvent.keyDown(field, { key: "Enter" });
  await user.click(screen.getByRole("button", { name: "清除日期" }));
  expect(screen.queryByRole("dialog", { name: "选择日期与时间" })).toBeNull();
  expect(opened).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  mounted.rerender(view(false));
  field.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog", { name: "选择日期与时间" })).toBeTruthy();
  expect(opened).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
});

it("does not revive a retired date draft while its closing animation remains mounted", async () => {
  const finishExit = holdPopoverExit();
  const changed = vi.fn(), pending = vi.fn();
  const value = "2026-02-03T04:05:06.123456789+05:30";
  const view = (disabled: boolean) => <AppForm disabled={disabled} initialValues={{ date: value }} onValuesChange={changed}>
    <AppField name="date" label="到期时间"><PolicyDateInput onPendingChange={pending} /></AppField>
  </AppForm>;
  const mounted = render(view(false));
  const user = userEvent.setup();
  const field = screen.getByLabelText("到期时间");
  await user.click(field);
  const picker = screen.getByRole("dialog", { name: "选择日期与时间" });
  const time = within(picker).getByLabelText("时间（UTC+8）");
  const confirm = within(picker).getByRole("button", { name: "确定" });
  const nextDay = within(picker).getByRole("button", { name: "2026年2月4日" });
  fireEvent.change(time, { target: { value: "23:10:15" } });
  mounted.rerender(view(true));
  expect(picker.isConnected).toBe(true);
  expect(picker.getAttribute("data-state")).toBe("closed");
  mounted.rerender(view(false));
  expect(picker.isConnected).toBe(true);
  expect(picker.hasAttribute("inert")).toBe(true);
  expect(confirm).toHaveProperty("disabled", true);
  expect(time).toHaveProperty("disabled", true);
  pending.mockClear();
  await user.click(confirm);
  await user.click(nextDay);
  fireEvent.change(time, { target: { value: "22:11:12" } });
  expect(changed).not.toHaveBeenCalled();
  expect(pending).not.toHaveBeenCalled();
  finishExit(picker);
  await waitFor(() => expect(picker.isConnected).toBe(false));
  await user.click(field);
  const reopened = screen.getByRole("dialog", { name: "选择日期与时间" });
  expect(screen.getByLabelText("时间（UTC+8）")).toHaveProperty("value", "06:35:06");
  await user.click(screen.getByRole("button", { name: "确定" }));
  expect(changed).not.toHaveBeenCalled();
  finishExit(reopened);
});

it.each(["disabled", "cancelled"])("does not reclaim focus after a %s picker finishes leaving", async (reason) => {
  const finishExit = holdPopoverExit();
  const view = (disabled: boolean) => <>
    <AppForm disabled={disabled} initialValues={{ date: "2026-02-03T00:00:00Z" }}>
      <AppField name="date" label="到期时间"><PolicyDateInput /></AppField>
    </AppForm>
    <button type="button">其他任务</button>
  </>;
  const mounted = render(view(false));
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("到期时间"));
  const picker = screen.getByRole("dialog", { name: "选择日期与时间" });
  if (reason === "disabled") {
    mounted.rerender(view(true));
    mounted.rerender(view(false));
  } else await user.keyboard("{Escape}");
  const elsewhere = screen.getByRole("button", { name: "其他任务" });
  await user.click(elsewhere);
  expect(document.activeElement).toBe(elsewhere);
  finishExit(picker);
  await waitFor(() => expect(picker.isConnected).toBe(false));
  // FocusScope returns focus in the next task after actual Presence removal.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(elsewhere);
});

it.each(["取消", "确定"])("returns ordinary %s focus to its date trigger after the exit", async (action) => {
  const finishExit = holdPopoverExit();
  render(<><label htmlFor="date-return">到期时间</label><PolicyDateInput id="date-return" value="2026-02-03T00:00:00Z" /></>);
  const user = userEvent.setup();
  const field = screen.getByLabelText("到期时间");
  await user.click(field);
  const picker = screen.getByRole("dialog", { name: "选择日期与时间" });
  await user.click(within(picker).getByRole("button", { name: action }));
  expect(picker.isConnected).toBe(true);
  finishExit(picker);
  await waitFor(() => expect(document.activeElement).toBe(field));
});
