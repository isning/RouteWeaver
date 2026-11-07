// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ObservationConfigForm } from "./ObservationForms";
import type { CoreInstance } from "./types";
import type { NodeObservationView } from "./observability-model";
const initial: NodeObservationView = {
  nodeId: "host",
  latest: null,
  provider: {
    source: "none",
    coverage: "none",
    statusReason: "provider_statement_required",
    fresh: false,
    observedAt: null,
    observedSince: null,
    observedNicBytes: 0,
    totalBytes: null,
    usedBytes: null,
    remainingBytes: null,
    exhaustionAction: "advisory",
    notificationEligible: false,
  },
  config: {
    revision: 1,
    observerInstanceId: "",
    billedInterfaces: [],
    provider: {
      name: "Provider",
      mode: "limited",
      allowance: 100,
      unit: "GB",
      cycleId: "cycle",
      cycleStart: "2026-10-01T00:00:00Z",
      cycleEnd: "2026-11-01T00:00:00Z",
      notificationSource: "none",
      exhaustionAction: "advisory",
    },
  },
};
const clients: QueryClient[] = [];
function mount(
  onClose = vi.fn(),
  value = initial,
  instances: CoreInstance[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ObservationConfigForm
          initial={value}
          instances={instances}
          onClose={onClose}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return onClose;
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps reset consequences with the external submit footer and retains native form submission without losing rejected input", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const close = mount();
  const user = userEvent.setup();
  const name = screen.getByLabelText("供应商或服务名称");
  const submit = screen.getByRole("button", {
    name: "保存采集与额度设置",
  }) as HTMLButtonElement;
  const footer = submit.closest('[data-slot="dialog-footer"]')!;
  expect(footer).toBeTruthy();
  expect(footer.textContent).toContain(
    "更换周期会清除原周期的账单引用，保留用户流量账单",
  );
  expect(footer.textContent).toContain("不自动更换线路");
  expect(submit.form).toBe(name.closest("form"));
  expect(name.closest("form")?.contains(submit)).toBe(false);
  await user.type(name, " edited");
  // user-event only discovers descendant submit controls for implicit Enter.
  // Dispatch the native form seam; real browser Enter is a separate QA check.
  fireEvent.submit(name.closest("form")!);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(submit.disabled).toBe(true);
  expect(
    (
      within(footer as HTMLElement).getByRole("button", {
        name: "取消",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    resolve(
      new Response(JSON.stringify({ error: "请重新核对采集配置" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  expect(await screen.findByText("请重新核对采集配置")).toBeTruthy();
  await waitFor(() => expect(submit.disabled).toBe(false));
  expect((name as HTMLInputElement).value).toBe("Provider edited");
  await user.click(
    within(footer as HTMLElement).getByRole("button", { name: "取消" }),
  );
  const discard = within(await screen.findByRole("alertdialog"));
  expect(discard.getByText("放弃未保存的采集与额度设置？")).toBeTruthy();
  await user.click(discard.getByRole("button", { name: "继续编辑" }));
  expect(close).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(footer as HTMLElement).getByRole("button", { name: "取消" }),
    ),
  );
});

it("submits from the external decision footer without changing the provider cycle", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(initial), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const close = mount();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "保存采集与额度设置" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledOnce();
  const body = JSON.parse(
    (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
      .body as string,
  );
  expect(body.provider.cycleId).toBe("cycle");
  expect(body.provider.cycleStart).toBe("2026-10-01T00:00:00Z");
  expect(body.provider.cycleEnd).toBe("2026-11-01T00:00:00Z");
});

it("confirms explicit managed suspension consequences, cancels without writing and preserves the selected policy on save", async () => {
  const value: NodeObservationView = structuredClone(initial);
  value.config.provider!.exhaustionAction = "suspend-managed";
  value.config.provider!.notificationSource = "provider_statement";
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const close = mount(vi.fn(), value, [
    {
      id: "managed",
      hostId: "host",
      adapterId: "routeweaver/managed-xray",
      version: "fixture",
    },
  ]);
  const user = userEvent.setup();
  const submit = screen.getByRole("button", { name: "保存采集与额度设置" });
  await user.click(submit);
  let confirm = within(await screen.findByRole("alertdialog"));
  expect(confirm.getByText("启用 host 的托管连接暂停策略？")).toBeTruthy();
  expect(confirm.getByText(/超过 15 分钟/).textContent).toContain("stock 内核");
  expect(confirm.getByText(/超过 15 分钟/).textContent).toContain(
    "手工账单记录不会自动刷新",
  );
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(confirm.getByRole("button", { name: "返回修改" }));
  await waitFor(() => expect(document.activeElement).toBe(submit));
  expect(close).not.toHaveBeenCalled();
  await user.click(submit);
  confirm = within(await screen.findByRole("alertdialog"));
  await user.click(confirm.getByRole("button", { name: "确认启用并保存" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledOnce();
  const body = JSON.parse(
    (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
      .body as string,
  );
  expect(body.provider.exhaustionAction).toBe("suspend-managed");
  expect(body.provider.notificationSource).toBe("provider_statement");
});

it("does not offer managed suspension based on another host's instance", async () => {
  mount(vi.fn(), initial, [
    {
      id: "other-managed",
      hostId: "other-host",
      adapterId: "routeweaver/managed-xray",
      version: "fixture",
    },
  ]);
  await userEvent
    .setup()
    .click(screen.getByRole("combobox", { name: "额度耗尽行为" }));
  const option = await screen.findByRole("option", {
    name: "暂停托管连接及续期",
  });
  expect(option.getAttribute("aria-disabled")).toBe("true");
});

// Source-only reconstructed v123 cases: UNRUN.
it.each(["1.0000000000000000001", "2.5", "1e", "", "0", "-1", "9007200"])(
  "retains invalid provider unit intent %s without submitting rounded bytes", async (raw) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    mount();
    const input = screen.getByLabelText("周期额度") as HTMLInputElement;
    fireEvent.change(input, { target: { value: raw } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText(raw === "9007200"
      ? "用量超出网页可精确提交的整数范围，请缩小数值。"
      : "供应商额度请输入正整数，2.5 TB 可写为 2500 GB。");
    expect(input.value).toBe(raw);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([["2.000", 2], ["2e3", 2000], ["9007199", 9007199]])(
  "submits exact provider units %s", async (raw, expected) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(initial), {
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const close = mount();
    const input = screen.getByLabelText("周期额度");
    fireEvent.change(input, { target: { value: raw } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.provider.allowance).toBe(expected);
    expect(body.provider.unit).toBe("GB");
  },
);
it("does not let hidden invalid allowance block unlimited service", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(initial), {
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetcher);
  const close = mount();
  fireEvent.change(screen.getByLabelText("周期额度"), { target: { value: "1e" } });
  await userEvent.click(screen.getByLabelText("额度类型"));
  await userEvent.click(await screen.findByRole("option", { name: "不限量" }));
  fireEvent.submit(screen.getByLabelText("供应商或服务名称").closest("form")!);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.provider).toMatchObject({ allowance: 0, mode: "unlimited", notificationSource: "none", exhaustionAction: "advisory" });
});

// Keyboard controls are source-only coverage; actual browser wheel/locale UNRUN.
it("preserves provider spinbutton defaults, bounds and explicit exact-tail correction", async () => {
  vi.stubGlobal("fetch", vi.fn());
  mount();
  const input = screen.getByRole("spinbutton", { name: "周期额度" }) as HTMLInputElement;
  expect(input.value).toBe("100");
  expect(input.getAttribute("min")).toBe("1");
  expect(input.getAttribute("max")).toBe("9007199254740991");
  expect(input.getAttribute("step")).toBe("1");
  expect(input.getAttribute("aria-valuenow")).toBe("100");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("101");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.value).toBe("100");
  for (const [raw, key, expected] of [
    ["", "ArrowUp", "1"], ["", "ArrowDown", "1"],
    ["1", "ArrowDown", "1"],
    ["9007199254740991", "ArrowUp", "9007199254740991"],
    ["100.00000000000000000001", "ArrowDown", "100"],
    ["99.99999999999999999999", "ArrowUp", "100"],
  ]) {
    fireEvent.change(input, { target: { value: raw } });
    expect(input.value).toBe(raw);
    fireEvent.keyDown(input, { key });
    expect(input.value).toBe(expected);
    expect(input.getAttribute("aria-valuenow")).toBe(expected);
  }
});
