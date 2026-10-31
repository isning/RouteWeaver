// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";
import { UIProviders } from "@/ui-patterns/providers";
import { AppForm as Form } from "@/ui-patterns/form";
import { ConnectionFields, normalizeConnection } from "./ConnectionFields";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
afterEach(cleanup);

it("presents principal authentication without shared UUID or Flow controls", async () => {
  const save = vi.fn();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: { host: "0.0.0.0", port: 443, protocol: "vless" },
        }}
        onFinish={save}
      >
        <ConnectionFields server authentication="principals" />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  for (const name of ["监听地址", "协议与认证", "传输设置", "连接安全"]) {
    expect(screen.getByRole("group", { name }).tagName).toBe("FIELDSET");
  }
  expect(screen.queryByLabelText("用户 UUID")).toBeNull();
  expect(screen.queryByLabelText("Flow")).toBeNull();
  expect(
    screen.getByText(/请在公开线路的「配置用户入口」中管理 UUID/),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].connection).not.toHaveProperty("uuid");
  expect(save.mock.calls[0][0].connection).not.toHaveProperty("flow");
});

it("requires a valid UUID for ordinary VLESS listeners and keeps Flow editable", async () => {
  const save = vi.fn();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: { host: "0.0.0.0", port: 443, protocol: "vless" },
        }}
        onFinish={save}
      >
        <ConnectionFields server />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "高级协议参数" }));
  expect(screen.getByLabelText("Flow")).toBeTruthy();
  await user.type(screen.getByLabelText("用户 UUID"), "invalid");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("请输入有效 UUID")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText("用户 UUID"));
  await user.type(
    screen.getByLabelText("用户 UUID"),
    "00000000-0000-4000-8000-000000000001",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].connection.uuid).toBe(
    "00000000-0000-4000-8000-000000000001",
  );
});

it("limits a new known managed listener to ordinary TLS and TCP without hiding client template fields", async () => {
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "0.0.0.0",
            port: 1443,
            protocol: "vless",
            tls: { enabled: true },
          },
        }}
      >
        <ConnectionFields
          server
          authentication="principals"
          managedEntryTarget
        />
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  expect(screen.queryByRole("button", { name: "高级协议参数" })).toBeNull();
  expect(screen.getByLabelText("服务器名称（SNI）")).toBeTruthy();
  expect(screen.getByLabelText("客户端指纹")).toBeTruthy();
  expect(screen.getByLabelText("ALPN")).toBeTruthy();
  expect(screen.queryByLabelText("REALITY 公钥")).toBeNull();
  expect(screen.queryByLabelText("Flow")).toBeNull();
  await user.click(screen.getByLabelText("传输方式"));
  expect(await screen.findByRole("option", { name: "TCP" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "WebSocket" })).toBeNull();
  expect(screen.queryByRole("option", { name: "gRPC" })).toBeNull();
  expect(
    screen.getByText(
      "下方填写客户端连接参数；服务端证书和 REALITY 私钥在线路的「TLS 证书与安全参数」中配置。",
    ),
  ).toBeTruthy();
});

