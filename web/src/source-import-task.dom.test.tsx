// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceImportTask, type SourceImportResult } from "./SourceImportTask";
import { hasUnsavedChanges } from "./navigation";
import type { Source } from "./types";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
const candidate: Source = {
  id: "source-one",
  name: "First import",
  kind: "text",
  enabled: true,
  revision: "review-r1",
  refreshStatus: "review-required",
  candidate: {
    id: "candidate-one",
    createdAt: "2026-10-23",
    diff: {
      beforeCount: 0,
      afterCount: 1,
      added: [{ id: "endpoint-one", name: "London" }],
      removed: [],
      renamed: [],
      connectionChanged: [],
    },
    affected: [],
    diagnostics: [{ code: "connection-extraction" }],
  },
};
const accepted = (value = candidate): Source => ({
  ...value,
  candidate: undefined,
  revision: "accepted-r2",
  refreshStatus: "accepted",
  snapshot: { endpoints: [] },
  diagnostics: value.candidate?.diagnostics,
});
function mount(source = candidate) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  function Host({ source, owner }: { source: Source; owner: string }) {
    const [result, setResult] = useState<SourceImportResult | null>(null);
    const [resumed, setResumed] = useState<Source | undefined>();
    return (
      <>
        <SourceImportTask
          key={owner}
          open={!result}
          source={resumed || source}
          onFinish={setResult}
        />
        {result && (
          <output>
            {result.kind === "ready" ? "已加入草稿" : "未加入草稿"}：
            {result.source?.name}
          </output>
        )}
        {result?.kind === "deferred" && result.source && (
          <button
            onClick={() => {
              setResumed(result.source);
              setResult(null);
            }}
          >
            继续来源任务
          </button>
        )}
      </>
    );
  }
  const tree = (value: Source, owner: string) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <UIProviders>
          <Host source={value} owner={owner} />
        </UIProviders>
      </QueryClientProvider>
    </StrictMode>
  );
  const view = render(tree(source, "first"));
  return {
    replace: (value: Source) => view.rerender(tree(value, "new-owner")),
  };
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
  // JSDOM has no layout; give AntD's nested-dialog focus trap visible elements.
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      if (!this.isConnected) return null;
      for (
        let node: HTMLElement | null = this;
        node;
        node = node.parentElement
      ) {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden")
          return null;
      }
      return this.parentElement;
    },
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["double click", "held Enter"])(
  "requires a new use gesture after read-back by %s, including an accepted snapshot whose newer input failed",
  async (gesture) => {
    const requests: string[] = [];
    const current = {
      ...accepted(),
      revision: "later-failed-r3",
      refreshStatus: "failed",
      lastError: "Newer input could not be imported",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        if (String(url).endsWith("/apply"))
          throw new TypeError("Lost response");
        return json(current);
      }),
    );
    mount();
    let review = within(
      await screen.findByRole("dialog", { name: "查看导入变化" }),
    );
    expect(hasUnsavedChanges()).toBe(false);
    await userEvent.click(review.getByRole("button", { name: "应用更新" }));
    const verify = await review.findByRole("button", { name: "核对当前状态" });
    if (gesture === "double click") await userEvent.dblClick(verify);
    else {
      verify.focus();
      // A newly chosen action must retain focus across the prior summary's
      // scheduled layout recovery, before held Enter begins a fresh gesture.
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(document.activeElement).toBe(verify);
      await userEvent.keyboard("{Enter>3/}");
    }
    review = within(
      await screen.findByRole("dialog", { name: "核对来源状态" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        review.getByLabelText("来源检查摘要"),
      ),
    );
    expect(screen.queryByText(/已加入草稿/)).toBeNull();
    expect(
      review.getByText("导入未完成。请检查来源设置和内容后重试。"),
    ).toBeTruthy();
    expect(review.queryByText("Newer input could not be imported")).toBeNull();
    expect(
      review.getByText("导入失败时保留之前的节点，可修正输入后重试。"),
    ).toBeTruthy();
    expect(requests).toEqual([
      "POST /api/me/sources/source-one/apply",
      "GET /api/me/sources/source-one",
    ]);
    await userEvent.click(review.getByRole("button", { name: "使用当前节点" }));
    await screen.findByText("已加入草稿：First import");
    expect(requests).toHaveLength(2);
  },
);

