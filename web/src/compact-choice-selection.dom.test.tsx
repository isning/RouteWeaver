// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChoiceSelect } from "./ui-patterns/choice-select";
import { UIProviders } from "./ui-patterns/providers";
import { holdPopoverExit } from "./test-support/hold-popover-exit";
import { AppForm } from "./ui-patterns/form";
import { ConnectionFields } from "./ConnectionFields";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the current non-first endpoint protocol when opened and confirmed without navigation", async () => {
  function ProtocolChoice() {
    const [value, setValue] = useState<string | undefined>("vless");
    return (
      <UIProviders>
        <ChoiceSelect
          aria-label="协议"
          searchable={false}
          value={value}
          onValueChange={setValue}
          options={[
            { value: "socks", label: "SOCKS5" },
            { value: "shadowsocks", label: "Shadowsocks" },
            { value: "vless", label: "VLESS" },
            { value: "trojan", label: "Trojan" },
            { value: "vmess", label: "VMess AEAD" },
          ]}
        />
        <output aria-label="当前协议">{value}</output>
      </UIProviders>
    );
  }
  render(<ProtocolChoice />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "协议" });
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "协议" }));
  expect(screen.getByRole("option", { name: "VLESS" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("listbox", { name: "协议" }).getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "VLESS" }).id);
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("当前协议").textContent).toBe("vless");
  expect(trigger.textContent).toContain("VLESS");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}{Enter}");
  expect(screen.getByLabelText("当前协议").textContent).toBe("vless");
});


it("discards canceled keyboard navigation when the same compact picker reopens before exit finishes", async () => {
  const finishExit = holdPopoverExit();
  function ProtocolChoice() {
    const [value, setValue] = useState<string | undefined>("vless");
    return (
      <UIProviders>
        <ChoiceSelect
          aria-label="协议"
          searchable={false}
          value={value}
          onValueChange={setValue}
          options={[
            { value: "socks", label: "SOCKS5" },
            { value: "vless", label: "VLESS" },
            { value: "trojan", label: "Trojan" },
          ]}
        />
        <output aria-label="当前协议">{value}</output>
      </UIProviders>
    );
  }
  render(<ProtocolChoice />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "协议" });
  await user.tab();
  await user.keyboard("{Enter}{ArrowDown}");
  expect(screen.getByRole("option", { name: "Trojan" }).getAttribute("aria-selected")).toBe("true");
  const content = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  await user.keyboard("{Escape}");
  expect(content.isConnected).toBe(true);
  expect(screen.getByLabelText("当前协议").textContent).toBe("vless");
  // A click reopens the actual retained popover, without assigning focus or
  // completing its exit animation to manufacture a new mount.
  await user.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "协议" }));
  expect(screen.getByRole("listbox", { name: "协议" }).getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "VLESS" }).id);
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("当前协议").textContent).toBe("vless");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  finishExit(content);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});


it("submits the original protocol and transport after confirming the actual connection fields without navigation", async () => {
  function ConnectionEditor() {
    const [saved, setSaved] = useState<{
      connection: { protocol: string; transport: { type: string } };
    }>();
    return (
      <UIProviders>
        <AppForm
          initialValues={{ connection: {
            host: "example.test",
            port: 443,
            protocol: "vless",
            uuid: "00000000-0000-4000-8000-000000000001",
            transport: { type: "grpc", serviceName: "route" },
          } }}
          onFinish={setSaved}
        >
          <ConnectionFields />
          <button type="submit">保存连接</button>
        </AppForm>
        <output aria-label="已保存协议">{saved?.connection.protocol}</output>
        <output aria-label="已保存传输">{saved?.connection.transport.type}</output>
      </UIProviders>
    );
  }
  render(<ConnectionEditor />);
  const user = userEvent.setup();
  for (const name of ["协议", "传输方式"]) {
    const trigger = screen.getByRole("combobox", { name });
    // Follow ordinary document Tab order, including the other real form fields.
    for (let steps = 0; steps < 12 && document.activeElement !== trigger; steps++)
      await user.tab();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }
  await user.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() => expect(screen.getByLabelText("已保存协议").textContent).toBe("vless"));
  expect(screen.getByLabelText("已保存传输").textContent).toBe("grpc");
});

it.each(["disabled", "missing"])("does not silently replace a %s current transport, but still permits an explicit replacement", async (availability) => {
  function TransportChoice() {
    const [value, setValue] = useState<string | undefined>("ws");
    return (
      <UIProviders>
        <ChoiceSelect
          aria-label="传输方式"
          searchable={false}
          value={value}
          onValueChange={setValue}
          options={[
            { value: "tcp", label: "TCP" },
            ...(availability === "disabled" ? [{ value: "ws", label: "WebSocket（此核心不支持）", disabled: true }] : []),
            { value: "grpc", label: "gRPC" },
          ]}
        />
        <output aria-label="当前传输">{value}</output>
      </UIProviders>
    );
  }
  render(<TransportChoice />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "传输方式" });
  await user.tab();
  await user.keyboard("{Enter}{Enter}");
  expect(screen.getByLabelText("当前传输").textContent).toBe("ws");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await user.keyboard("{ArrowDown}{Escape}");
  expect(screen.getByLabelText("当前传输").textContent).toBe("ws");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}{ArrowDown}{Enter}");
  expect(screen.getByLabelText("当前传输").textContent).toBe("tcp");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});


it.each(["second", "__clear"])("keeps the compact choice %s distinct from its clear action", async (initialValue) => {
  function ClearableChoice() {
    const [value, setValue] = useState<string | undefined>(initialValue);
    return (
      <UIProviders>
        <ChoiceSelect
          aria-label="模板版本"
          searchable={false}
          clearable
          value={value}
          onValueChange={setValue}
          options={[
            { value: "first", label: "v1" },
            { value: initialValue, label: "v2" },
          ]}
        />
        <output aria-label="当前版本">{value ?? "未选择"}</output>
      </UIProviders>
    );
  }
  render(<ClearableChoice />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "模板版本" });
  await user.tab();
  await user.keyboard("{Enter}{Enter}");
  expect(screen.getByLabelText("当前版本").textContent).toBe(initialValue);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}{Home}");
  expect(screen.getByRole("listbox", { name: "模板版本" }).getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "清除选择" }).id);
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("当前版本").textContent).toBe("未选择");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
