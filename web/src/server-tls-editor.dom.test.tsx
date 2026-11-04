// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
import type { ServerDeployment, ServerTLS } from "./types";

const privateKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const clients: QueryClient[] = [];
beforeEach(() => {
  history.replaceState(null, "", "/");
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
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    originalStyle(element),
  );
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openSecurityEditor(tls?: ServerTLS, reality = true) {
  const instance = {
    id: "core",
    hostId: "host",
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  };
  const listener = {
    id: "entry",
    instanceId: "core",
    name: "Entry",
    connection: {
      protocol: "vless",
      host: "0.0.0.0",
      port: 443,
      uuid: "00000000-0000-4000-8000-000000000001",
      tls: {
        enabled: true,
        serverName: "entry.example",
        fingerprint: "chrome",
        ...(reality
          ? {
              reality: {
                publicKey: "ZCBkxteC4GSHx-8OeSWgGTcJfD-KQYJgKfAnPcnL_q0",
                shortId: "0123456789abcdef",
              },
            }
          : {}),
      },
    },
  };
  const deployment: ServerDeployment = {
    id: "deployment",
    name: "TLS path",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "deployment",
      topologyRevision: "v1",
      programs: [
        {
          instance,
          listener,
          egress: [],
          rules: [],
          resources: [],
          ...(tls ? { tls } : {}),
        },
      ],
    },
  };
  const saved: ServerDeployment[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      let result: unknown = [];
      if (init?.method === "PUT") {
        const value = JSON.parse(init.body as string) as ServerDeployment;
        saved.push(value);
        result = value;
      } else if (path.endsWith("/hosts"))
        result = [{ id: "host", name: "Tokyo", address: "host.example" }];
      else if (path.endsWith("/core-instances")) result = [instance];
      else if (path.endsWith("/managed-endpoints")) result = [listener];
      else if (path.endsWith("/server-deployments")) result = [deployment];
      else if (path.endsWith("/server-deployments/deployment/reveal"))
        result = deployment;
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ServerRoutesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 TLS path" }),
  );
  const drawer = await screen.findByRole("dialog", { name: "编辑 TLS path" });
  await user.click(within(drawer).getByText("TLS 证书与安全参数"));
  const save = async () => {
    await user.click(within(drawer).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    return saved[0].ir.programs[0].tls;
  };
  return { user, drawer, save };
}

it.each(["target-first", "key-first"])(
  "initializes complete REALITY server material regardless of field order: %s",
  async (order) => {
    const { user, drawer, save } = await openSecurityEditor();
    const setTarget = () =>
      user.type(within(drawer).getByLabelText("握手目标"), "handshake.example");
    const setKey = async () => {
      await user.click(within(drawer).getByLabelText("REALITY 服务端私钥"));
      await user.paste(privateKey);
    };
    if (order === "target-first") {
      await setTarget();
      await setKey();
    } else {
      await setKey();
      await user.clear(within(drawer).getByLabelText("握手目标"));
      await setTarget();
    }
    expect(await save()).toEqual({
      reality: {
        privateKey,
        handshakeServer: "handshake.example",
        handshakePort: 443,
        shortIds: ["0123456789abcdef"],
        serverNames: ["entry.example"],
      },
    });
  },
);

it("preserves the configured REALITY handshake port, short IDs and names when editing the target", async () => {
  const { user, drawer, save } = await openSecurityEditor({
    reality: {
      privateKey,
      handshakeServer: "original.example",
      handshakePort: 8443,
      shortIds: ["0123456789abcdef", "0011"],
      serverNames: ["entry.example", "alternate.example"],
    },
  });
  await user.clear(within(drawer).getByLabelText("握手目标"));
  await user.type(within(drawer).getByLabelText("握手目标"), "new.example");
  expect(await save()).toEqual({
    reality: {
      privateKey,
      handshakeServer: "new.example",
      handshakePort: 8443,
      shortIds: ["0123456789abcdef", "0011"],
      serverNames: ["entry.example", "alternate.example"],
    },
  });
});

it("does not offer incompatible certificate paths or PEM material for a REALITY listener", async () => {
  const { drawer } = await openSecurityEditor();
  expect(within(drawer).getByLabelText("REALITY 服务端私钥")).toBeTruthy();
  expect(within(drawer).getByLabelText("握手目标")).toBeTruthy();
  expect(within(drawer).queryByLabelText("证书文件路径")).toBeNull();
  expect(within(drawer).queryByLabelText("私钥文件路径")).toBeNull();
  expect(within(drawer).queryByLabelText("证书 PEM")).toBeNull();
  expect(within(drawer).queryByLabelText("读取 TLS 私钥")).toBeNull();
});

it("keeps certificate paths and PEM editing together for ordinary TLS", async () => {
  const { user, drawer, save } = await openSecurityEditor(undefined, false);
  expect(within(drawer).queryByLabelText("REALITY 服务端私钥")).toBeNull();
  expect(within(drawer).getByLabelText("读取 TLS 证书")).toBeTruthy();
  expect(within(drawer).getByLabelText("读取 TLS 私钥")).toBeTruthy();
  expect(
    within(drawer).getByText(
      "文件路径相对于此次配置包，仅使用包内文件。",
    ),
  ).toBeTruthy();
  await user.type(
    within(drawer).getByLabelText("证书文件路径"),
    "certs/entry.pem",
  );
  await user.type(
    within(drawer).getByLabelText("私钥文件路径"),
    "certs/key.pem",
  );
  await user.click(within(drawer).getByLabelText("证书 PEM"));
  await user.paste("synthetic certificate");
  await user.click(
    within(drawer).getByRole("button", { name: "编辑私钥 PEM" }),
  );
  await user.click(within(drawer).getByLabelText("私钥 PEM"));
  await user.paste("synthetic private key");
  expect(await save()).toEqual({
    certificatePath: "certs/entry.pem",
    keyPath: "certs/key.pem",
    certificatePem: "synthetic certificate",
    privateKeyPem: "synthetic private key",
  });
});

it("recovers missing REALITY lists from the endpoint when editing an earlier incomplete draft", async () => {
  const { user, drawer, save } = await openSecurityEditor({
    reality: {
      privateKey,
      handshakeServer: "handshake.example",
      handshakePort: 8443,
      shortIds: [],
      serverNames: [],
    },
  });
  await user.clear(within(drawer).getByLabelText("REALITY 服务端私钥"));
  await user.click(within(drawer).getByLabelText("REALITY 服务端私钥"));
  await user.paste(privateKey);
  expect(await save()).toEqual({
    reality: {
      privateKey,
      handshakeServer: "handshake.example",
      handshakePort: 8443,
      shortIds: ["0123456789abcdef"],
      serverNames: ["entry.example"],
    },
  });
});
