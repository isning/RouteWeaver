// @vitest-environment jsdom
// Public rendered UI and controlled HTTP boundary only. No browser geometry claim.
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
import { ResourcesPage } from "./Resources";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";
import type { RuleResource } from "./types";

const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  // Ant's test-only constant IDs collide between the force-rendered reference
  // modal and the import modal; exercise normal per-instance label identity.
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#resources");
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
function mount(
  pending = false,
  workspace = false,
  resources: RuleResource[] = [],
) {
  const writes: { url: string; values: Record<string, unknown> }[] = [];
  let resourceReads = 0;
  let release: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/auth/me")
        return json({
          user: { id: "resource-user", name: "Resource user", role: "user" },
          csrfToken: "resource-csrf",
        });
      if (["/api/me/sources", "/api/me/inbox"].includes(input)) return json([]);
      if (
        input === "/api/me/resources" &&
        (!init?.method || init.method === "GET")
      ) {
        resourceReads++;
        return json(resources);
      }
      if (
        (init?.method === "POST" &&
          ["/api/me/resources", "/api/me/resources/import"].includes(input)) ||
        (init?.method === "PUT" &&
          resources.some(
            (resource) => input === `/api/me/resources/${resource.id}`,
          ))
      ) {
        const values = JSON.parse(String(init.body));
        writes.push({ url: input, values });
        if (pending)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return json(values, 201);
      }
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${input}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>{workspace ? <Workspace /> : <ResourcesPage />}</UIProviders>
    </QueryClientProvider>,
  );
  return {
    writes,
    get resourceReads() {
      return resourceReads;
    },
    release: (response?: Response) =>
      release?.(response || json(writes[writes.length - 1]?.values, 201)),
  };
}
async function open(kind: "file" | "reference") {
  await screen.findByText("暂无规则资源");
  await userEvent.click(
    screen.getAllByRole("button", {
      name: kind === "file" ? "导入规则文件" : "添加公开引用",
    })[0],
  );
  const title = kind === "file" ? "导入规则文件" : "添加公开规则引用";
  const dialog = await screen.findByRole("dialog", { name: title });
  const name = within(dialog).getByRole("textbox", {
    name: kind === "file" ? "导入资源名称" : "资源名称",
  });
  fireEvent.change(name, { target: { value: "Unsaved private rules" } });
  await userEvent.click(name);
  return { dialog, title, name };
}
async function completeInputs(dialog: HTMLElement, kind: "file" | "reference") {
  if (kind === "file") {
    await userEvent.upload(
      within(dialog).getByLabelText("选择规则文件"),
      new File(["payload:\n  - example.test\n"], "private.yaml", {
        type: "text/yaml",
      }),
    );
  } else {
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "规则文件 URL" }),
      { target: { value: "https://example.test/rules.yaml" } },
    );
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "SHA-256 校验值" }),
      { target: { value: "a".repeat(64) } },
    );
  }
}
it.each(["file", "reference"] as const)(
  "keeps %s edits on Escape until explicit discard",
  async (kind) => {
    const state = mount();
    const { dialog, title, name } = await open(kind);
    await userEvent.keyboard("{Escape}");
    expect(dialog.isConnected).toBe(true);
    const review = await screen.findByRole("alertdialog", { name: /放弃/ });
    await userEvent.click(
      within(review).getByRole("button", { name: "继续编辑" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: /放弃/ })).toBeNull(),
    );
    expect((name as HTMLInputElement).value).toBe("Unsaved private rules");
    expect(dialog.isConnected).toBe(true);
    expect(state.writes).toHaveLength(0);
  },
);
it("keeps public-reference edits on Cancel until explicit discard", async () => {
  const state = mount();
  const { title, dialog, name } = await open("reference");
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^取\s*消$/ }),
  );
  expect(dialog.isConnected).toBe(true);
  const review = await screen.findByRole("alertdialog", { name: /放弃/ });
  await userEvent.click(
    within(review).getByRole("button", { name: "继续编辑" }),
  );
  expect((name as HTMLInputElement).value).toBe("Unsaved private rules");
  expect(state.writes).toHaveLength(0);
});
it.each(["file", "reference"] as const)(
  "keeps the current %s editor while its save is pending",
  async (kind) => {
    const state = mount(true);
    const { dialog, title } = await open(kind);
    await completeInputs(dialog, kind);
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: kind === "file" ? "导入并保存文件" : "保存公开引用",
      }),
    );
    await waitFor(() => expect(state.writes).toHaveLength(1));
    await userEvent.keyboard("{Escape}");
    expect(dialog.isConnected).toBe(true);
    expect(state.writes).toHaveLength(1);
    state.release();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: title, hidden: true }),
      ).toBeNull(),
    );
  },
);
it.each(["file", "reference"] as const)(
  "closes unchanged and reverted %s values without a discard prompt",
  async (kind) => {
    const state = mount();
    const { name, title } = await open(kind);
    fireEvent.change(name, { target: { value: "" } });
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: title, hidden: true }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("alertdialog", { name: /放弃/ })).toBeNull();
    await userEvent.click(
      screen.getAllByRole("button", {
        name: kind === "file" ? "导入规则文件" : "添加公开引用",
      })[0],
    );
    const clean = await screen.findByRole("dialog", { name: title });
    await userEvent.click(
      within(clean).getByRole("button", { name: /^取\s*消$/ }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: title, hidden: true }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("alertdialog", { name: /放弃/ })).toBeNull();
    expect(state.writes).toHaveLength(0);
  },
);
it.each(["file", "reference"] as const)(
  "discards %s edits only after explicit confirmation and reopens cleanly",
  async (kind) => {
    const state = mount();
    const { title } = await open(kind);
    await userEvent.keyboard("{Escape}");
    const review = await screen.findByRole("alertdialog", { name: /放弃/ });
    await userEvent.click(
      within(review).getByRole("button", { name: "放弃修改" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: title, hidden: true }),
      ).toBeNull(),
    );
    await userEvent.click(
      screen.getAllByRole("button", {
        name: kind === "file" ? "导入规则文件" : "添加公开引用",
      })[0],
    );
    const next = await screen.findByRole("dialog", { name: title });
    expect(
      (
        within(next).getByRole("textbox", {
          name: kind === "file" ? "导入资源名称" : "资源名称",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(state.writes).toHaveLength(0);
  },
);
it("retains the selected file through continue-editing and failed import, then retries the exact input", async () => {
  const state = mount(true);
  const { dialog, title } = await open("file");
  await completeInputs(dialog, "file");
  const input = within(dialog).getByLabelText(
    "选择规则文件",
  ) as HTMLInputElement;
  const selected = input.files![0];
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^取\s*消$/ }),
  );
  const review = await screen.findByRole("alertdialog", { name: /放弃/ });
  await userEvent.click(
    within(review).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog", { name: /放弃/ })).toBeNull(),
  );
  expect(input.files![0]).toBe(selected);
  const submit = within(dialog).getByRole("button", { name: "导入并保存文件" });
  await userEvent.click(submit);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  state.release(json({ error: "rule import unavailable" }, 503));
  await screen.findByText("rule import unavailable");
  expect(input.files![0]).toBe(selected);
  await userEvent.click(submit);
  await waitFor(() => expect(state.writes).toHaveLength(2));
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(atob(String(state.writes[1].values.contentBase64))).toBe(
    "payload:\n  - example.test\n",
  );
  state.release();
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: title, hidden: true }),
    ).toBeNull(),
  );
});
it.each(["file", "reference"] as const)(
  "does not let an older %s save dismiss a later task after explicit departure",
  async (kind) => {
    const state = mount(true, true);
    await screen.findByRole("main");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const { dialog } = await open(kind);
    await completeInputs(dialog, kind);
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: kind === "file" ? "导入并保存文件" : "保存公开引用",
      }),
    );
    await waitFor(() => expect(state.writes).toHaveLength(1));
    const submitted = structuredClone(state.writes[0]);
    const payload =
      kind === "file"
        ? (submitted.values.resource as Record<string, unknown>)
        : submitted.values;
    expect(payload.name).toBe("Unsaved private rules");
    expect(payload.format).toBe("mihomo-yaml");
    if (kind === "reference") {
      expect(payload.url).toBe("https://example.test/rules.yaml");
      expect(payload.digest).toBe("a".repeat(64));
    }
    await act(async () => {
      location.hash = "#sources";
    });
    const review = await screen.findByRole("alertdialog", {
      name: "放弃未保存的修改？",
    });
    await userEvent.click(
      within(review).getByRole("button", { name: "放弃修改并离开" }),
    );
    await screen.findByRole("heading", { name: "订阅来源", level: 1 });
    await act(async () => {
      location.hash = "#resources";
    });
    const next = await open(kind);
    fireEvent.change(next.name, { target: { value: "Newer private rules" } });
    const reads = state.resourceReads;
    await act(async () => {
      state.release();
    });
    await waitFor(() => expect(state.resourceReads).toBeGreaterThan(reads));
    expect(screen.getByRole("dialog", { name: next.title })).toBe(next.dialog);
    expect((next.name as HTMLInputElement).value).toBe("Newer private rules");
    expect(state.writes).toEqual([submitted]);
    expect(
      screen.queryByText(
        kind === "file"
          ? "规则文件已接纳，发布配置时会一并打包"
          : "规则资源已保存",
      ),
    ).toBeNull();
  },
);
it("treats a selected file as unsaved even when no text field changed", async () => {
  mount();
  const { dialog, name } = await open("file");
  fireEvent.change(name, { target: { value: "" } });
  await completeInputs(dialog, "file");
  const input = within(dialog).getByLabelText(
    "选择规则文件",
  ) as HTMLInputElement;
  const selected = input.files![0];
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^取\s*消$/ }),
  );
  const review = await screen.findByRole("alertdialog", { name: /放弃/ });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(review.isConnected).toBe(false));
  expect(input.files![0]).toBe(selected);
});
it("protects an import-mode change but permits returning to the unchanged mode", async () => {
  mount();
  const { dialog, name, title } = await open("file");
  fireEvent.change(name, { target: { value: "" } });
  const mode = within(dialog).getByRole("combobox", {
    name: "规则文件导入方式",
  });
  await userEvent.click(mode);
  await userEvent.click(screen.getByText("读取 HTTPS 文件并接纳"));
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^取\s*消$/ }),
  );
  const review = await screen.findByRole("alertdialog", { name: /放弃/ });
  await userEvent.click(
    within(review).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() => expect(review.isConnected).toBe(false));
  await userEvent.click(mode);
  await userEvent.click(screen.getByText("上传本地文件"));
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^取\s*消$/ }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: title, hidden: true }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("alertdialog", { name: /放弃/ })).toBeNull();
});

