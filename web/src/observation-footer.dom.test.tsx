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
function mount(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ObservationConfigForm
          initial={initial}
          instances={[]}
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
    "更换周期会清除原周期的账单引用，不修改用户流量账单",
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