it("does not offer a paused accepted source as usable after verification or silently enable it", async () => {
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(String(url));
        return json({ detail: "Source changed" }, 409);
      }
      return json({
        ...accepted(),
        enabled: false,
        revision: "paused-r3",
        refreshStatus: "paused",
      });
    }),
  );
  mount();
  let review = within(
    await screen.findByRole("dialog", { name: "查看导入变化" }),
  );
  await userEvent.click(review.getByRole("button", { name: "应用更新" }));
  await userEvent.click(
    await review.findByRole("button", { name: "核对当前状态" }),
  );
  review = within(await screen.findByRole("dialog", { name: "核对来源状态" }));
  expect(review.getByText("来源已暂停")).toBeTruthy();
  expect(review.queryByRole("button", { name: "使用当前节点" })).toBeNull();
  expect(writes).toEqual(["/api/me/sources/source-one/apply"]);
  await userEvent.click(review.getByRole("button", { name: "返回草稿" }));
  await screen.findByText("未加入草稿：First import");
});

it("requires a new explicit decision for a replacement candidate and submits its current revision", async () => {
  const replacement = {
    ...candidate,
    revision: "review-r3",
    candidate: {
      ...candidate.candidate!,
      id: "candidate-new",
      diff: {
        ...candidate.candidate!.diff,
        added: [{ id: "new-endpoint", name: "Paris" }],
      },
    },
  };
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return writes.length === 1
          ? json({ detail: "Source changed" }, 409)
          : json(accepted(replacement));
      }
      return json(replacement);
    }),
  );
  mount();
  const review = within(
    await screen.findByRole("dialog", { name: "查看导入变化" }),
  );
  await userEvent.click(review.getByRole("button", { name: "应用更新" }));
  await userEvent.click(
    await review.findByRole("button", { name: "核对当前状态" }),
  );
  await review.findByText("Paris");
  expect(writes).toHaveLength(1);
  expect(screen.queryByText(/已加入草稿/)).toBeNull();
  await userEvent.click(review.getByRole("button", { name: "应用更新" }));
  await screen.findByText("已加入草稿：First import");
  expect(writes).toEqual([
    { candidateId: "candidate-one", sourceRevision: "review-r1" },
    { candidateId: "candidate-new", sourceRevision: "review-r3" },
  ]);
});

it("keeps a pending acceptance in its owning task and ignores completion after owner replacement", async () => {
  let complete: ((response: Response) => void) | undefined;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const host = mount();
  let review = within(
    await screen.findByRole("dialog", { name: "查看导入变化" }),
  );
  await userEvent.dblClick(review.getByRole("button", { name: "应用更新" }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.click(review.getByRole("button", { name: "关闭" }));
  expect(screen.queryByText(/未加入草稿/)).toBeNull();
  const next = {
    ...candidate,
    id: "source-two",
    name: "New owner source",
    candidate: { ...candidate.candidate!, id: "candidate-two" },
  };
  host.replace(next);
  await act(async () => complete!(json(accepted())));
  review = within(await screen.findByRole("dialog", { name: "查看导入变化" }));
  expect(review.getByText("New owner source")).toBeTruthy();
  expect(screen.queryByText(/已加入草稿/)).toBeNull();
  expect(hasUnsavedChanges()).toBe(false);
});

it("treats an accepted empty snapshot as an update rather than a first import", async () => {
  vi.stubGlobal("fetch", vi.fn());
  mount({ ...candidate, snapshot: { endpoints: [] } });
  const review = within(
    await screen.findByRole("dialog", { name: "查看变化" }),
  );
  expect(review.getByRole("button", { name: "忽略本次更新" })).toBeTruthy();
  expect(review.getByRole("button", { name: "应用更新" })).toBeTruthy();
});

it("rechecks a deferred accepted source on resume before using or deciding on its current candidate", async () => {
  let reads = 0;
  let accepts = 0;
  const replacement = {
    ...candidate,
    revision: "new-current-r3",
    candidate: { ...candidate.candidate!, id: "replacement-candidate" },
    snapshot: accepted().snapshot,
  };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      accepts++;
      if (accepts === 1) return json({ detail: "Response lost" }, 503);
      expect(JSON.parse(String(init.body))).toEqual({
        candidateId: "replacement-candidate",
        sourceRevision: "new-current-r3",
      });
      return json(accepted(replacement));
    }
    reads++;
    return json(reads === 1 ? accepted() : replacement);
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "应用更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "核对当前状态" }));
  await screen.findByRole("button", { name: "使用当前节点" });
  fireEvent.click(screen.getByRole("button", { name: "返回草稿" }));
  fireEvent.click(await screen.findByRole("button", { name: "继续来源任务" }));
  const review = within(
    await screen.findByRole("dialog", { name: "核对来源状态" }),
  );
  expect(review.queryByRole("button", { name: "使用当前节点" })).toBeNull();
  expect(reads).toBe(1);
  fireEvent.click(review.getByRole("button", { name: "核对当前状态" }));
  const current = within(
    await screen.findByRole("dialog", { name: "查看变化" }),
  );
  expect(accepts).toBe(1);
  await userEvent.click(current.getByRole("button", { name: "应用更新" }));
  await screen.findByText("已加入草稿：First import");
  expect(reads).toBe(2);
  expect(accepts).toBe(2);
});
