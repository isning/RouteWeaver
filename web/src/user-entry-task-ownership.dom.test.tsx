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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { UserEntries } from "./UserEntries";
const json = (v: unknown) =>
  new Response(JSON.stringify(v), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("late A reveal must not overwrite current B editing task", async () => {
  const a = {
    id: "a",
    name: "Entry A",
    routeId: "route",
    credentialVersion: "v1",
    connection: { protocol: "socks", host: "a.example", port: 1080 },
  };
  const b = {
    ...a,
    id: "b",
    name: "Entry B",
    connection: { ...a.connection, host: "b.example" },
  };
  let releaseA!: (r: Response) => void;
  const delayed = new Promise<Response>((r) => (releaseA = r));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/a/reveal")
        ? delayed
        : String(url).endsWith("/b/reveal")
          ? json(b)
          : String(url).endsWith("/effective-policy")
            ? json({ userId: "u", routeIds: ["route"] })
            : json([a, b]),
    ),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <UserEntries
          user={{
            id: "u",
            name: "User",
            enabled: true,
            quotaBytes: 0,
            usedBytes: 0,
          }}
          routes={[{ id: "route", name: "Route", userIds: ["u"] } as any]}
          services={[]}
          onClose={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  const ar = await screen.findByRole("listitem", { name: "Entry A" }),
    br = screen.getByRole("listitem", { name: "Entry B" });
  fireEvent.click(within(ar).getByRole("button", { name: "编辑" }));
  fireEvent.click(within(br).getByRole("button", { name: "编辑" }));
  const field = await screen.findByRole("textbox", { name: "入口名称" });
  expect((field as HTMLInputElement).value).toBe("Entry B");
  fireEvent.change(field, { target: { value: "B unsaved edit" } });
  await act(async () => {
    releaseA(json(a));
    await delayed;
  });
  expect(
    (screen.getByRole("textbox", { name: "入口名称" }) as HTMLInputElement)
      .value,
  ).toBe("B unsaved edit");
});
it("reallocates a revoked legacy entry with a fresh empty credential draft, never revealing revoked credentials", async () => {
  const revoked = {
    id: "revoked",
    name: "Retired entry",
    routeId: "route",
    credentialVersion: "old-version",
    revoked: true,
  };
  const reveals: string[] = [];
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/reveal")) {
        reveals.push(String(url));
        return new Response(JSON.stringify({ detail: "entry revoked" }), {
          status: 404,
        });
      }
      if (init?.method === "POST") {
        sent = JSON.parse(init.body);
        return json({ ...revoked, ...sent, revoked: false });
      }
      return json(String(url).endsWith("/effective-policy") ? { userId: "u", routeIds: ["route"] } : [revoked]);
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <UserEntries
          user={{
            id: "u",
            name: "User",
            enabled: true,
            quotaBytes: 0,
            usedBytes: 0,
          }}
          routes={[{ id: "route", name: "Route", userIds: ["u"] } as any]}
          services={[]}
          onClose={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "重新分配" }));
  const name = await screen.findByRole("textbox", { name: "入口名称" });
  expect((name as HTMLInputElement).value).toBe("Retired entry");
  expect(reveals).toEqual([]);
  const host = screen.getByRole("textbox", { name: "连接地址" });
  expect((host as HTMLInputElement).value).toBe("");
  fireEvent.change(host, { target: { value: "new.example" } });
  fireEvent.click(screen.getByRole("button", { name: "保存入口" }));
  await waitFor(() => expect(sent).toBeDefined());
  expect(sent.id).toBe("revoked");
  expect(sent.credentialVersion).not.toBe("old-version");
  expect(sent.connection).toMatchObject({
    protocol: "socks",
    host: "new.example",
    port: 1080,
  });
  expect(sent.connection.password).toBeUndefined();
});

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const entries = ["A", "B"].map((name) => ({
  id: name.toLowerCase(),
  name: `Entry ${name}`,
  routeId: "route",
  credentialVersion: `${name}-v1`,
  connection: {
    protocol: "socks",
    host: `${name.toLowerCase()}.example`,
    port: 1080,
  },
}));
function mountTask(
  reveals: Record<string, ReturnType<typeof deferred>>,
  userId = "u",
) {
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "POST") {
        writes.push({ url: path, body: JSON.parse(init.body) });
        return json({});
      }
      for (const [id, held] of Object.entries(reveals))
        if (path.endsWith(`/${id}/reveal`)) return held.promise;
      return json(path.endsWith("/effective-policy") ? { userId: path.split("/")[3], routeIds: ["route"] } : entries);
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props = {
    user: {
      id: userId,
      name: "User",
      enabled: true,
      quotaBytes: 0,
      usedBytes: 0,
    },
    routes: [{ id: "route", name: "Route", userIds: ["u", "other"] } as any],
    services: [],
    onClose: vi.fn(),
  };
  const view = (user: typeof props.user | null) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <UserEntries {...props} user={user} />
      </UIProviders>
    </QueryClientProvider>
  );
  const rendered = render(view(props.user));
  return {
    writes,
    props,
    rerender: (user: typeof props.user | null) => rendered.rerender(view(user)),
  };
}
async function editRow(name: string) {
  fireEvent.click(
    within(await screen.findByRole("listitem", { name })).getByRole("button", {
      name: "编辑",
    }),
  );
}
it("cancelled reveal cannot reopen the editor or show a late failure", async () => {
  const errors = vi.spyOn(console, "error");
  const a = deferred();
  mountTask({ a });
  await editRow("Entry A");
  expect(await screen.findByText("正在读取「Entry A」的入口凭据")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消读取" }));
  await act(async () => {
    a.resolve(
      new Response(JSON.stringify({ detail: "obsolete failure" }), {
        status: 503,
      }),
    );
    await a.promise;
  });
  expect(screen.queryByRole("textbox", { name: "入口名称" })).toBeNull();
  expect(screen.queryByText("obsolete failure")).toBeNull();
  expect(errors.mock.calls.flat().join(" ")).not.toContain(
    "not connected to any Form element",
  );
});
it.each(["close", "account"] as const)(
  "invalidates a reveal across %s and a new editing task",
  async (kind) => {
    const a = deferred(),
      b = deferred();
    const task = mountTask({ a, b });
    await editRow("Entry A");
    if (kind === "close") {
      task.rerender(null);
      task.rerender(task.props.user);
    } else task.rerender({ ...task.props.user, id: "other" });
    await editRow("Entry B");
    await act(async () => {
      b.resolve(json(entries[1]));
      await b.promise;
    });
    const field = await screen.findByRole("textbox", { name: "入口名称" });
    fireEvent.change(field, { target: { value: "Current draft" } });
    await act(async () => {
      a.resolve(json(entries[0]));
      await a.promise;
    });
    expect(
      (screen.getByRole("textbox", { name: "入口名称" }) as HTMLInputElement)
        .value,
    ).toBe("Current draft");
    fireEvent.click(screen.getByRole("button", { name: "保存入口" }));
    await waitFor(() => expect(task.writes).toHaveLength(1));
    expect(task.writes[0].body.id).toBe("b");
    expect(task.writes[0].body.name).toBe("Current draft");
    expect(task.writes[0].url).toBe(
      `/api/users/${kind === "account" ? "other" : "u"}/entries`,
    );
  },
);
it("closing a dirty editor requires a discard decision and cancellation preserves the current draft", async () => {
  const b = deferred();
  mountTask({ b });
  await editRow("Entry B");
  await act(async () => {
    b.resolve(json(entries[1]));
    await b.promise;
  });
  fireEvent.change(await screen.findByRole("textbox", { name: "入口名称" }), {
    target: { value: "Unsaved B" },
  });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  const confirmation = await screen.findByRole("alertdialog");
  expect(confirmation.textContent).toContain("放弃未保存的入口修改");
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    (screen.getByRole("textbox", { name: "入口名称" }) as HTMLInputElement)
      .value,
  ).toBe("Unsaved B");
});


