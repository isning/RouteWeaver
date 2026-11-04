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
import type { ReactNode } from "react";
import { FleetPlanForm } from "./Fleet";
import { RuleFileImport } from "./RuleFileImport";
import { ProfileEditor } from "./Profiles";
import {
  SubscriptionsPage,
  PublishOutput,
  UpdateOutput,
} from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Infrastructure, Output } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
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
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const inventory = {
  hosts: [{ id: "host", name: "Host", address: "example.test" }],
  instances: [
    {
      id: "core",
      hostId: "host",
      name: "Office core",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    },
  ],
  endpoints: [],
  links: [],
  deployments: [
    {
      id: "path",
      name: "Office path",
      ir: { programs: [{ instance: { id: "core" } }] },
    },
  ],
} as unknown as Infrastructure;
const plan = {
  fingerprint: "reviewed-scope",
  supported: true,
  affectedUsers: 7,
  diagnostics: [],
  targets: [
    {
      instanceId: "core",
      name: "Office core",
      stage: 0,
      supported: true,
      affectedUsers: 7,
    },
  ],
};
it.for(["preview", "create"] as const)(
  "keeps Fleet %s action identity and pending state without changing reviewed scope",
  async (operation, context) => {
    const scenario = ownedClickScenario(context);
    const pending = deferred();
    const requests: { path: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        const body = JSON.parse(String(init?.body));
        requests.push({ path, body });
        if (path.endsWith("/preview"))
          return operation === "preview" ? pending.promise : json(plan);
        return pending.promise;
      }),
    );
    mount(
      <FleetPlanForm
        inventory={inventory}
        history={[]}
        initialDeploymentId="path"
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    const dialog = within(screen.getByRole("dialog"));
    const preview = dialog.getByRole("button", {
      name: "预览影响与差异",
    }) as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    await scenario.click(() =>
      dialog.getByRole("checkbox", { name: "选择实例 Office core" }),
    );
    expect(preview.disabled).toBe(false);
    await scenario.click(() => preview);
    if (operation === "preview") {
      await waitFor(() => expect(requests).toHaveLength(1));
      await waitFor(() =>
        expect(preview.getAttribute("aria-busy")).toBe("true"),
      );
      expect(dialog.getByRole("button", { name: "预览影响与差异" })).toBe(
        preview,
      );
      await scenario.click(() => preview);
      expect(requests).toHaveLength(1);
      await act(async () => pending.resolve(json(plan)));
      await waitFor(() =>
        expect(preview.getAttribute("aria-busy")).not.toBe("true"),
      );
      expect(dialog.getByText("1 个实例")).toBeTruthy();
      expect(dialog.getByText("7 位用户受影响")).toBeTruthy();
      expect(
        (
          dialog.getByRole("button", {
            name: "创建待执行批次",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    } else {
      const confirm = await dialog.findByRole("checkbox", {
        name: "我已核对实例、阶段与影响范围",
      });
      const create = dialog.getByRole("button", {
        name: "创建待执行批次",
      }) as HTMLButtonElement;
      expect(create.disabled).toBe(true);
      await scenario.click(() => confirm);
      expect(create.disabled).toBe(false);
      await scenario.click(() => create);
      await waitFor(() => expect(requests).toHaveLength(2));
      // The existing inert subtree is intentionally unchanged. These captured
      // attributes do not claim that the pending action remains in the browser AX tree.
      await waitFor(() =>
        expect(create.getAttribute("aria-busy")).toBe("true"),
      );
      expect(create.closest("[inert]")).not.toBeNull();
      expect(create.getAttribute("aria-label")).toBe("创建待执行批次");
      await act(async () =>
        pending.resolve(json({ error: "Plan rejected" }, 422)),
      );
      await dialog.findByText("Plan rejected");
      expect(dialog.getByRole("button", { name: "创建待执行批次" })).toBe(
        create,
      );
      await waitFor(() =>
        expect(create.getAttribute("aria-busy")).not.toBe("true"),
      );
      expect(create.disabled).toBe(false);
      expect(dialog.getByText("1 个实例")).toBeTruthy();
      expect(dialog.getByText("7 位用户受影响")).toBeTruthy();
      expect(requests[1].body).toMatchObject({
        deploymentId: "path",
        targetIds: ["core"],
        expectedFingerprint: "reviewed-scope",
      });
    }
    expect(requests[0].body).toMatchObject({
      deploymentId: "path",
      targetIds: ["core"],
    });
    expect(requests.some(({ path }) => /execute|start/.test(path))).toBe(false);
  },
);

it.for(["upload", "fetch"] as const)(
  "keeps the %s rule-file action name through rejection and retry",
  async (mode, context) => {
    const scenario = ownedClickScenario(context);
    const pending = deferred();
    const writes: any[] = [];
    const close = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        return writes.length === 1
          ? pending.promise
          : json({ ...body.resource, acceptedVersion: "accepted" });
      }),
    );
    mount(<RuleFileImport onClose={close} />);
    const dialog = within(screen.getByRole("dialog", { name: "导入规则文件" }));
    scenario.change(() => dialog.getByLabelText("导入资源名称"), {
      target: { value: "Private rules" },
    });
    if (mode === "upload") {
      await userEvent.upload(
        dialog.getByLabelText("选择规则文件"),
        new File(["payload:\n  - example.com\n"], "private.yaml"),
      );
    } else {
      const choice = dialog.getByRole("combobox", { name: "规则文件导入方式" });
      await scenario.click(() => choice);
      const popup = document
        .getElementById(choice.getAttribute("aria-controls")!)!
        .closest("[data-slot=popover-content]")!;
      await scenario.click(() =>
        within(popup as HTMLElement).getByText("读取 HTTPS 文件并接纳", {
          selector: "[cmdk-item] span",
        }),
      );
      scenario.change(() => dialog.getByLabelText("导入文件 HTTPS 地址"), {
        target: { value: "https://example.test/private.yaml" },
      });
    }
    const name = mode === "upload" ? "导入并保存文件" : "读取并接纳文件";
    const button = dialog.getByRole("button", { name }) as HTMLButtonElement;
    await scenario.click(() => button);
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(dialog.getByRole("button", { name })).toBe(button);
    // Keep the owned busy action focusable while the rest of the form locks.
    // Loading and the synchronous task guard still suppress another write.
    expect(button.disabled).toBe(false);
    await scenario.click(() => button);
    await userEvent.keyboard("{Enter} ");
    expect(writes).toHaveLength(1);
    await act(async () =>
      pending.resolve(json({ error: "Import rejected" }, 422)),
    );
    await dialog.findByText("Import rejected");
    await waitFor(() =>
      expect(button.getAttribute("aria-busy")).not.toBe("true"),
    );
    expect(button.disabled).toBe(false);
    expect(
      (dialog.getByLabelText("导入资源名称") as HTMLInputElement).value,
    ).toBe("Private rules");
    expect(close).not.toHaveBeenCalled();
    await scenario.click(() => dialog.getByRole("button", { name }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0].fetch).toBe(mode === "fetch" ? true : undefined);
  },
);

