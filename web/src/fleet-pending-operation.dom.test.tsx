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
import { FleetPlanForm } from "./Fleet";
import type { Infrastructure } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
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
it.for([
  [422, "owned"],
  [409, "owned"],
  [422, "close"],
  [409, "close"],
] as const)(
  "exposes pending creation after %s and respects %s focus on recovery",
  async ([status, focus], context) => {
    const scenario = ownedClickScenario(context);
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const writes: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/preview")) return json(plan);
        writes.push(JSON.parse(String(init?.body)));
        return pending;
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    const close = vi.fn(),
      created = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <FleetPlanForm
            inventory={inventory}
            history={[]}
            initialDeploymentId="path"
            initialTargetIds={["core"]}
            onClose={close}
            onCreated={created}
          />
        </UIProviders>
      </QueryClientProvider>,
    );
    const dialog = within(screen.getByRole("dialog"));
    const preview = dialog.getByRole("button", { name: "预览影响与差异" });
    await scenario.click(() => preview);
    await scenario.click(() =>
      dialog.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }),
    );
    const create = dialog.getByRole("button", { name: "创建待执行批次" });
    await scenario.click(() => create);
    const progress = await dialog.findByRole("status");
    await waitFor(() =>
      expect(progress.textContent).toBe("正在创建待执行批次…"),
    );
    expect(progress.closest("[inert]")).toBeNull();
    expect(progress.tabIndex).toBe(0);
    expect(progress.style.paddingBlock).toBe("8px");
    await waitFor(() => expect(document.activeElement).toBe(progress));
    expect(create.closest("[inert]")).not.toBeNull();
    expect(writes).toHaveLength(1);
    expect(created).not.toHaveBeenCalled();
    // Existing pending dismissal guard still owns Escape and Close.
    await userEvent.keyboard("{Escape}");
    await scenario.click(() => dialog.getByRole("button", { name: "关闭" }));
    expect(close).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    if (focus === "owned") act(() => progress.focus());
    else
      expect(document.activeElement).toBe(
        dialog.getByRole("button", { name: "关闭" }),
      );
    await act(async () => resolve(json({ error: "Plan rejected" }, status)));
    await dialog.findByText("Plan rejected");
    expect(dialog.getAllByText("Plan rejected")).toHaveLength(1);
    expect(
      dialog.getByRole("button", {
        name: status === 409 ? "预览影响与差异" : "创建待执行批次",
        description: /Plan rejected/,
      }),
    ).toBe(status === 409 ? preview : create);
    await waitFor(() => expect(progress.textContent).toBe(""));
    expect(progress.tabIndex).toBe(-1);
    expect(progress.style.paddingBlock).toBe("");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        focus === "close"
          ? dialog.getByRole("button", { name: "关闭" })
          : status === 409
            ? preview
            : create,
      ),
    );
    if (status === 409)
      expect(
        dialog.queryByRole("button", { name: "创建待执行批次" }),
      ).toBeNull();
    else expect(dialog.getByText("1 个实例 · 7 位用户受影响")).toBeTruthy();
    expect(writes[0]).toMatchObject({
      deploymentId: "path",
      targetIds: ["core"],
      expectedFingerprint: "reviewed-scope",
    });
  },
);

it("places a single failed preview beside and describes the preview action", async (context) => {
  const scenario = ownedClickScenario(context);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ error: "Preview unavailable" }, 422)),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <FleetPlanForm
          inventory={inventory}
          history={[]}
          initialDeploymentId="path"
          initialTargetIds={["core"]}
          onClose={() => {}}
          onCreated={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  const dialog = within(screen.getByRole("dialog"));
  const preview = dialog.getByRole("button", { name: "预览影响与差异" });
  await scenario.click(() => preview);
  await dialog.findByText("Preview unavailable");
  expect(dialog.getAllByText("Preview unavailable")).toHaveLength(1);
  expect(
    dialog.getByRole("button", {
      name: "预览影响与差异",
      description: /Preview unavailable/,
    }),
  ).toBe(preview);
  expect(dialog.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
});

it("keeps the fleet plan and exact Close focus after two canceled discard decisions", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url) => { requests.push(String(url)); throw new Error(`Unexpected request ${url}`); }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const onClose = vi.fn();
  render(<QueryClientProvider client={client}><UIProviders><FleetPlanForm inventory={inventory} history={[]} initialDeploymentId="path" initialTargetIds={["core"]} onClose={onClose} onCreated={() => {}} /></UIProviders></QueryClientProvider>);
  const dialog = screen.getByRole("dialog");
  const continuous = within(dialog).getByRole("checkbox", { name: "持续运行并有限自动恢复" });
  await userEvent.click(continuous);
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog", { name: "放弃未创建的批量变更计划？" });
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(continuous.getAttribute("aria-checked")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
  }
  expect(requests).toEqual([]);
});