it("keeps user-entry Close focus after twice canceling a dirty draft", async () => {
  const b = deferred();
  const task = mountTask({ b });
  await editRow("Entry B");
  await act(async () => { b.resolve(json(entries[1])); await b.promise; });
  const name = await screen.findByRole("textbox", { name: "入口名称" });
  fireEvent.change(name, { target: { value: "Retained entry" } });
  const close = within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((name as HTMLInputElement).value).toBe("Retained entry");
  }
  expect(task.writes).toEqual([]);
});

it("does not carry populated credentials into another entry after closing its editor", async () => {
  const a = deferred(),
    b = deferred();
  const task = mountTask({ a, b });
  await editRow("Entry A");
  await act(async () => {
    a.resolve(
      json({
        ...entries[0],
        connection: {
          ...entries[0].connection,
          username: "entry-a-user",
          password: "fixture-only-secret-a",
        },
      }),
    );
    await a.promise;
  });
  expect(await screen.findByLabelText("用户名")).toHaveProperty(
    "value",
    "entry-a-user",
  );
  expect(screen.getByLabelText("密码", { exact: true })).toHaveProperty(
    "value",
    "fixture-only-secret-a",
  );
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await editRow("Entry B");
  await act(async () => {
    b.resolve(json(entries[1]));
    await b.promise;
  });
  expect(
    await screen.findByRole("textbox", { name: "入口名称" }),
  ).toHaveProperty("value", "Entry B");
  expect(screen.getByLabelText("用户名")).toHaveProperty("value", "");
  expect(screen.getByLabelText("密码", { exact: true })).toHaveProperty(
    "value",
    "",
  );
  await userEvent.click(screen.getByRole("button", { name: "保存入口" }));
  await waitFor(() => expect(task.writes).toHaveLength(1));
  expect(task.writes[0].body.connection).toMatchObject({ host: "b.example" });
  expect(task.writes[0].body.connection.username).toBeFalsy();
  expect(task.writes[0].body.connection.password).toBeFalsy();
});
