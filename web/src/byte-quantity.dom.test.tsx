// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";
import { AppForm, AppField } from "./ui-patterns/form";
import { ByteQuantityInput } from "./ByteQuantityInput";
import { byteQuantityRules } from "./PolicyFields";
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
});
afterEach(cleanup);
it.each([
  ["GiB", 1073741824, "1"],
  ["Mbps", 12500000, "100"],
] as const)(
  "displays %s while retaining integer-byte form storage",
  async (unit, bytes, display) => {
    const finish = vi.fn();
    render(
      <AppForm initialValues={{ amount: bytes }} onFinish={finish}>
        <AppField name="amount" label="Amount" rules={byteQuantityRules}>
          <ByteQuantityInput unit={unit} />
        </AppField>
        <Button type="submit">Review</Button>
      </AppForm>,
    );
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      display,
    );
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(finish).toHaveBeenCalledWith({ amount: bytes });
  },
);
it.each([
  ["GiB", "0.5", 536870912],
  ["Mbps", "100", 12500000],
] as const)(
  "converts a deliberate %s edit without rounding",
  (unit, input, bytes) => {
    const change = vi.fn();
    render(<ByteQuantityInput unit={unit} value={0} onChange={change} />);
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: input },
    });
    expect(change).toHaveBeenLastCalledWith(bytes);
  },
);
it.each([1, Number.MAX_SAFE_INTEGER])(
  "preserves an untouched exact %s-byte value in either display unit",
  async (bytes) => {
    for (const unit of ["GiB", "Mbps"] as const) {
      const finish = vi.fn();
      const view = render(
        <AppForm initialValues={{ amount: bytes }} onFinish={finish}>
          <AppField name="amount" rules={byteQuantityRules}>
            <ByteQuantityInput unit={unit} />
          </AppField>
          <Button type="submit">Review</Button>
        </AppForm>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Review" }));
      expect(finish).toHaveBeenCalledWith({ amount: bytes });
      view.unmount();
    }
  },
);
it("does not round fractional bytes into an accepted limit", async () => {
  const finish = vi.fn();
  render(
    <AppForm initialValues={{ amount: 0 }} onFinish={finish}>
      <AppField name="amount" rules={byteQuantityRules}>
        <ByteQuantityInput unit="GiB" />
      </AppField>
      <Button type="submit">Review</Button>
    </AppForm>,
  );
  fireEvent.change(screen.getByRole("spinbutton"), {
    target: { value: "0.1" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText(
    "请输入可精确换算为整数字节的非负数值，且不超过安全范围",
  );
  expect(finish).not.toHaveBeenCalled();
});
it("keeps zero explicit and clearing distinct from an unlimited limit", () => {
  const change = vi.fn();
  render(<ByteQuantityInput value={0} onChange={change} unit="GiB" />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("0");
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
  expect(change).toHaveBeenLastCalledWith(null);
});

it("restores an opt-in raw spelling without treating it as a numeric change", () => {
  const change = vi.fn(), input = vi.fn();
  const view = render(<ByteQuantityInput unit="Mbps" value={250000} initialInputText="1e" onChange={change} onInput={input} />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("1e");
  expect(change).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
  view.rerender(<ByteQuantityInput unit="Mbps" value={375000} initialInputText="1e" onChange={change} onInput={input} />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("3");
  view.rerender(<ByteQuantityInput unit="Mbps" value={250000} initialInputText="1e" onChange={change} onInput={input} />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("2");
  expect(change).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
});

it("keeps a deliberately accepted exact spelling after an opt-in raw restart", () => {
  const change = vi.fn();
  const view = render(<ByteQuantityInput unit="Mbps" value={250000} initialInputText="-" onChange={change} />);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "+03.000" } });
  expect(change).toHaveBeenLastCalledWith(375000);
  view.rerender(<ByteQuantityInput unit="Mbps" value={375000} initialInputText="-" onChange={change} />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("+03.000");
});

it.each([undefined, "+01.000"])("reformats an authoritative unit change at unchanged bytes with initial spelling %j", (initialInputText) => {
  const change = vi.fn();
  const view = render(<ByteQuantityInput unit="GiB" value={1073741824} initialInputText={initialInputText} onChange={change} />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(initialInputText ?? "1");
  view.rerender(<ByteQuantityInput unit="Mbps" value={1073741824} initialInputText={initialInputText} onChange={change} />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("8589.934592");
  view.rerender(<ByteQuantityInput unit="GiB" value={1073741824} initialInputText={initialInputText} onChange={change} />);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("1");
  expect(change).not.toHaveBeenCalled();
});
