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
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TemplatesPage } from "./Templates";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
const templates = [
  {
    id: "alpha",
    name: "Template Alpha",
    kind: "processing-preset",
    version: 2,
    spec: { steps: [] },
  },
  {
    id: "beta",
    name: "Template Beta",
    kind: "processing-preset",
    version: 2,
    spec: { steps: [] },
  },
];
const collection = {
  id: "collection",
  name: "My collection",
  sources: [],
  pipeline: [],
};
function mount(
  write?: (url: string, body: any) => Promise<Response>,
  admin = false,
  workspace = false,
) {
  let templateReads = 0;
  const writes: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push({ url, body });
        if (write) return write(url, body);
        return json({});
      }
      if (url === "/api/auth/me")
        return json({
          user: { id: "member", name: "Member", role: "user" },
          csrfToken: "member-csrf",
        });
      if (url === "/api/templates") {
        templateReads++;
        return json(templates);
      }
      if (url.match(/\/templates\/[^/]+\/versions$/))
        return json([
          templates.find((t) => url.includes(t.id)),
          { ...templates.find((t) => url.includes(t.id)), version: 1 },
        ]);
      if (url === "/api/me/collections") return json([collection]);
      if (url === "/api/me/template-bindings")
        return json([
          {
            id: "binding",
            templateId: "alpha",
            targetKind: "collections",
            targetId: collection.id,
            mode: "pinned",
            appliedVersion: 1,
            bindings: {},
          },
        ]);
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {workspace ? <Workspace /> : <TemplatesPage admin={admin} />}
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    writes,
    client,
    get templateReads() {
      return templateReads;
    },
  };
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#templates");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function openTemplate(name = "Template Alpha") {
  const article = (await screen.findByText(name)).closest("article")!;
  await userEvent.click(
    within(article).getByRole("button", { name: "查看并使用" }),
  );
  return screen.findByRole("dialog", { name });
}
async function chooseTarget(dialog: HTMLElement) {
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "模板目标" }),
  );
  await userEvent.click(await screen.findByText("My collection"));
}

it("keeps exact visible field names independent of selected template values and decorative chevrons", async () => {
  const { writes } = mount(undefined, true);
  await userEvent.click(
    await screen.findByRole("button", { name: "发布模板" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  const position = within(dialog).getByRole("combobox", { name: "发布位置" });
  const kind = within(dialog).getByRole("combobox", { name: "模板类型" });
  const target = within(dialog).getByRole("combobox", {
    name: "从自己的已保存配置提取",
  });
  await userEvent.click(kind);
  await userEvent.click(await screen.findByText("客户端配置模板"));
  expect(within(dialog).getByRole("combobox", { name: "模板类型" })).toBe(kind);
  await userEvent.click(position);
  await userEvent.click(await screen.findByRole("option", { name: "Template Alpha v2" }));
  expect(within(dialog).getByRole("combobox", { name: "发布位置" })).toBe(
    position,
  );
  expect(within(dialog).getByRole("combobox", { name: "模板类型" })).toBe(kind);
  await userEvent.click(target);
  await userEvent.click(await screen.findByText("My collection"));
  expect(
    within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" }),
  ).toBe(target);
  expect(writes).toEqual([]);
});

it.each(["selection", "pinned", "publication"] as const)("finds the displayed template version in the %s picker", async (task) => {
  const { writes } = mount(async () => json({
    compatible: true, hasUpdate: false, currentVersion: 1, candidateVersion: 1,
    previewDigest: "synthetic-review", diagnostics: [], changes: [], preservedLocalEdits: [], artifacts: [],
  }), task === "publication");
  let picker: HTMLElement;
  let query: string;
  if (task === "selection") {
    const dialog = await openTemplate();
    picker = within(dialog).getByRole("combobox", { name: "模板版本" });
    query = "v1";
  } else if (task === "pinned") {
    await userEvent.click(await screen.findByRole("tab", { name: "我的引用" }));
    await userEvent.click(await screen.findByRole("button", { name: "查看固定版本 My collection" }));
    const dialog = await screen.findByRole("dialog", { name: "模板更新 My collection" });
    picker = within(dialog).getByLabelText("检查的模板版本");
    query = "v2";
  } else {
    await userEvent.click(await screen.findByRole("button", { name: "发布模板" }));
    const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
    picker = within(dialog).getByRole("combobox", { name: "发布位置" });
    query = "Template Alpha v2";
  }
  await userEvent.click(picker);
  // Confirm the actual choice exists before searching. Search its rendered text,
  // not a hidden numeric value or the spaced React-child representation.
  await screen.findByRole("option", { name: new RegExp(`^${query}(?:\\s|$)`) });
  await userEvent.type(screen.getByRole("combobox", { name: "搜索选项" }), query);
  const match = await screen.findByRole("option", { name: new RegExp(`^${query}(?:\\s|$)`) });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await userEvent.click(match);
  await waitFor(() => expect(picker.getAttribute("aria-expanded")).toBe("false"));
  expect(picker.textContent).toContain(query);
  expect(writes.filter(write => !write.url.endsWith("/preview"))).toEqual([]);
});
