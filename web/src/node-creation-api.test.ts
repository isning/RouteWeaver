import { afterEach, expect, it, vi } from "vitest";
import {
  createNode,
  installSessionTransport,
  saveRecord,
  setCSRF,
  setToken,
} from "./api";
import type { NodeRecord } from "./types";
const draft: NodeRecord = {
  id: "node-one",
  name: "One endpoint",
  host: "proxy.example.invalid",
  port: 1080,
  protocol: "socks",
  tags: [],
  region: "",
};
const saved = {
  id: draft.id,
  name: draft.name,
  host: draft.host,
  port: draft.port,
  protocol: draft.protocol,
  status: "unregistered",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  setToken("");
  setCSRF("");
  vi.unstubAllGlobals();
});
it("opts Add endpoint into atomic absence and returns canonical persisted Node fields", async () => {
  const fetch = vi.fn(async () =>
    json({ ...saved, $schema: "https://example.invalid/schema" }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(createNode(draft)).resolves.toEqual(saved);
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/api/nodes");
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("If-None-Match")).toBe("*");
  expect(JSON.parse(String(init.body))).toEqual(saved);
});
it.each([true, false])(
  "keeps legacy node saveRecord isNew=%s unguarded",
  async (isNew) => {
    const fetch = vi.fn(async () => json(saved));
    vi.stubGlobal("fetch", fetch);
    await saveRecord("nodes", draft, isNew);
    const [path, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe(isNew ? "/api/nodes" : "/api/nodes/node-one");
    expect(new Headers(init.headers).has("If-None-Match")).toBe(false);
  },
);
it.each(["NODE_CREATION_INVALID", "NODE_CREATION_PRECONDITION_INVALID"])(
  "recognizes explicit pre-write %s without echoing the response detail",
  async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ code, detail: "Arbitrary connection detail" }, 400),
      ),
    );
    await expect(createNode(draft)).rejects.toMatchObject({
      outcome: "rejected",
      message: "端点未创建，请检查连接参数后重试。",
    });
  },
);
it.each([
  [400, undefined],
  [400, "OTHER"],
  [500, "NODE_CREATION_INVALID"],
  [412, "NODE_CREATION_CONFLICT"],
  [401, undefined],
  [403, undefined],
  [422, undefined],
] as const)(
  "keeps outcome uncertain for status %i code %s",
  async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ code, detail: "Arbitrary connection detail" }, status),
      ),
    );
    await expect(createNode(draft)).rejects.toMatchObject({
      outcome: "unknown",
      message: "尚未确认端点是否创建",
    });
  },
);
it.each([
  null,
  {},
  [],
  { ...saved, id: "other" },
  { ...saved, name: null },
  { ...saved, host: 1 },
  { ...saved, port: "1080" },
  { ...saved, port: 1080.1 },
  { ...saved, port: 65536 },
  { ...saved, status: undefined },
  { ...saved, tags: [1] },
  { ...saved, tls: { enabled: "true" } },
  { ...saved, transport: { type: "ws", headers: { "X-Client": 1 } } },
  { ...saved, unrecognizedConnectionOption: true },
])("does not accept malformed receipt %j", async (receipt) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(receipt)),
  );
  await expect(createNode(draft)).rejects.toMatchObject({ outcome: "unknown" });
});
it("preserves uncertainty for unreadable, lost and interrupted response-body reads", async () => {
  const broken = new Response("{}");
  broken.text = async () => {
    throw new TypeError("Interrupted body");
  };
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response("{"))
      .mockRejectedValueOnce(new TypeError("Lost"))
      .mockResolvedValueOnce(broken),
  );
  for (let i = 0; i < 3; i++)
    await expect(createNode(draft)).rejects.toMatchObject({
      outcome: "unknown",
    });
});
it("returns changed valid Node fields for explicit comparison, never claims they match the submission", async () => {
  const later = {
    ...saved,
    name: "Later",
    host: "later.example.invalid",
    coreId: "new-core",
    tags: ["later"],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(later)),
  );
  await expect(createNode(draft)).resolves.toEqual(later);
});
it("rejects a malformed local Node before dispatch without serializing its fields into an error", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(createNode({ ...draft, port: -1 })).rejects.toMatchObject({
    outcome: "rejected",
    message: "端点资料格式不正确，请检查输入。",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves authentication and CSRF headers on the guarded command", async () => {
  const fetch = vi.fn(async () => json(saved));
  vi.stubGlobal("fetch", fetch);
  setToken("synthetic-operator");
  setCSRF("synthetic-csrf");
  await createNode(draft);
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const headers = new Headers(init.headers);
  expect(headers.get("Authorization")).toBe("Bearer synthetic-operator");
  expect(headers.get("X-CSRF-Token")).toBe("synthetic-csrf");
  expect(headers.get("If-None-Match")).toBe("*");
});
it("classifies a session gate before dispatch as rejected without echoing its arbitrary error", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  uninstall = installSessionTransport({
    beforeRequest: () => ({
      beforeSend() {
        throw new Error("Arbitrary session detail");
      },
      waitForResponse: async () => {},
    }),
    failed() {},
  });
  await expect(createNode(draft)).rejects.toMatchObject({
    outcome: "rejected",
    message: "本次创建未发送，请先确认登录状态。",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("does not mistake a post-dispatch session fence for non-commit", async () => {
  const fetch = vi.fn(async () => json(saved));
  vi.stubGlobal("fetch", fetch);
  uninstall = installSessionTransport({
    beforeRequest: () => ({
      beforeSend() {},
      waitForResponse: async () => {
        throw new Error("Newer session owns the page");
      },
    }),
    failed() {},
  });
  await expect(createNode(draft)).rejects.toMatchObject({ outcome: "unknown" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