it("retains a failed public-reference draft and retries its exact submitted values", async () => {
  const state = mount(true);
  const { dialog, name, title } = await open("reference");
  await completeInputs(dialog, "reference");
  const submit = within(dialog).getByRole("button", { name: "保存公开引用" });
  await userEvent.click(submit);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  state.release(json({ error: "reference save unavailable" }, 503));
  await screen.findByText("reference save unavailable");
  expect((name as HTMLInputElement).value).toBe("Unsaved private rules");
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "规则文件 URL",
      }) as HTMLInputElement
    ).value,
  ).toBe("https://example.test/rules.yaml");
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "SHA-256 校验值",
      }) as HTMLInputElement
    ).value,
  ).toBe("a".repeat(64));
  await userEvent.click(submit);
  await waitFor(() => expect(state.writes).toHaveLength(2));
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.writes[1].values).toMatchObject({
    name: "Unsaved private rules",
    location: "remote",
    visibility: "public",
    url: "https://example.test/rules.yaml",
    digest: "a".repeat(64),
  });
  state.release();
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: title, hidden: true }),
    ).toBeNull(),
  );
});

it("closes an existing unchanged or name-reverted reference without a discard prompt", async () => {
  const resource: RuleResource = {
    id: "existing-reference",
    name: "Existing public rules",
    revision: "7",
    digest: "sha256:" + "b".repeat(64),
    format: "mihomo-yaml",
    behavior: "domain",
    location: "remote",
    url: "https://example.test/existing.yaml",
    updatePolicy: "follow",
    visibility: "public",
    intervalSeconds: 86400,
  };
  const state = mount(false, false, [resource]);
  for (const revert of [false, true]) {
    await userEvent.click(
      await screen.findByRole("button", { name: "Existing public rules" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "编辑公开规则引用",
    });
    if (revert) {
      const name = within(dialog).getByRole("textbox", { name: "资源名称" });
      fireEvent.change(name, { target: { value: "Temporary name" } });
      fireEvent.change(name, { target: { value: "Existing public rules" } });
    }
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^取\s*消$/ }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "编辑公开规则引用" }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("alertdialog", { name: /放弃/ })).toBeNull();
  }
  expect(state.writes).toHaveLength(0);
});
