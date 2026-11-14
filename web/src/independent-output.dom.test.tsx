// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { IndependentOutputTasks } from "./IndependentOutputPublication";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows pending provisioning as waiting, not as a published subscription", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "out-1",
                state: "provisioning",
                createdAt: "2026-11-14T00:00:00Z",
                updatedAt: "2026-11-14T00:00:00Z",
                failureCode: "waiting_for_confirmed_service",
                coverage: "managed-platform-routes",
              },
            ],
          }),
          { status: 200 },
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <IndependentOutputTasks />
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("等待服务器应用配置")).toBeTruthy();
  expect(screen.queryByText("订阅已发布")).toBeNull();
  expect(screen.getByRole("button", { name: "取消创建" })).toBeTruthy();
  client.clear();
});

it("confirms the runtime impact and retries the same payload after a lost response", async () => {
  const { IndependentOutputCreate } =
    await import("./IndependentOutputPublication");
  const { fireEvent } = await import("@testing-library/react");
  const accepted = vi.fn();
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new Error("lost response");
      return new Response(
        JSON.stringify({ id: "stable-id", state: "reserved" }),
        { status: 202 },
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <IndependentOutputCreate
          creation={{
            id: "stable-id",
            name: "工作订阅",
            profileId: "profile",
            target: { adapterId: "sing-box", version: "1" },
            mode: "full",
            previewDigest: "review",
          }}
          enabled
          onAccepted={accepted}
          onLocked={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "创建独立计量订阅" }));
  expect(await screen.findByText(/现有连接可能短暂中断/)).toBeTruthy();
  const dialog = await screen.findByRole("alertdialog");
  const { within } = await import("@testing-library/react");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "创建独立计量订阅" }),
  );
  expect(await within(dialog).findByText(/尚未确认创建结果/)).toBeTruthy();
  expect(accepted).not.toHaveBeenCalled();
  // Dismiss the still-open confirmation after its failed request before retrying.
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("button", { name: "重试同一份创建请求" }));
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  client.clear();
});

it("keeps the same uncertain request recoverable after closing and remounting the creation form", async () => {
  const { IndependentOutputCreate } =
    await import("./IndependentOutputPublication");
  const { fireEvent, within, waitFor } = await import("@testing-library/react");
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET")
        return new Response(JSON.stringify({ items: [] }));
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new Error("lost");
      return new Response(
        JSON.stringify({ id: "persistent", state: "reserved" }),
        { status: 202 },
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const shell = (open: boolean) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <IndependentOutputTasks />
        {open && (
          <IndependentOutputCreate
            creation={{
              id: "persistent",
              name: "保留请求",
              profileId: "p",
              target: { adapterId: "sing-box", version: "1" },
              mode: "full",
              previewDigest: "same-review",
            }}
            enabled
            onAccepted={() => {}}
            onLocked={() => {}}
          />
        )}
      </UIProviders>
    </QueryClientProvider>
  );
  const view = render(shell(true));
  fireEvent.click(screen.getByRole("button", { name: "创建独立计量订阅" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "创建独立计量订阅" }),
  );
  await within(dialog).findByText(/尚未确认创建结果/);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  view.rerender(shell(false));
  fireEvent.click(
    await screen.findByRole("button", { name: "重试「保留请求」创建" }),
  );
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toBe(bodies[0]);
  client.clear();
});

it.each([422, 503])(
  "does not unlock or repopulate a replacement session after an old %s response",
  async (status) => {
    const { IndependentOutputCreate } =
      await import("./IndependentOutputPublication");
    const { fireEvent, within, waitFor } =
      await import("@testing-library/react");
    let settle!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const lock = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <IndependentOutputCreate
            creation={{
              id: "late",
              name: "旧任务",
              profileId: "p",
              target: { adapterId: "sing-box", version: "1" },
              mode: "full",
              previewDigest: "same",
            }}
            enabled
            onAccepted={() => {}}
            onLocked={lock}
          />
        </UIProviders>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "创建独立计量订阅" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "创建独立计量订阅" }),
    );
    await waitFor(() => expect(lock).toHaveBeenCalledWith(true));
    view.unmount();
    client.clear();
    settle(new Response(JSON.stringify({ error: "rejected" }), { status }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lock.mock.calls).toEqual([[true]]);
    expect(
      client.getQueryData(["independent-output-pending-requests"]),
    ).toBeUndefined();
    client.clear();
  },
);

it("keeps normal publication the default and submits explicit independent creation without claiming publication", async () => {
  const { PublishOutput } = await import("./Subscriptions");
  const { emptyProfile } = await import("./model");
  const { fireEvent, within, waitFor } = await import("@testing-library/react");
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
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      paths.push(url);
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/preview"))
        return new Response(
          JSON.stringify({
            valid: true,
            previewScope: "new-output",
            outputId: body.id,
            previewDigest: "checked",
            artifacts: [{ path: "config", content: "review" }],
          }),
        );
      return new Response(
        JSON.stringify({
          id: body.id,
          state: "reserved",
          coverage: "managed-platform-routes",
        }),
        { status: 202 },
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const published = vi.fn(),
    closed = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <PublishOutput
          profile={{
            ...emptyProfile(),
            id: "p",
            name: "测试订阅",
            platformEntryIds: ["managed"],
            sourceIds: [],
          }}
          onClose={closed}
          onPublished={published}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(
    screen
      .getByRole("radio", { name: "共用凭据（默认）" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "为这份订阅单独计量" }));
  fireEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "创建独立计量订阅" }),
  );
  const confirmation = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "创建独立计量订阅" }),
  );
  await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(published).not.toHaveBeenCalled();
  expect(paths).toContain("/api/me/outputs/independent");
  expect(paths).not.toContain("/api/me/outputs");
  client.clear();
});
