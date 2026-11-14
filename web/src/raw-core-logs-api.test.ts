import { afterEach, expect, it, vi } from "vitest";
import { requestCoreLogExport, setToken } from "./api";
afterEach(() => {
  setToken("");
  vi.unstubAllGlobals();
});
it("exports only the fixed core endpoint with encoded filters and authenticated transport", async () => {
  setToken("synthetic-operator-token");
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response('{"text":"synthetic"}\n', {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await requestCoreLogExport("core/one", {
    stream: "stderr",
    q: "test & query",
    since: "2026-11-14T00:00:00Z",
  });
  expect(fetch.mock.calls[0][0]).toBe(
    "/api/admin/instances/core%2Fone/core-logs?stream=stderr&q=test+%26+query&since=2026-11-14T00%3A00%3A00Z&format=ndjson",
  );
  expect(fetch.mock.calls[0][1]).toMatchObject({
    redirect: "error",
    credentials: "same-origin",
  });
  expect(await result.blob.text()).toBe('{"text":"synthetic"}\n');
  result.assertCurrent();
});
it("rejects an unexpected document rather than downloading it as logs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("<html>sign in</html>", {
          headers: { "Content-Type": "text/html" },
        }),
    ),
  );
  await expect(requestCoreLogExport("core", {})).rejects.toThrow(
    "服务器未返回日志文件",
  );
});
it("does not hand raw bytes to a replacement login session", async () => {
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
  setToken("synthetic-first");
  const result = requestCoreLogExport("core", {});
  setToken("synthetic-second");
  settle(
    new Response("synthetic raw text", {
      headers: { "Content-Type": "application/x-ndjson" },
    }),
  );
  await expect(result).rejects.toThrow("登录状态已变化");
});
