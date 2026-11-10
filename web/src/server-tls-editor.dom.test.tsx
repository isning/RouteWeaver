// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
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

async function openSecurityEditor(tls?: ServerTLS, reality = true, twoListeners = false, refreshedPort?: number) {
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
  const secondInstance = { ...instance, id: "second-core" };
  const secondListener = { ...listener, id: "second-entry", name: "Second", instanceId: secondInstance.id };
  if (twoListeners) {
    deployment.ir.programs.push({
      ...deployment.ir.programs[0], instance: secondInstance, listener: secondListener,
    });
  }
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
      } else if (path.endsWith("/managed-endpoints/entry/reveal"))
        result = {
          ...listener,
          connection: { ...listener.connection, port: refreshedPort ?? listener.connection.port },
        };
      else if (path.endsWith("/hosts"))
        result = [{ id: "host", name: "Tokyo", address: "host.example" }];
      else if (path.endsWith("/core-instances")) result = twoListeners ? [instance, secondInstance] : [instance];
      else if (path.endsWith("/managed-endpoints")) result = twoListeners ? [listener, secondListener] : [listener];
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
  return { user, drawer, save, saved };
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


function delayedPEM(name = "certificate.pem") {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
  const file = new File(["synthetic fixture"], name, { type: "application/x-pem-file" });
  Object.defineProperty(file, "text", { value: () => pending });
  return { file, resolve, reject };
}

it("waits for both PEM imports and preserves newer name and path edits in the saved request", async () => {
  const { user, drawer, save, saved } = await openSecurityEditor(undefined, false);
  const certificate = delayedPEM();
  const key = delayedPEM("key.pem");
  await user.upload(within(drawer).getByLabelText("读取 TLS 证书"), certificate.file);
  await user.upload(within(drawer).getByLabelText("读取 TLS 私钥"), key.file);
  const saveButton = within(drawer).getByRole("button", { name: "保存草稿" });
  expect(saveButton.hasAttribute("disabled")).toBe(true);
  await user.clear(within(drawer).getByLabelText("转发路径名称"));
  await user.type(within(drawer).getByLabelText("转发路径名称"), "New path name");
  await user.type(within(drawer).getByLabelText("证书文件路径"), "custom/cert.pem");
  await user.type(within(drawer).getByLabelText("私钥文件路径"), "custom/key.pem");
  await act(async () => certificate.resolve("synthetic certificate"));
  expect(saveButton.hasAttribute("disabled")).toBe(true);
  await user.click(saveButton);
  expect(saved).toHaveLength(0);
  await act(async () => key.resolve("synthetic private key"));
  expect(await save()).toEqual({
    certificatePath: "custom/cert.pem", keyPath: "custom/key.pem",
    certificatePem: "synthetic certificate", privateKeyPem: "synthetic private key",
  });
  expect(saved[0].name).toBe("New path name");
});

it("manual PEM editing supersedes a pending file and suppresses its stale failure", async () => {
  const { user, drawer, save } = await openSecurityEditor(undefined, false);
  const old = delayedPEM();
  await user.upload(within(drawer).getByLabelText("读取 TLS 证书"), old.file);
  await user.type(within(drawer).getByLabelText("证书 PEM"), "newer manual certificate");
  await act(async () => old.reject(new Error("old read failed")));
  expect(within(drawer).queryByText("读取失败，请重新选择 PEM 文件。")).toBeNull();
  expect((await save())?.certificatePem).toBe("newer manual certificate");
});

it("cancels pending reads without replacing material or reporting a late failure", async () => {
  const { user, drawer, save } = await openSecurityEditor({ certificatePem: "kept certificate" }, false);
  const old = delayedPEM();
  await user.upload(within(drawer).getByLabelText("读取 TLS 证书"), old.file);
  await user.click(within(drawer).getByRole("button", { name: "取消读取" }));
  await act(async () => old.reject(new Error("cancelled read failed")));
  expect(within(drawer).queryByText("读取失败，请重新选择 PEM 文件。")).toBeNull();
  expect((await save())?.certificatePem).toBe("kept certificate");
});