it("preserves existing unsupported managed intent until explicit correction", async () => {
  const save = vi.fn();
  const connection = {
    host: "0.0.0.0",
    port: 1443,
    protocol: "vless",
    tls: {
      enabled: true,
      serverName: "entry.test",
      fingerprint: "chrome",
      alpn: ["h2"],
      reality: { publicKey: "existing-key", shortId: "abcd" },
    },
    transport: { type: "ws", path: "/existing" },
    flow: "xtls-rprx-vision",
    packetEncoding: "xudp",
  };
  render(
    <UIProviders>
      <Form initialValues={{ connection }} onFinish={save}>
        <ConnectionFields
          server
          authentication="principals"
          managedEntryTarget
        />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  expect(
    (screen.getByLabelText("REALITY 公钥") as HTMLInputElement).value,
  ).toBe("existing-key");
  expect(screen.getByRole("button", { name: "高级协议参数" })).toBeTruthy();
  expect(screen.getByLabelText("Flow")).toBeTruthy();
  expect(screen.getByLabelText("数据包封装（此核心不支持）").textContent).toBe(
    "xudp",
  );
  expect(
    screen.getByText(
      "此核心仅支持普通 TLS 与 TCP，不支持 REALITY、Vision 或数据包封装。",
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(normalizeConnection(save.mock.calls[0][0].connection)).toEqual(
    connection,
  );
  await user.click(
    screen.getByRole("button", { name: "移除不支持的 REALITY 设置" }),
  );
  await user.click(screen.getByRole("button", { name: "移除不支持的 Flow" }));
  await user.click(screen.getByRole("button", { name: "移除数据包封装" }));
  await user.click(screen.getByLabelText("传输方式"));
  await user.click(await screen.findByRole("option", { name: "TCP" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(normalizeConnection(save.mock.calls[1][0].connection)).toEqual({
    host: "0.0.0.0",
    port: 1443,
    protocol: "vless",
    tls: {
      enabled: true,
      serverName: "entry.test",
      fingerprint: "chrome",
      alpn: ["h2"],
    },
  });
});

it("does not infer managed restrictions from principal authentication alone", async () => {
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: { protocol: "vless", tls: { enabled: true } },
        }}
      >
        <ConnectionFields server authentication="principals" />
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: "REALITY" }));
  expect(screen.getByLabelText("REALITY 公钥")).toBeTruthy();
  await user.click(screen.getByLabelText("传输方式"));
  expect(await screen.findByRole("option", { name: "WebSocket" })).toBeTruthy();
});

it("retains unopened transport headers and edits them without losing other advanced intent", async () => {
  const save = vi.fn();
  const connection = {
    host: "example.test",
    port: 443,
    protocol: "vless",
    uuid: "00000000-0000-4000-8000-000000000001",
    transport: {
      type: "ws",
      path: "/ws",
      host: "front.test",
      headers: { "X-Token": "retained" },
    },
    tls: { enabled: true, serverName: "front.test" },
    packetEncoding: "xudp",
  };
  render(
    <UIProviders>
      <Form initialValues={{ connection }} onFinish={save}>
        <ConnectionFields />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(normalizeConnection(save.mock.calls[0][0].connection)).toEqual(
    connection,
  );
  await user.click(screen.getByRole("button", { name: "自定义请求头" }));
  expect(
    ((await screen.findByLabelText("请求头名称")) as HTMLInputElement).value,
  ).toBe("X-Token");
  await user.clear(screen.getByLabelText("请求头值"));
  await user.type(screen.getByLabelText("请求头值"), "changed");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(normalizeConnection(save.mock.calls[1][0].connection)).toEqual({
    ...connection,
    transport: { ...connection.transport, headers: { "X-Token": "changed" } },
  });
});

it("rejects duplicate headers and directs Host to its dedicated field", async () => {
  const save = vi.fn();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "example.test",
            port: 443,
            protocol: "trojan",
            password: "secret",
            tls: { enabled: true },
            transport: { type: "httpupgrade", headers: { "X-Token": "one" } },
          },
        }}
        onFinish={save}
      >
        <ConnectionFields />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "自定义请求头" }));
  await user.click(screen.getByRole("button", { name: "添加请求头" }));
  const names = screen.getAllByLabelText("请求头名称");
  await user.type(names[1], "x-token");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findAllByText("请求头名称不能重复")).not.toHaveLength(0);
  expect(save).not.toHaveBeenCalled();
  await user.clear(names[1]);
  await user.type(names[1], "Host");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("请使用 Host 专用字段")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});

it("marks TLS mode changes dirty and requires TLS for Trojan", async () => {
  const save = vi.fn(),
    changed = vi.fn();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "example.test",
            port: 443,
            protocol: "trojan",
            password: "secret",
          },
        }}
        onValuesChange={changed}
        onFinish={save}
      >
        <ConnectionFields />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Trojan 必须启用 TLS")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("radio", { name: "TLS" }));
  expect(changed).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(
    normalizeConnection(save.mock.calls[0][0].connection).tls?.enabled,
  ).toBe(true);
});

