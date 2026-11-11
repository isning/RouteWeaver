// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChoiceSelect } from "./ui-patterns/choice-select";
import { holdPopoverExit } from "./test-support/hold-popover-exit";
import { UIProviders } from "./ui-patterns/providers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])("changes an editable endpoint protocol using only the keyboard (after held exit=%s)", async (retainedExit) => {
  const finishExit = retainedExit ? holdPopoverExit() : undefined;
  function ProtocolChoice() {
    const [value, setValue] = useState<string | undefined>("socks");
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
      </UIProviders>
    );
  }
  render(<ProtocolChoice />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "协议" });
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("option", { name: "Shadowsocks" })).toBeTruthy();
  if (retainedExit) {
    const closing = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    await user.keyboard("{Escape}");
    expect(closing.isConnected).toBe(true);
    expect(closing.hasAttribute("inert")).toBe(true);
    finishExit!(closing);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("option", { name: "Shadowsocks" })).toBeTruthy();
  }
  const list = screen.getByRole("listbox", { name: "协议" });
  expect(document.activeElement).toBe(list);
  await user.keyboard("{ArrowDown}");
  expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Shadowsocks" }).id);
  expect(screen.getByRole("option", { name: "Shadowsocks" }).getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{Enter}");
  expect(trigger.textContent).toContain("Shadowsocks");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});


it.each([false, true])("changes an editable endpoint transport using only the keyboard (after held exit=%s)", async (retainedExit) => {
  const finishExit = retainedExit ? holdPopoverExit() : undefined;
  function TransportChoice() {
    const [value, setValue] = useState<string | undefined>("tcp");
    return (
      <UIProviders>
        <ChoiceSelect
          aria-label="传输方式"
          searchable={false}
          value={value}
          onValueChange={setValue}
          options={[
            { value: "tcp", label: "TCP" },
            { value: "ws", label: "WebSocket" },
            { value: "httpupgrade", label: "HTTP Upgrade" },
            { value: "grpc", label: "gRPC" },
          ]}
        />
      </UIProviders>
    );
  }
  render(<TransportChoice />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "传输方式" });
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(screen.getByRole("option", { name: "WebSocket" })).toBeTruthy();
  if (retainedExit) {
    const closing = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    await user.keyboard("{Escape}");
    expect(closing.isConnected).toBe(true);
    expect(closing.hasAttribute("inert")).toBe(true);
    finishExit!(closing);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Enter}");
  }
  const list = screen.getByRole("listbox", { name: "传输方式" });
  expect(document.activeElement).toBe(list);
  await user.keyboard("{ArrowDown}");
  expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "WebSocket" }).id);
  await user.keyboard("{Enter}");
  expect(trigger.textContent).toContain("WebSocket");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});


it("skips unavailable REALITY transports and cancels without changing the transport", async () => {
  const changed = vi.fn();
  render(
    <UIProviders>
      <label id="transport-label">传输方式</label>
      <ChoiceSelect
        aria-labelledby="transport-label"
        searchable={false}
        value="tcp"
        onValueChange={changed}
        options={[
          { value: "tcp", label: "TCP" },
          { value: "ws", label: "WebSocket", disabled: true },
          { value: "httpupgrade", label: "HTTP Upgrade", disabled: true },
          { value: "grpc", label: "gRPC" },
        ]}
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "传输方式" });
  await user.tab();
  await user.keyboard("{Enter}{ArrowDown}");
  const list = screen.getByRole("listbox", { name: "传输方式" });
  expect(document.activeElement).toBe(list);
  expect(list.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "gRPC" }).id);
  expect(screen.getByRole("option", { name: "gRPC" }).getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(trigger.textContent).toContain("TCP");
  expect(changed).not.toHaveBeenCalled();
  await user.keyboard("{Enter}{ArrowDown}{Enter}");
  expect(changed).toHaveBeenCalledExactlyOnceWith("grpc");
});

it("ends a compact keyboard interaction when the task becomes read-only", async () => {
  const changed = vi.fn();
  const choices = (disabled: boolean) => (
    <UIProviders>
      <ChoiceSelect
        aria-label="协议"
        searchable={false}
        value="socks"
        disabled={disabled}
        onValueChange={changed}
        options={[
          { value: "socks", label: "SOCKS5" },
          { value: "vless", label: "VLESS" },
        ]}
      />
      <button>下一项</button>
    </UIProviders>
  );
  const view = render(choices(false));
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "协议" });
  await user.tab();
  await user.keyboard("{Enter}{ArrowDown}");
  view.rerender(choices(true));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger).toHaveProperty("disabled", true);
  expect(screen.queryByRole("listbox")).toBeNull();
  await user.keyboard("{Enter}");
  expect(trigger.textContent).toContain("SOCKS5");
  expect(changed).not.toHaveBeenCalled();
});

it("supports keyboard selection when a pointer reopens the same compact picker before exit finishes", async () => {
  const finishExit = holdPopoverExit();
  function ProtocolChoice() {
    const [value, setValue] = useState<string | undefined>("socks");
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
          ]}
        />
      </UIProviders>
    );
  }
  render(<ProtocolChoice />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "协议" });
  await user.tab();
  await user.keyboard("{Enter}");
  const content = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const list = screen.getByRole("listbox", { name: "协议" });
  await user.keyboard("{Escape}");
  expect(content.isConnected).toBe(true);
  expect(content.hasAttribute("inert")).toBe(true);
  // Clicking the actual trigger is a supported mixed-input task; no test focus
  // assignment or animation completion is used to manufacture this reopen.
  await user.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(trigger.getAttribute("aria-controls")!)).toBe(content);
  expect(screen.getByRole("listbox", { name: "协议" })).toBe(list);
  expect(content.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(list);
  await user.keyboard("{ArrowDown}");
  const option = screen.getByRole("option", { name: "Shadowsocks" });
  expect(list.getAttribute("aria-activedescendant")).toBe(option.id);
  expect(option.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{Enter}");
  expect(trigger.textContent).toContain("Shadowsocks");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  finishExit(content);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