it("does not resurrect a removed listener when its file finishes reading", async () => {
  const { user, drawer, saved } = await openSecurityEditor(undefined, false);
  const old = delayedPEM();
  await user.upload(within(drawer).getByLabelText("读取 TLS 证书"), old.file);
  await user.click(within(drawer).getByRole("button", { name: "第 1 跳更多操作" }));
  await user.click(screen.getByRole("menuitem", { name: "移除第 1 跳" }));
  await waitFor(() => expect(within(drawer).queryByLabelText("读取 TLS 证书")).toBeNull());
  await act(async () => old.resolve("obsolete certificate"));
  await user.click(within(drawer).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0].ir.programs).toEqual([]);
});


it("keeps imports for different listeners independent while other draft fields change", async () => {
  const { user, drawer, save, saved } = await openSecurityEditor(undefined, false, true);
  const first = delayedPEM();
  const second = delayedPEM();
  const inputs = within(drawer).getAllByLabelText("读取 TLS 证书");
  await user.upload(inputs[0], first.file);
  await user.upload(inputs[1], second.file);
  await user.clear(within(drawer).getByLabelText("转发路径名称"));
  await user.type(within(drawer).getByLabelText("转发路径名称"), "Both listeners");
  await act(async () => first.resolve("first listener certificate"));
  expect(within(drawer).getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(true);
  await act(async () => second.resolve("second listener certificate"));
  await save();
  expect(saved[0].name).toBe("Both listeners");
  expect(saved[0].ir.programs.map((program) => program.tls?.certificatePem)).toEqual([
    "first listener certificate", "second listener certificate",
  ]);
});

it("ignores failure from an older selected file without clearing the newer pending read", async () => {
  const { user, drawer, save } = await openSecurityEditor(undefined, false);
  const old = delayedPEM("old.pem");
  const newer = delayedPEM("new.pem");
  await user.upload(within(drawer).getByLabelText("读取 TLS 证书"), old.file);
  await user.upload(within(drawer).getByLabelText("读取 TLS 证书"), newer.file);
  await act(async () => old.reject(new Error("old selection failed")));
  expect(within(drawer).queryByText("读取失败，请重新选择 PEM 文件。")).toBeNull();
  expect(within(drawer).getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(true);
  await act(async () => newer.resolve("new selection certificate"));
  expect((await save())?.certificatePem).toBe("new selection certificate");
});


it("revokes a pending reader when the same listener is refreshed and keeps other imports pending", async () => {
  const { user, drawer, save, saved } = await openSecurityEditor(
    { certificatePem: "kept certificate" }, false, true, 8443,
  );
  const obsolete = delayedPEM();
  const other = delayedPEM();
  const inputs = within(drawer).getAllByLabelText("读取 TLS 证书");
  await user.upload(inputs[0], obsolete.file);
  await user.upload(inputs[1], other.file);
  await user.click(within(drawer).getByRole("button", { name: "检查监听更新 Entry" }));
  const review = await screen.findByRole("dialog", { name: "更新 Entry 的监听设置" });
  await waitFor(() => expect(within(review).getByRole("button", { name: "更新到草稿" }).hasAttribute("disabled")).toBe(false));
  await user.click(within(review).getByRole("button", { name: "更新到草稿" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "更新 Entry 的监听设置" })).toBeNull());
  await act(async () => obsolete.resolve("obsolete replacement certificate"));
  expect(within(drawer).getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(true);
  await act(async () => other.resolve("second listener certificate"));
  await save();
  expect(saved[0].ir.programs[0].listener.connection.port).toBe(8443);
  expect(saved[0].ir.programs[0].tls?.certificatePem).toBe("kept certificate");
  expect(saved[0].ir.programs[1].tls?.certificatePem).toBe("second listener certificate");
});

it("can select the same file again after cancelling its first read", async () => {
  const { user, drawer, save } = await openSecurityEditor(undefined, false);
  let finishOld!: (text: string) => void;
  const oldRead = new Promise<string>((done) => { finishOld = done; });
  const file = new File(["synthetic fixture"], "same.pem");
  Object.defineProperty(file, "text", {
    value: vi.fn().mockReturnValueOnce(oldRead).mockResolvedValueOnce("retry certificate"),
  });
  const input = within(drawer).getByLabelText("读取 TLS 证书");
  await user.upload(input, file);
  await user.click(within(drawer).getByRole("button", { name: "取消读取" }));
  await user.upload(input, file);
  await waitFor(() => expect((within(drawer).getByLabelText("证书 PEM") as HTMLTextAreaElement).value).toBe("retry certificate"));
  await act(async () => finishOld("obsolete first read"));
  expect((await save())?.certificatePem).toBe("retry certificate");
});
