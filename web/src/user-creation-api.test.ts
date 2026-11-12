import { afterEach, expect, it, vi } from "vitest";
import {
  createUser,
  installSessionTransport,
  saveRecord,
  setCSRF,
  setToken,
} from "./api";
import type { UserRecord } from "./types";
const draft: UserRecord = {
  id: "user-one",
  name: "One",
  enabled: true,
  quotaBytes: 125,
  usedBytes: 0,
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
it("uses atomic absence only for Add user and retains existing authentication headers", async () => {
  const fetch = vi.fn(async () => json(draft));
  vi.stubGlobal("fetch", fetch);
  setToken("synthetic-operator");
  setCSRF("synthetic-csrf");
  await expect(createUser(draft)).resolves.toEqual(draft);
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/api/users");
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify(draft));
  const headers = new Headers(init.headers);
  expect(headers.get("If-None-Match")).toBe("*");
  expect(headers.get("Authorization")).toBe("Bearer synthetic-operator");
  expect(headers.get("X-CSRF-Token")).toBe("synthetic-csrf");
});
it.each([false, true])(
  "keeps legacy saveRecord isNew=%s unguarded",
  async (isNew) => {
    const fetch = vi.fn(async () => json(draft));
    vi.stubGlobal("fetch", fetch);
    await saveRecord("users", draft, isNew);
    const [path, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe(isNew ? "/api/users" : "/api/users/user-one");
    expect(init.method).toBe(isNew ? "POST" : "PUT");
    expect(new Headers(init.headers).has("If-None-Match")).toBe(false);
  },
);
it.each(["USER_CREATION_INVALID", "USER_CREATION_PRECONDITION_INVALID"])(
  "recognizes only explicit pre-write code %s on 400",
  async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ code, detail: "Specific rejection" }, 400)),
    );
    await expect(createUser(draft)).rejects.toMatchObject({
      outcome: "rejected",
      message: "Specific rejection",
    });
  },
);
it.each([
  [400, undefined],
  [400, "OTHER_ERROR"],
  [500, "USER_CREATION_INVALID"],
  [412, "USER_CREATION_CONFLICT"],
  [401, undefined],
  [403, undefined],
  [422, undefined],
] as const)(
  "retains uncertainty for status %i code %s",
  async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ code, detail: "Unknown outcome" }, status)),
    );
    await expect(createUser(draft)).rejects.toMatchObject({
      outcome: "unknown",
    });
  },
);
it.each([
  null,
  {},
  { ...draft, id: "other" },
  { ...draft, name: null },
  { ...draft, enabled: null },
  { ...draft, quotaBytes: -1 },
  { ...draft, usedBytes: -1 },
])("does not accept malformed successful receipt %j", async (value) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(value)),
  );
  await expect(createUser(draft)).rejects.toMatchObject({ outcome: "unknown" });
});
it("preserves uncertainty for unreadable and lost responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response("{"))
      .mockRejectedValueOnce(new TypeError("lost")),
  );
  await expect(createUser(draft)).rejects.toMatchObject({ outcome: "unknown" });
  await expect(createUser(draft)).rejects.toMatchObject({ outcome: "unknown" });
});
it("allows a newer returned configuration to be compared rather than falsely claiming it was saved", async () => {
  const newer = {
    ...draft,
    name: "Newer",
    enabled: false,
    quotaBytes: 99,
    usedBytes: 2,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(newer)),
  );
  await expect(createUser(draft)).resolves.toEqual(newer);
});
it("recognizes a session check that rejects before dispatch", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  uninstall = installSessionTransport({
    beforeRequest: () => ({
      beforeSend() {
        throw new Error("Session must be restored");
      },
      waitForResponse: async () => {},
    }),
    failed() {},
  });
  await expect(createUser(draft)).rejects.toMatchObject({
    outcome: "rejected",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("does not mistake a post-dispatch session fence for non-commit", async () => {
  const fetch = vi.fn(async () => json(draft));
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
  await expect(createUser(draft)).rejects.toMatchObject({ outcome: "unknown" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
