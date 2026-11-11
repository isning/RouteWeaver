// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";
import { AppForm as Form, useForm } from "@/ui-patterns/form";
import { UIProviders } from "@/ui-patterns/providers";
import { ConnectionFields, normalizeConnection } from "./ConnectionFields";
import type { Connection } from "./types";

afterEach(cleanup);

const connection: Connection = {
  protocol: "vless",
  host: "endpoint.test",
  port: 443,
  uuid: "00000000-0000-4000-8000-000000000001",
};

it("identifies implicit TCP as current without changing the draft when navigation is canceled", async () => {
  const changed = vi.fn();
  const saved: Connection[] = [];
  const raw: Connection[] = [];
  render(
    <UIProviders>
      <Form
        initialValues={{ connection }}
        onValuesChange={changed}
        onFinish={(values) => {
          raw.push(values.connection);
          saved.push(normalizeConnection(values.connection));
        }}
      >
        <ConnectionFields />
        <Button type="submit">Save connection</Button>
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "传输方式" });
  expect(trigger.textContent).toBe("TCP");
  await user.click(trigger);
  const tcp = screen.getByRole("option", { name: "TCP" });
  const list = screen.getByRole("listbox", { name: "传输方式" });
  expect(tcp.querySelector("svg")?.classList.contains("opacity-100")).toBe(
    true,
  );
  expect(tcp.getAttribute("aria-selected")).toBe("true");
  expect(list.getAttribute("aria-activedescendant")).toBe(tcp.id);
  expect(document.activeElement).toBe(list);

  await user.keyboard("{ArrowDown}");
  const websocket = screen.getByRole("option", { name: "WebSocket" });
  expect(list.getAttribute("aria-activedescendant")).toBe(websocket.id);
  expect(websocket.getAttribute("aria-selected")).toBe("true");
  expect(websocket.querySelector("svg")?.classList.contains("opacity-0")).toBe(
    true,
  );
  expect(tcp.querySelector("svg")?.classList.contains("opacity-100")).toBe(
    true,
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(trigger.textContent).toBe("TCP");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(changed).not.toHaveBeenCalled();
  expect(saved).toEqual([]);

  await user.keyboard("{Enter}");
  expect(
    screen
      .getByRole("listbox", { name: "传输方式" })
      .getAttribute("aria-activedescendant"),
  ).toBe(screen.getByRole("option", { name: "TCP" }).id);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(changed).not.toHaveBeenCalled();
  expect(raw[0].transport?.type).toBeUndefined();
  expect(JSON.parse(JSON.stringify(saved[0]))).toEqual(connection);
});

it.each([
  { prefix: ["connection"], initialValues: { connection } },
  {
    prefix: ["listener", "connection"],
    initialValues: { listener: { connection } },
  },
])(
  "confirms implicit TCP at $prefix without materializing a transport or touching the form",
  async ({ prefix, initialValues }) => {
    const changed = vi.fn();
    const saved: Connection[] = [];
    const untouchedStore: Connection[] = [];
    const touched: boolean[] = [];
    function Editor() {
      const [form] = useForm();
      return (
        <UIProviders>
          <Form
            form={form}
            initialValues={initialValues}
            onValuesChange={changed}
            onFinish={(values) => {
              untouchedStore.push(form.getFieldValue(prefix));
              touched.push(form.isFieldsTouched());
              saved.push(
                normalizeConnection(
                  prefix.length === 1
                    ? values.connection
                    : values.listener.connection,
                ),
              );
            }}
          >
            <ConnectionFields prefix={prefix} />
            <Button type="submit">Save connection</Button>
          </Form>
        </UIProviders>
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox", { name: "传输方式" });
    await user.click(trigger);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toBe("TCP");
    expect(changed).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(touched).toEqual([false]);
    expect(untouchedStore).toEqual([connection]);
    expect(JSON.parse(JSON.stringify(saved[0]))).toEqual(connection);
  },
);

it.each([
  { name: "explicit TCP", transport: { type: "tcp" }, current: "TCP" },
  {
    name: "unsupported WebSocket",
    transport: { type: "ws", path: "/retained" },
    current: "WebSocket（此核心不支持）",
  },
  {
    name: "unknown transport",
    transport: { type: "future-transport" },
    current: "future-transport（此核心不支持）",
  },
  {
    name: "missing type in a present object",
    transport: {},
    current: undefined,
  },
  {
    name: "empty type in a present object",
    transport: { type: "" },
    current: undefined,
  },
])(
  "preserves $name instead of treating it as implicit TCP",
  async ({ transport, current }) => {
    const initial = { ...connection, transport };
    const changed = vi.fn();
    const saved: unknown[] = [];
    const stored: unknown[] = [];
    function Editor() {
      const [form] = useForm();
      return (
        <UIProviders>
          <Form
            form={form}
            initialValues={{ connection: initial }}
            onValuesChange={changed}
            onFinish={(values) => {
              saved.push(values.connection.transport);
              stored.push(form.getFieldsValue(true).connection);
            }}
          >
            <ConnectionFields server managedEntryTarget />
            <Button type="submit">Save connection</Button>
          </Form>
        </UIProviders>
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox", { name: "传输方式" });
    await user.click(trigger);
    const tcp = screen.getByRole("option", { name: "TCP" });
    expect(tcp.querySelector("svg")?.classList.contains("opacity-100")).toBe(
      current === "TCP",
    );
    if (current && current !== "TCP") {
      const option = screen.getByRole("option", { name: current });
      expect(option.getAttribute("aria-disabled")).toBe("true");
      expect(
        option.querySelector("svg")?.classList.contains("opacity-100"),
      ).toBe(true);
      expect(trigger.textContent).toBe(current);
    }
    await user.keyboard("{ArrowDown}{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(changed).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(saved[0]))).toEqual(transport);
    expect(stored).toEqual([initial]);
  },
);

it("applies an explicit WebSocket choice and returns to implicit TCP on form reset", async () => {
  const changed = vi.fn();
  const saved: Connection[] = [];
  function Editor() {
    const [form] = useForm();
    return (
      <UIProviders>
        <Form
          form={form}
          initialValues={{ connection }}
          onValuesChange={changed}
          onFinish={(values) =>
            saved.push(normalizeConnection(values.connection))
          }
        >
          <ConnectionFields />
          <Button type="submit">Save connection</Button>
          <Button type="button" onClick={() => form.resetFields()}>
            Reset connection
          </Button>
        </Form>
      </UIProviders>
    );
  }
  render(<Editor />);
  const user = userEvent.setup();
  const trigger = () => screen.getByRole("combobox", { name: "传输方式" });
  await user.click(trigger());
  await user.keyboard("{ArrowDown}{Enter}");
  expect(trigger().textContent).toBe("WebSocket");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0]).toEqual({
    connection: { transport: { type: "ws" } },
  });
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(JSON.parse(JSON.stringify(saved[0]))).toEqual({
    ...connection,
    transport: { type: "ws" },
  });

  await user.click(screen.getByRole("button", { name: "Reset connection" }));
  expect(trigger().textContent).toBe("TCP");
  await user.click(trigger());
  const tcp = screen.getByRole("option", { name: "TCP" });
  expect(tcp.querySelector("svg")?.classList.contains("opacity-100")).toBe(
    true,
  );
  expect(
    screen
      .getByRole("listbox", { name: "传输方式" })
      .getAttribute("aria-activedescendant"),
  ).toBe(tcp.id);
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(saved).toHaveLength(2));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(JSON.parse(JSON.stringify(saved[1]))).toEqual(connection);
});