it("exposes VMess AEAD modes without legacy authentication and warns for unencrypted payloads", async () => {
  const save = vi.fn();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "vmess.test",
            port: 443,
            protocol: "vmess",
            uuid: "00000000-0000-4000-8000-000000000001",
            vmessSecurity: "none",
            tls: { enabled: true },
            transport: {
              type: "grpc",
              serviceName: "tunnel",
              authority: "dial.test",
            },
          },
        }}
        onFinish={save}
      >
        <ConnectionFields />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  expect(screen.getByText("VMess 载荷不加密")).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "REALITY" })).toBeNull();
  expect(screen.queryByLabelText("Flow")).toBeNull();
  expect(screen.getByLabelText("gRPC Authority")).toHaveProperty(
    "value",
    "dial.test",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(normalizeConnection(save.mock.calls[0][0].connection)).toMatchObject({
    protocol: "vmess",
    vmessSecurity: "none",
    transport: { type: "grpc", serviceName: "tunnel", authority: "dial.test" },
  });
});

it("does not silently hide an imported listener-only incompatible gRPC authority", () => {
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "0.0.0.0",
            port: 443,
            protocol: "vless",
            uuid: "00000000-0000-4000-8000-000000000001",
            transport: { type: "grpc", authority: "previous-dial.test" },
          },
        }}
      >
        <ConnectionFields server />
      </Form>
    </UIProviders>,
  );
  expect(screen.getByLabelText("gRPC Authority")).toHaveProperty(
    "value",
    "previous-dial.test",
  );
  expect(screen.getByText(/当前目标不支持；请清除此值后保存/)).toBeTruthy();
});

it("never offers outbound request headers on listeners and requires explicit removal of imported headers", async () => {
  const save = vi.fn(),
    changed = vi.fn();
  const connection = {
    host: "0.0.0.0",
    port: 443,
    protocol: "vless",
    uuid: "00000000-0000-4000-8000-000000000001",
    transport: {
      type: "ws",
      path: "/ws",
      headers: { Authorization: "private-token" },
    },
  };
  render(
    <UIProviders>
      <Form
        initialValues={{ connection }}
        onFinish={save}
        onValuesChange={changed}
      >
        <ConnectionFields server />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  expect(screen.queryByRole("button", { name: "自定义请求头" })).toBeNull();
  expect(screen.getByText("监听端不支持自定义请求头")).toBeTruthy();
  expect(screen.getByText(/已有请求头：Authorization/)).toBeTruthy();
  expect(screen.queryByText("private-token")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "移除不支持的请求头" }),
  );
  expect(changed).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(
    normalizeConnection(save.mock.calls[0][0].connection).transport,
  ).toEqual({ type: "ws", path: "/ws", host: undefined });
});

it("labels sing-box WebSocket Host as a client dial template, preserving existing intent", () => {
  const connection = {
    host: "0.0.0.0",
    port: 443,
    protocol: "vless",
    transport: { type: "ws" },
  };
  const view = render(
    <UIProviders>
      <Form initialValues={{ connection }}>
        <ConnectionFields server targetCore="sing-box" />
      </Form>
    </UIProviders>,
  );
  expect(
    screen.getByLabelText("客户端请求 Host（该监听核心不校验 Host）"),
  ).toBeTruthy();
  view.unmount();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            ...connection,
            transport: { type: "ws", host: "old.test" },
          },
        }}
      >
        <ConnectionFields server targetCore="sing-box" />
      </Form>
    </UIProviders>,
  );
  expect(
    screen.getByLabelText("客户端请求 Host（该监听核心不校验 Host）"),
  ).toHaveProperty("value", "old.test");
  expect(screen.getByText(/保留为客户端拨号模板参数/)).toBeTruthy();
});

