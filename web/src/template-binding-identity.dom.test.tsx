// @vitest-environment jsdom
// Staged only: association coverage, not evidence of browser layout or focus paint.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TemplatesPage } from "./Templates";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  });
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    computed(element),
  );
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cases = [
  ["profiles", "follow"],
  ["profiles", "pinned"],
  ["collections", "follow"],
  ["collections", "pinned"],
] as const;

it.each(cases)(
  "keeps %s/%s row identity through dismissal, review and explicit apply",
  async (kind, mode) => {
    const rows = cases.map(([targetKind, rowMode], index) => ({
      id: `binding-${index}`,
      targetId: `target-${index}`,
      targetKind,
      mode: rowMode,
      templateId: targetKind,
      appliedVersion: 1,
      name: `SharedLongUnbrokenTargetPrefixForRecognition-${index === 0 ? "Alpha" : index === 1 ? "Beta" : index === 2 ? "Gamma" : "Delta"}`,
      bindings: { endpoints: {}, resources: {} },
      updatedAt: "2026-10-24T00:00:00Z",
    }));
    const selected = rows.find(
      (row) => row.targetKind === kind && row.mode === mode,
    )!;
    const other = rows.find(
      (row) => row.targetKind === kind && row.mode !== mode,
    )!;
    const templates = ["profiles", "collections"].map((targetKind) => ({
      id: targetKind,
      name: "同名模板",
      kind: targetKind === "profiles" ? "client-profile" : "processing-preset",
      version: 2,
      spec: { steps: [], endpointSlots: [], resourceSlots: [] },
    }));
    const writes: { url: string; body: Record<string, unknown> }[] = [];
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
          const body = JSON.parse(init.body);
          writes.push({ url, body });
          const row = rows.find(
            (row) =>
              url === `/api/me/template-bindings/${row.id}/preview` ||
              url === `/api/me/template-bindings/${row.id}/apply`,
          );
          if (!row) throw new Error(`Unexpected mutation: ${url}`);
          if (url.endsWith("/apply")) return json({ binding: row });
          return json({
            currentVersion: 1,
            candidateVersion: body.version,
            hasUpdate: body.version === 2,
            compatible: true,
            previewDigest: `digest-${row.id}-${body.version}`,
            diagnostics: [],
            changes: [],
            preservedLocalEdits: [],
            artifacts: [],
            nativeChecked: false,
          });
        }
        if (url === "/api/templates") return json(templates);
        const template = templates.find(
          (template) => url === `/api/templates/${template.id}/versions`,
        );
        if (template) return json([template, { ...template, version: 1 }]);
        if (url === "/api/me/template-bindings") return json(rows);
        if (url === "/api/me/profiles")
          return json(
            rows
              .filter((row) => row.targetKind === "profiles")
              .map((row) => ({
                id: row.targetId,
                name: row.name,
                sourceIds: [],
                platformEntryIds: [],
                ir: { endpoints: [], resources: [], rules: [], groups: [] },
              })),
          );
        if (url === "/api/me/collections")
          return json(
            rows
              .filter((row) => row.targetKind === "collections")
              .map((row) => ({
                id: row.targetId,
                name: row.name,
                sources: [],
              })),
          );
        if (["/api/me/sources", "/api/me/platform-entries"].includes(url))
          return json([]);
        throw new Error(`Unexpected read: ${url}`);
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <TemplatesPage />
        </UIProviders>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "我的引用" }));
    const action = (row: typeof selected) =>
      within(screen.getByText(row.name).closest("tr")!).getByRole("button", {
        name: row.mode === "follow" ? /检查更新/ : /查看固定版本/,
      });
    await screen.findByText(selected.name);
    expect(action(other).getAttribute("aria-label")).toBe(
      `${other.mode === "follow" ? "检查更新" : "查看固定版本"} ${other.name}`,
    );
    await user.click(action(other));
    await screen.findByText(
      other.mode === "follow" ? "可以更新到 v2" : "当前引用无需更新",
    );
    expect(
      screen.getByRole("dialog", { name: `模板更新 ${other.name}` }),
    ).toBeTruthy();
    const comparison = screen.getByRole("dialog", {
      name: `模板更新 ${other.name}`,
    });
    // Reproduce the browser selector against the real rendered template task.
    const namedCloseActions = within(comparison).getAllByRole("button", {
      name: "关闭",
    });
    expect(namedCloseActions).toHaveLength(2);
    const closeActions = namedCloseActions.filter((button) =>
      /^关闭$/.test(button.textContent || ""),
    );
    expect(closeActions).toHaveLength(1);
    await user.click(closeActions[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action(selected).getAttribute("aria-label")).toBe(
      `${mode === "follow" ? "检查更新" : "查看固定版本"} ${selected.name}`,
    );
    await user.click(action(selected));
    const dialog = await screen.findByRole("dialog", {
      name: `模板更新 ${selected.name}`,
    });
    await screen.findByText(
      mode === "follow" ? "可以更新到 v2" : "当前引用无需更新",
    );
    expect(writes.at(-1)).toEqual({
      url: `/api/me/template-bindings/${selected.id}/preview`,
      body: {
        version: mode === "follow" ? 2 : 1,
        bindings: selected.bindings,
      },
    });
    if (mode === "pinned") {
      const versionInput = within(dialog).getByRole("combobox");
      await user.click(versionInput);
      expect(versionInput.getAttribute("aria-expanded")).toBe("true");
      // Radix owns the popup portal and focus scope; the field's aria-controls
      // identifies its real listbox rather than an AntD virtual proxy.
      const dropdown = document.getElementById(
        versionInput.getAttribute("aria-controls")!,
      );
      expect(dropdown).toBeTruthy();
      expect(within(dropdown!).getByRole("listbox")).toBeTruthy();
      expect(dropdown!.closest("label")).toBeNull();
      await user.click(within(dropdown!).getByRole("option", { name: "v2" }));
      await waitFor(() => expect(versionInput.textContent).toContain("v2"));
      expect(versionInput.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(versionInput);
      const recheck = await within(dialog).findByRole("button", {
        name: "检查此绑定的更新",
      });
      expect(recheck.hasAttribute("disabled")).toBe(false);
      await user.click(recheck);
      await screen.findByText("可以更新到 v2");
    }
    expect(writes.filter((write) => write.url.endsWith("/apply"))).toEqual([]);
    await user.click(
      within(dialog).getByRole("button", { name: "应用到草稿" }),
    );
    await waitFor(() =>
      expect(writes.filter((write) => write.url.endsWith("/apply"))).toEqual([
        {
          url: `/api/me/template-bindings/${selected.id}/apply`,
          body: {
            previewDigest: `digest-${selected.id}-2`,
            version: 2,
            bindings: selected.bindings,
          },
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  },
);
