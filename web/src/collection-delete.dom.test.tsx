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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { CollectionsPage } from "./Sources";
const collection = {
  id: "collection",
  name: "Shared collection",
  sources: [],
  steps: [],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <CollectionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
}
it("groups a collection's edit and secondary delete actions inside its named card", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => json(
    String(url).endsWith("/collections") ? [collection] : [],
  )));
  mount();
  const card = await screen.findByRole("article", { name: collection.name });
  const edit = within(card).getByRole("button", { name: /Shared collection.*编辑集合/ });
  const remove = within(card).getByRole("button", { name: "删除集合 Shared collection" });
  expect(edit.contains(remove)).toBe(false);
  expect(within(card).getByRole("heading", { name: collection.name })).toBeTruthy();
  expect(remove.textContent).toBe("删除");
  edit.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(remove);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Enter}");
  expect(await screen.findByRole("dialog", { name: collection.name })).toBeTruthy();
});

it("does not enable collection deletion before an authoritative dependency read and names every blocking profile", async () => {
  let release!: (r: Response) => void;
  let reads = 0;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method && init.method !== "GET") {
        writes.push(String(url));
        throw new Error("No deletion allowed");
      }
      if (String(url).endsWith("/dependencies")) {
        if (++reads === 1)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return json({
          collection: { id: collection.id, name: collection.name },
          deletable: false,
          profiles: [
            { id: "p1", name: "First profile" },
            { id: "p2", name: "Second profile" },
          ],
        });
      }
      return json(String(url).endsWith("/collections") ? [collection] : []);
    }),
  );
  mount();
  const opener = await screen.findByRole("button", {
    name: "删除集合 Shared collection",
  });
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", {
    name: "删除集合「Shared collection」？",
  });
  expect(within(dialog).getByLabelText("正在加载")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "删除集合" }),
  ).toHaveProperty("disabled", true);
  await act(async () =>
    release(json({ message: "Dependency read unavailable" }, 503)),
  );
  await within(dialog).findByText("Dependency read unavailable");
  expect(within(dialog).queryByText("没有配置引用此集合。")).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "重试" }));
  await within(dialog).findByText("First profile");
  expect(within(dialog).getByText("Second profile")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "删除集合" }),
  ).toHaveProperty("disabled", true);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(writes).toEqual([]);
});
it("cancels collection deletion twice safely, then preserves failed deletion context and retries without cascading", async () => {
  let deleted = false,
    attempts = 0;
  let release!: (r: Response) => void;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "DELETE") {
        writes.push(path);
        if (++attempts === 1)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        deleted = true;
        return json({ ok: true });
      }
      if (path.endsWith("/dependencies"))
        return json({
          collection: { id: collection.id, name: collection.name },
          deletable: true,
          profiles: [],
        });
      return json(
        path.endsWith("/collections") && !deleted ? [collection] : [],
      );
    }),
  );
  mount();
  const opener = await screen.findByRole("button", {
    name: "删除集合 Shared collection",
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", {
      name: "删除集合「Shared collection」？",
    });
    await within(dialog).findByText("没有配置引用此集合。");
    expect(
      within(dialog).getByText(
        "只删除此集合及其处理步骤，不会删除订阅来源、配置或客户端订阅。此操作无法撤销。",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "保留集合" }),
      ),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(opener));
  }
  expect(writes).toEqual([]);
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", {
    name: "删除集合「Shared collection」？",
  });
  await within(dialog).findByText("没有配置引用此集合。");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "删除集合" }),
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBe(dialog);
  await act(async () =>
    release(json({ message: "Collection deletion unavailable" }, 503)),
  );
  await within(dialog).findByText("Collection deletion unavailable");
  expect(within(dialog).getByRole("heading").textContent).toContain(
    "Shared collection",
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "删除集合" }),
  );
  await screen.findByText("暂无节点集合");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getAllByRole("button", { name: "新建集合" })[0],
    ),
  );
  expect(writes).toEqual([
    "/api/me/collections/collection",
    "/api/me/collections/collection",
  ]);
});

it("keeps the selected collection after a newly added dependency rejects deletion and disables further deletion", async () => {
  let referenced = false;
  let deletes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "DELETE") {
        deletes++;
        referenced = true;
        return json({ message: "集合已被新配置引用，无法删除" }, 409);
      }
      if (path.endsWith("/dependencies"))
        return json({
          collection: { id: collection.id, name: collection.name },
          deletable: !referenced,
          profiles: referenced
            ? [{ id: "new", name: "New dependent profile" }]
            : [],
        });
      return json(path.endsWith("/collections") ? [collection] : []);
    }),
  );
  mount();
  const opener = await screen.findByRole("button", {
    name: "删除集合 Shared collection",
  });
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", {
    name: "删除集合「Shared collection」？",
  });
  await within(dialog).findByText("没有配置引用此集合。");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "删除集合" }),
  );
  await within(dialog).findByText("New dependent profile");
  expect(within(dialog).getByText("集合已被新配置引用，无法删除")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "删除集合" }),
  ).toHaveProperty("disabled", true);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "保留集合" }),
  );
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(deletes).toBe(1);
});