it("rejects reserved transport handshake headers without rejecting WebSocket subprotocol", async () => {
  const save = vi.fn();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "example.test",
            port: 443,
            protocol: "trojan",
            password: "secret",
            tls: { enabled: true },
            transport: { type: "ws", headers: { Connection: "upgrade" } },
          },
        }}
        onFinish={save}
      >
        <ConnectionFields />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  await userEvent.click(screen.getByRole("button", { name: "自定义请求头" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText("此请求头由传输核心管理，不能覆盖"),
  ).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText("请求头名称"));
  await userEvent.type(
    screen.getByLabelText("请求头名称"),
    "Sec-WebSocket-Protocol",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});

it("gates Xray REALITY choices without restricting ordinary TLS or sing-box", async () => {
  const base = {
    host: "endpoint.test",
    port: 443,
    protocol: "vless",
    uuid: "00000000-0000-4000-8000-000000000001",
    tls: { enabled: true },
    transport: { type: "ws" },
  };
  const view = render(
    <UIProviders>
      <Form initialValues={{ connection: base }}>
        <ConnectionFields targetCore="xray" />
      </Form>
    </UIProviders>,
  );
  expect(screen.getByRole("radio", { name: "REALITY" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByLabelText("ALPN")).toBeTruthy();
  await userEvent.click(screen.getByLabelText("传输方式"));
  await userEvent.click(screen.getByRole("option", { name: "gRPC" }));
  await userEvent.click(screen.getByRole("radio", { name: "REALITY" }));
  expect(screen.queryByLabelText("ALPN")).toBeNull();
  await userEvent.click(screen.getByLabelText("传输方式"));
  expect(
    screen
      .getByRole("option", { name: "WebSocket" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await userEvent.keyboard("{Escape}");
  view.unmount();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            ...base,
            tls: {
              enabled: true,
              reality: { publicKey: "retained", shortId: "" },
              alpn: ["h2"],
            },
          },
        }}
      >
        <ConnectionFields targetCore="sing-box" />
      </Form>
    </UIProviders>,
  );
  expect(screen.getByRole("radio", { name: "REALITY" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(screen.getByLabelText("ALPN")).toBeTruthy();
  expect(screen.queryByText("当前 Xray REALITY 传输组合不受支持")).toBeNull();
});

it("retains incompatible imported Xray REALITY parameters until explicit correction", async () => {
  const save = vi.fn();
  const connection = {
    host: "endpoint.test",
    port: 443,
    protocol: "vless",
    uuid: "00000000-0000-4000-8000-000000000001",
    tls: {
      enabled: true,
      reality: { publicKey: "retained-key", shortId: "ab" },
      alpn: ["h2"],
    },
    transport: { type: "ws", path: "/retained" },
  };
  expect(normalizeConnection(connection)).toEqual(connection);
  render(
    <UIProviders>
      <Form initialValues={{ connection }} onFinish={save}>
        <ConnectionFields targetCore="xray" />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  expect(screen.getByText("当前 Xray REALITY 传输组合不受支持")).toBeTruthy();
  expect(screen.getByRole("button", { name: "移除 h2" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText("Xray REALITY 仅支持 TCP 或 gRPC。"),
  ).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByLabelText("传输方式"));
  await userEvent.click(screen.getByRole("option", { name: "TCP" }));
  await userEvent.click(screen.getByRole("button", { name: "移除 h2" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const result = normalizeConnection(save.mock.calls[0][0].connection);
  expect(result.transport).toBeUndefined();
  expect(result.tls?.alpn || []).toEqual([]);
  expect(result.tls?.reality?.publicKey).toBe("retained-key");
});

it("retains outbound-only VMess cipher on a listener until changed to auto", async () => {
  const save = vi.fn();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "0.0.0.0",
            port: 443,
            protocol: "vmess",
            uuid: "00000000-0000-4000-8000-000000000001",
            vmessSecurity: "aes-128-gcm",
          },
        }}
        onFinish={save}
      >
        <ConnectionFields server targetCore="xray" />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  expect(screen.getByLabelText("VMess 加密方式").textContent).toContain(
    "aes-128-gcm",
  );
  expect(screen.getByText("现有 VMess 加密方式仅适用于出站连接")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(
      "监听端仅支持自动模式；指定加密方式仅用于出站连接。",
    ),
  ).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByLabelText("VMess 加密方式"));
  await userEvent.click(screen.getByRole("option", { name: "auto" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].connection.vmessSecurity).toBe("auto");
});

it("offers target-supported fingerprints and keeps incompatible imported authority and fingerprint editable", async () => {
  const save = vi.fn();
  const connection = {
    host: "endpoint.test",
    port: 443,
    protocol: "vless",
    uuid: "00000000-0000-4000-8000-000000000001",
    tls: { enabled: true, fingerprint: "randomized" },
    transport: {
      type: "grpc",
      serviceName: "tunnel",
      authority: "existing.test",
    },
  };
  render(
    <UIProviders>
      <Form initialValues={{ connection }} onFinish={save}>
        <ConnectionFields targetCore="mihomo" />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  expect(screen.getByLabelText("gRPC Authority")).toHaveProperty(
    "value",
    "existing.test",
  );
  expect(
    screen.getByText(
      "当前目标不支持现有指纹；值仍保留，请选择支持的指纹或清除。",
    ),
  ).toBeTruthy();
  expect(normalizeConnection(connection).tls?.fingerprint).toBe("randomized");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("当前目标不支持此客户端指纹。")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByLabelText("客户端指纹"));
  for (const name of ["ios", "android", "edge", "360", "qq", "random"])
    expect(screen.getByRole("option", { name })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "randomized" })).toBeNull();
  await userEvent.click(screen.getByRole("option", { name: "ios" }));
  await userEvent.clear(screen.getByLabelText("gRPC Authority"));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].connection.tls.fingerprint).toBe("ios");
});

it.each(["shared", "principals"])(
  "keeps an imported non-VLESS managed listener visible and invalid until explicit correction with %s authentication",
  async (authentication) => {
    const save = vi.fn();
    render(
      <UIProviders>
        <Form
          initialValues={{
            connection: {
              host: "0.0.0.0",
              port: 1443,
              protocol: "socks",
              uuid: "b5270801-02f0-4ec4-8aef-eef6691ba288",
            },
          }}
          onFinish={save}
        >
          <ConnectionFields
            server
            authentication={authentication}
            targetCore="managed-xray"
          />
          <Button type="submit">Save</Button>
        </Form>
      </UIProviders>,
    );
    const user = userEvent.setup();
    const control = screen.getByLabelText("协议") as HTMLButtonElement;
    expect(control.textContent).toContain("SOCKS5");
    expect(control.disabled).toBe(false);
    expect(screen.getByText("当前托管监听协议不受支持")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "此托管核心的监听端点仅支持 VLESS，请明确改为 VLESS",
      ),
    ).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    expect(control.textContent).toContain("SOCKS5");
    await user.click(control);
    for (const name of ["SOCKS5", "Shadowsocks", "Trojan", "VMess AEAD"]) {
      expect(
        screen.getByRole("option", { name }).getAttribute("aria-disabled"),
      ).toBe("true");
    }
    await user.click(screen.getByRole("option", { name: "VLESS" }));
    expect(control.textContent).toContain("VLESS");
    expect(screen.queryByText("当前托管监听协议不受支持")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].connection.protocol).toBe("vless");
  },
);

