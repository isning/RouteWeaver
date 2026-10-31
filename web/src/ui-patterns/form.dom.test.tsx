// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumericInput } from "./numeric-input";
import { AppField, AppForm, useForm, useWatch } from "./form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("labels a nested field and associates its validation error", async () => {
  const finish = vi.fn();
  render(<AppForm onFinish={finish}>
    <AppField name={["connection", "host"]} label="连接地址" description="填写域名或 IP" rules={[{ required: true, message: "请输入连接地址" }]}>
      <Input />
    </AppField>
    <Button type="submit">保存</Button>
  </AppForm>);
  const input = screen.getByLabelText("连接地址");
  expect(input.getAttribute("aria-describedby")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  const error = await screen.findByText("请输入连接地址");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toContain(error.id);
  expect(finish).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "example.com" } });
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(finish).toHaveBeenCalledWith({ connection: { host: "example.com" } });
});

it.each([Checkbox, Switch])("uses the control's native checked event contract", async (Control) => {
  const finish = vi.fn();
  render(<AppForm initialValues={{ enabled: false }} onFinish={finish}>
    <AppField name="enabled" label="启用" trigger="onCheckedChange" valuePropName="checked">
      <Control />
    </AppField>
    <Button type="submit">保存</Button>
  </AppForm>);
  await userEvent.click(screen.getByLabelText("启用"));
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(finish).toHaveBeenCalledWith({ enabled: true });
});

it("preserves hidden conditional values and distinguishes programmatic setters from user edits", async () => {
  const changed = vi.fn();
  function Probe() {
    const [form] = useForm();
    const show = useWatch("show", form);
    return <AppForm form={form} initialValues={{ show: true, host: "retained.example" }} onValuesChange={changed}>
      <AppField name="show" label="显示" trigger="onCheckedChange" valuePropName="checked"><Switch /></AppField>
      {show && <AppField name="host" label="地址"><Input /></AppField>}
      <Button onClick={() => form.setFieldValue("show", true)}>显示地址</Button>
      <AppField noStyle shouldUpdate>{(state) => <output aria-label="所有值">{JSON.stringify(state.getFieldsValue(true))}</output>}</AppField>
    </AppForm>;
  }
  render(<Probe />);
  await userEvent.click(screen.getByLabelText("显示"));
  expect(screen.queryByLabelText("地址")).toBeNull();
  expect(screen.getByLabelText("所有值").textContent).toContain("retained.example");
  expect(changed).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "显示地址" }));
  expect((screen.getByLabelText("地址") as HTMLInputElement).value).toBe("retained.example");
  expect(changed).toHaveBeenCalledTimes(1);
});

it("inherits form disabled state without changing the stored values", () => {
  render(<AppForm disabled initialValues={{ name: "saved" }}>
    <AppField name="name" label="名称"><Input /></AppField>
  </AppForm>);
  expect((screen.getByLabelText("名称") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("saved");
});

it("validates numeric changes on the native value trigger", async () => {
 render(<AppForm initialValues={{ count: 1 }}><AppField name="count" label="数量" trigger="onValueChange" rules={[{type:"integer",min:1,max:3,message:"数量范围为 1–3"}]}><NumericInput /></AppField></AppForm>);
 fireEvent.change(screen.getByLabelText("数量"),{target:{value:"9"}});
 expect(await screen.findByText("数量范围为 1–3")).toBeTruthy();
 expect(screen.getByLabelText("数量").getAttribute("aria-invalid")).toBe("true");
});
it.each([Checkbox, Switch])("keeps native toggle sizing isolated from full-width field layout", async (Control) => {
  render(<AppForm><AppField name="confirmed" label="确认操作" description="执行前请确认目标。" trigger="onCheckedChange" valuePropName="checked"><Control /></AppField></AppForm>);
  const control = screen.getByLabelText("确认操作");
  // Field's vertical direct-child width rule must stretch a layout wrapper,
  // never the checkbox/switch itself. Pixel sizing is a browser assertion.
  expect(control.parentElement?.getAttribute("data-slot")).not.toBe("field");
  expect(control.closest('[data-slot="field"]')).toBeTruthy();
  expect(control.getAttribute("aria-describedby")).toContain(screen.getByText("执行前请确认目标。").id);
  await userEvent.click(control);
  expect(control.getAttribute("aria-checked")).toBe("true");
});
