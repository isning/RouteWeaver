// @vitest-environment jsdom
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionsPage } from "./Sources";
import { UIProviders } from "./ui-patterns/providers";
import type { Collection } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const recipe: Collection = {
  id: "travel",
  name: "Travel",
  revisionToken: "r1",
  sources: [],
  steps: [
    {
      id: "keep-office",
      kind: "keep",
      enabled: false,
      filter: { namePattern: "Office", region: "HK", tags: ["remote"] },
    },
  ],
};
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
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    client?.clear();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retries a failed preview by keyboard with the stopped filter intact, then saves only on explicit activation", async () => {
  const previews: Collection[] = [],
    saves: Collection[] = [];
  const saveRevisions: (string | null)[] = [];
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      if (path === "/me/collections/preview" && init?.method === "POST") {
        previews.push(JSON.parse(String(init.body)));
        return previews.length === 1 ? held : json({ endpoints: [] });
      }
      if (path === "/me/collections/travel" && init?.method === "PUT") {
        saves.push(JSON.parse(String(init.body)));
        saveRevisions.push(new Headers(init.headers).get("If-Match"));
        return json({ ...saves.at(-1), revisionToken: "r2" });
      }
      if (!init?.method && path === "/me/collections") return json([recipe]);
      if (!init?.method && path === "/me/sources") return json([]);
      throw new Error(
        `Unexpected HTTP operation ${init?.method ?? "GET"} ${path}`,
      );
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <CollectionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  try {
    await user.click(
      await screen.findByRole("button", { name: /^Travel.*编辑集合/ }),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "Travel" }),
    );
    await user.clear(editor.getByLabelText("集合名称"));
    await user.type(editor.getByLabelText("集合名称"), "Local preview");
    await user.click(editor.getByRole("combobox", { name: /包含标签/ }));
    await user.keyboard("backup{Enter}{Escape}");
    const preview = editor.getByRole("button", { name: "预览处理结果" });
    await user.click(preview);
    await waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("true"));
    expect(saves).toEqual([]);
    await act(async () => {
      release(json({ message: "Preview unavailable" }, 503));
    });
    await editor.findByText("Preview unavailable");
    expect(editor.getByLabelText("集合名称")).toHaveProperty(
      "value",
      "Local preview",
    );
    expect(
      editor.getByLabelText("启用步骤 1").getAttribute("aria-checked"),
    ).toBe("false");
    expect(editor.getByLabelText("名称正则")).toHaveProperty("value", "Office");
    expect(editor.getByLabelText("地区")).toHaveProperty("value", "HK");
    // Actual keyboard continuation, no forced focus. Native blur/layout needs browser evidence.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(previews).toHaveLength(2));
    expect(previews[1]).toEqual({
      id: "travel",
      name: "Local preview",
      sources: [],
      steps: [
        {
          id: "keep-office",
          kind: "keep",
          enabled: false,
          filter: {
            namePattern: "Office",
            region: "HK",
            tags: ["remote", "backup"],
          },
        },
      ],
    });
    expect(previews[1]).toEqual(previews[0]);
    await waitFor(() =>
      expect(preview.getAttribute("aria-busy")).toBe("false"),
    );
    expect(editor.queryByText("Preview unavailable")).toBeNull();
    expect(
      await editor.findByRole("heading", { name: "逐阶段预览" }),
    ).toBeTruthy();
    expect(saves).toEqual([]);
    await user.click(editor.getByRole("button", { name: "保存集合" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saves).toEqual([previews[1]]);
    expect(saveRevisions).toEqual(["r1"]);
  } finally {
    release(json({ endpoints: [] }));
  }
});