it("prevents new non-VLESS choices for an explicitly managed listener even without principals authentication", async () => {
  render(
    <UIProviders>
      <Form initialValues={{ connection: { protocol: "vless" } }}>
        <ConnectionFields server managedEntryTarget />
      </Form>
    </UIProviders>,
  );
  await userEvent.click(screen.getByLabelText("协议"));
  expect(
    screen.getByRole("option", { name: "VLESS" }).getAttribute("aria-disabled"),
  ).not.toBe("true");
  for (const name of ["SOCKS5", "Shadowsocks", "Trojan", "VMess AEAD"]) {
    expect(
      screen.getByRole("option", { name }).getAttribute("aria-disabled"),
    ).toBe("true");
  }
});

it("lets dynamic header content grow naturally and retains rows across disclosure changes", async () => {
  const save = vi.fn();
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "example.test",
            port: 443,
            protocol: "vless",
            uuid: "11111111-1111-4111-8111-111111111111",
            transport: { type: "ws" },
          },
        }}
        onFinish={save}
      >
        <ConnectionFields />
        <Button type="submit">Save</Button>
      </Form>
    </UIProviders>,
  );
  const user = userEvent.setup();
  const disclosure = screen.getByRole("button", { name: "自定义请求头" });
  await user.click(disclosure);
  const add = screen.getByRole("button", { name: "添加请求头" });
  const content = add.closest('[data-slot="accordion-content"]')!;
  const inner = content.firstElementChild!;
  expect(inner.className).not.toContain("h-(--radix-accordion-content-height)");
  for (const [name, value] of [
    ["X-Client", "RouteWeaver-demo"],
    ["X-Region", "eu"],
    ["X-Trace", "test"],
  ]) {
    await user.click(add);
    const names = screen.getAllByLabelText("请求头名称");
    const values = screen.getAllByLabelText("请求头值");
    await user.type(names[names.length - 1], name);
    await user.type(values[values.length - 1], value);
  }
  await user.click(disclosure);
  expect(content.getAttribute("data-state")).toBe("closed");
  expect(content.classList.contains("data-[state=closed]:hidden")).toBe(true);
  await user.click(disclosure);
  expect(
    screen
      .getAllByLabelText("请求头名称")
      .map((input) => (input as HTMLInputElement).value),
  ).toEqual(["X-Client", "X-Region", "X-Trace"]);
  await user.click(screen.getByRole("button", { name: "移除请求头 2" }));
  expect(document.activeElement).toBe(
    screen.getAllByLabelText("请求头名称")[1],
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(
    normalizeConnection(save.mock.calls[0][0].connection).transport?.headers,
  ).toEqual({ "X-Client": "RouteWeaver-demo", "X-Trace": "test" });
  await user.click(screen.getByRole("button", { name: "移除请求头 2" }));
  expect(document.activeElement).toBe(screen.getByLabelText("请求头名称"));
  await user.click(screen.getByRole("button", { name: "移除请求头 1" }));
  expect(document.activeElement).toBe(add);
  await user.click(add);
  const newerFocus = screen.getByRole("button", { name: "Save" });
  newerFocus.focus();
  fireEvent.click(screen.getByRole("button", { name: "移除请求头 1" }));
  expect(document.activeElement).toBe(newerFocus);
  await user.click(add);
  await user.click(add);
  const remainingInput = screen.getAllByLabelText("请求头名称")[1];
  screen.getAllByLabelText("请求头名称")[0].focus();
  fireEvent.click(screen.getByRole("button", { name: "移除请求头 1" }));
  expect(document.activeElement).toBe(remainingInput);
});

it("shows REALITY compatibility guidance only while that security mode is selected", async () => {
  render(
    <UIProviders>
      <Form
        initialValues={{
          connection: {
            host: "edge.example.test",
            port: 443,
            protocol: "vless",
            tls: { enabled: true },
          },
        }}
      >
        <ConnectionFields />
      </Form>
    </UIProviders>,
  );
  expect(screen.queryByText(/REALITY 的兼容性取决于目标核心/)).toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: "REALITY" }));
  expect(screen.getByText(/REALITY 的兼容性取决于目标核心/)).toBeTruthy();
  await userEvent.click(screen.getByRole("radio", { name: /^TLS$/ }));
  expect(screen.queryByText(/REALITY 的兼容性取决于目标核心/)).toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: /^无$/ }));
  expect(screen.queryByText(/REALITY 的兼容性取决于目标核心/)).toBeNull();
});