it("keeps standalone Profile Save named and busy while preserving a rejected draft", async (context) => {
  const scenario = ownedClickScenario(context);
  const pending = deferred();
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) === "/api/me/collections/preview")
        return json({ endpoints: [], stages: [] });
      if (String(url) === "/api/me/profiles" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return writes.length === 1 ? pending.promise : json(body);
      }
      return json([]);
    }),
  );
  const profile = { ...emptyProfile(), name: "Work draft" };
  const view = mount(
    <ProfileEditor initial={profile} isNew onClose={() => {}} />,
  );
  const editor = within(view.container);
  const toolbar = within(editor.getByRole("group", { name: "保存与检查配置" }));
  const button = toolbar.getByRole("button", {
    name: "保存草稿",
  }) as HTMLButtonElement;
  await scenario.click(() => button);
  await waitFor(() => expect(writes).toHaveLength(1));
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  expect(toolbar.getByRole("button", { name: "保存草稿" })).toBe(button);
  expect(button.disabled).toBe(true);
  await act(async () => pending.resolve(json({ error: "Save rejected" }, 422)));
  await editor.findByText("Save rejected");
  await waitFor(() =>
    expect(button.getAttribute("aria-busy")).not.toBe("true"),
  );
  expect(button.disabled).toBe(false);
  expect(
    (editor.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Work draft");
  await scenario.click(() => toolbar.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(toolbar.getByRole("status").textContent).toBe("草稿已保存"),
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

it("keeps new subscription confirmation tied to its reviewed name while publishing and after rejection", async (context) => {
  const scenario = ownedClickScenario(context);
  const pending = deferred();
  const writes: { path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      writes.push({ path, body });
      if (path.endsWith("/preview"))
        return json({
          valid: true,
          previewDigest: "new-reviewed",
          previewScope: "new-output",
          outputId: body.id,
          artifacts: [{ path: "config.yaml", content: "checked" }],
        });
      return pending.promise;
    }),
  );
  mount(
    <PublishOutput
      profile={{ ...emptyProfile(), id: "profile", name: "Phone" }}
      onClose={() => {}}
    />,
  );
  const dialog = within(screen.getByRole("dialog", { name: "新增客户端订阅" }));
  await waitFor(() =>
    expect((dialog.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
      "Phone",
    ),
  );
  scenario.change(() => dialog.getByLabelText("订阅名称"), {
    target: { value: "Travel phone" },
  });
  await scenario.click(() =>
    dialog.getByRole("button", { name: "检查发布内容" }),
  );
  const button = (await dialog.findByRole("button", {
    name: "创建并发布「Travel phone」",
  })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await scenario.click(() => button);
  await waitFor(() => expect(writes).toHaveLength(2));
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  expect(
    dialog.getByRole("button", { name: "创建并发布「Travel phone」" }),
  ).toBe(button);
  expect(button.disabled).toBe(true);
  await act(async () =>
    pending.resolve(json({ error: "Creation rejected" }, 422)),
  );
  await dialog.findByText("Creation rejected");
  await waitFor(() =>
    expect(button.getAttribute("aria-busy")).not.toBe("true"),
  );
  expect(button.disabled).toBe(false);
  expect(
    dialog.getByRole("button", { name: "创建并发布「Travel phone」" }),
  ).toBe(button);
  expect(writes[1]).toMatchObject({
    path: "/api/me/outputs",
    body: {
      ...writes[0].body,
      name: "Travel phone",
      previewDigest: "new-reviewed",
    },
  });
});

it.for(["published", "revoked"] as const)(
  "keeps the %s subscription target and action distinct during publish and rejection",
  async (status, context) => {
    const scenario = ownedClickScenario(context);
    const pending = deferred();
    const writes: { path: string; body: any }[] = [];
    const output: Output = {
      id: "phone",
      name: "Android travel",
      profileId: "profile",
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
      status,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        writes.push({ path, body });
        return path.endsWith("/preview")
          ? json({
              valid: true,
              previewDigest: "a".repeat(64),
              outputId: output.id,
              previewScope: "output-update",
              publicationEffect: {
                version: 1,
                link: status === "revoked" ? "replace" : "preserve",
              },
              artifacts: [{ path: "config.yaml", content: "checked" }],
            })
          : pending.promise;
      }),
    );
    mount(<UpdateOutput output={output} onClose={() => {}} />);
    const dialog = within(
      screen.getByRole("dialog", { name: "检查订阅更新「Android travel」" }),
    );
    const name = `${status === "revoked" ? "重新发布并生成新链接" : "确认更新"}「Android travel」`;
    const button = dialog.getByRole("button", {
      name: "确认更新「Android travel」",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await scenario.click(() =>
      dialog.getByRole("button", { name: "预览此订阅更新" }),
    );
    await waitFor(() => expect(button.disabled).toBe(false));
    await scenario.click(() => button);
    await waitFor(() => expect(writes).toHaveLength(2));
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(dialog.getByRole("button", { name })).toBe(button);
    await scenario.click(() => button);
    expect(writes).toHaveLength(2);
    await act(async () =>
      pending.resolve(json({ error: "Publish rejected" }, 422)),
    );
    await dialog.findByText("Publish rejected");
    await waitFor(() =>
      expect(button.getAttribute("aria-busy")).not.toBe("true"),
    );
    expect(button.disabled).toBe(false);
    expect(dialog.getByRole("button", { name })).toBe(button);
    expect(writes).toEqual([
      {
        path: "/api/me/profiles/profile/preview",
        body: { outputId: "phone", target: output.target, mode: "full" },
      },
      {
        path: "/api/me/outputs/phone/publish",
        body: { previewDigest: "a".repeat(64) },
      },
    ]);
  },
);

it.for(["row", "detail", "revoked-row", "revoked-detail"] as const)(
  "keeps the subscription %s check named while refreshing and after rejection",
  async (surface, context) => {
    const scenario = ownedClickScenario(context);
    history.replaceState(null, "", "#subscriptions");
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
    const outputs: Output[] = ["Laptop", "Phone"].map((name) => ({
      id: name.toLowerCase(),
      name,
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: surface.startsWith("revoked") ? "revoked" : "published",
      revision: "r1",
    }));
    const pending = deferred();
    const requests: { path: string; method: string }[] = [];
    let outputReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        requests.push({ path, method: init?.method || "GET" });
        if (path.endsWith("/overview"))
          return json({ status: "active", routes: [] });
        if (path.endsWith("/profiles")) return json([profile]);
        if (path.endsWith("/outputs"))
          return ++outputReads === 1 ? json(outputs) : pending.promise;
        if (path.endsWith("/status"))
          return json({
            ...outputs[0],
            draftComparison: { state: "unchanged" },
          });
        return json([]);
      }),
    );
    mount(<SubscriptionsPage />);
    const row = await screen.findByRole("group", { name: "客户端订阅 Laptop" });
    let scope = within(row);
    const name = surface.startsWith("revoked") ? "检查重新发布" : "检查更新";
    if (surface.endsWith("detail")) {
      await scenario.click(() =>
        screen.getByRole("button", { name: "查看订阅 Laptop" }),
      );
      scope = within(
        await screen.findByRole("dialog", { name: "Laptop 的订阅详情" }),
      );
      if (!surface.startsWith("revoked"))
        await scope.findByText("与已保存草稿一致");
    }
    const button = scope.getByRole("button", {
      name,
    }) as HTMLButtonElement;
    await scenario.click(() => button);
    await waitFor(() => expect(outputReads).toBe(2));
    expect(scope.getByRole("button", { name })).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(within(button).queryByRole("img", { name: "loading" })).toBeNull();
    expect(button.disabled).toBe(true);
    await scenario.click(() => button);
    expect(outputReads).toBe(2);
    await act(async () =>
      pending.resolve(json({ error: "Refresh rejected" }, 422)),
    );
    await waitFor(() =>
      expect(button.getAttribute("aria-busy")).not.toBe("true"),
    );
    expect(scope.getByRole("button", { name })).toBe(button);
    expect(button.textContent).toBe(name);
    expect(requests.filter(({ method }) => method !== "GET")).toEqual([]);
    expect(requests.some(({ path }) => path.includes("/phone/"))).toBe(false);
  },
);
