// @vitest-environment jsdom
// Focus ownership through the public resource task; browser geometry is separate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { TaskDialog, type TaskOverlayProps } from "./ui-patterns/task-overlays";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResourcesPage } from "./Resources";
import { RuleFileImport } from "./RuleFileImport";

const clients: QueryClient[] = [];
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url === "/api/me/resources" &&
        (!init?.method || init.method === "GET")
      )
        return new Response("[]", {
          headers: { "Content-Type": "application/json" },
        });
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function task(kind: "file" | "reference") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ResourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await screen.findByText("暂无规则资源");
  const opener = screen.getAllByRole("button", {
    name: kind === "file" ? "导入规则文件" : "添加公开引用",
  })[0];
  await userEvent.click(opener);
  const title = kind === "file" ? "导入规则文件" : "添加公开规则引用";
  const dialog = await screen.findByRole("dialog", { name: title });
  const field = within(dialog).getByRole("textbox", {
    name: kind === "file" ? "导入资源名称" : "资源名称",
  });
  fireEvent.change(field, { target: { value: "Keep this draft" } });
  await userEvent.click(field);
  return { opener, dialog, field, title };
}
it.each(["file", "reference"] as const)(
  "retains one busy submit focus owner for the pending %s request and failure",
  async (kind) => {
    let finish: (response: Response) => void = () => {};
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (
          url === "/api/me/resources" &&
          (!init?.method || init.method === "GET")
        )
          return Promise.resolve(
            new Response("[]", {
              headers: { "Content-Type": "application/json" },
            }),
          );
        if (
          init?.method === "POST" &&
          url ===
            (kind === "file" ? "/api/me/resources/import" : "/api/me/resources")
        ) {
          requests.push(String(init.body));
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
      }),
    );
    const t = await task(kind);
    if (kind === "file") {
      await userEvent.upload(
        within(t.dialog).getByLabelText("选择规则文件"),
        new File(["payload:\n  - example.test\n"], "rules.yaml", {
          type: "text/yaml",
        }),
      );
    } else {
      fireEvent.change(within(t.dialog).getByLabelText("规则文件 URL"), {
        target: { value: "https://example.test/rules.yaml" },
      });
      fireEvent.change(within(t.dialog).getByLabelText("SHA-256 校验值"), {
        target: { value: "a".repeat(64) },
      });
    }
    const submit = within(t.dialog).getByRole("button", {
      name: kind === "file" ? "导入并保存文件" : "保存公开引用",
    });
    if (kind === "file")
      await userEvent.click(
        within(t.dialog).getByRole("button", {
          name: "可选：核对预期文件校验值",
        }),
      );
    if (kind === "reference")
      await userEvent.click(
        within(t.dialog).getByRole("button", { name: "稳定引用标识" }),
      );
    const submitFocus = vi.spyOn(submit, "focus");
    // Enter from an input, not just a pointer click on the action, must also
    // leave focus on the task's busy status action before fields disable.
    await userEvent.click(t.field);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(document.activeElement).toBe(submit);
    // Native scrolling is allowed for this synchronous, owned submission.
    // Actual short-screen settled visibility is checked in the browser.
    expect(
      submitFocus.mock.calls.some(([options]) => !options?.preventScroll),
    ).toBe(true);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(
      within(t.dialog).getByRole("button", {
        name: kind === "file" ? "导入并保存文件" : "保存公开引用",
      }),
    ).toBe(submit);
    if (kind === "reference")
      expect(
        (within(t.dialog).getByLabelText("资源标识") as HTMLInputElement)
          .disabled,
      ).toBe(true);
    // Explicit layout seam, not a claim that jsdom animates the disclosure.
    const wrap = t.dialog.querySelector<HTMLElement>(
      "[data-task-overlay-body]",
    )!;
    const content = t.dialog.querySelector<HTMLElement>(
      '[data-slot="accordion-content"]',
    )!;
    const box = (y: number, height: number) => ({
      x: 0,
      y,
      top: y,
      left: 0,
      right: 640,
      bottom: y + height,
      width: 640,
      height,
      toJSON() {
        return {};
      },
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(box(0, 320));
    vi.spyOn(wrap, "clientHeight", "get").mockReturnValue(320);
    vi.spyOn(wrap, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(submit, "getBoundingClientRect").mockReturnValue(box(400, 38));
    const transition = (node: HTMLElement, propertyName = "height") => {
      const event = new Event("transitionend", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: propertyName });
      fireEvent(node, event);
    };
    wrap.scrollTop = 0;
    submitFocus.mockClear();
    transition(content, "opacity");
    transition(t.field);
    expect(wrap.scrollTop).toBe(0);
    transition(content);
    if (kind === "reference") {
      // Its fixed footer is outside the scrolling field area; expanding fields
      // must not scroll the body to chase a control it cannot reveal.
      expect(wrap.contains(submit)).toBe(false);
      expect((submit as HTMLButtonElement).form).toBe(t.field.closest("form"));
      expect(wrap.scrollTop).toBe(0);
    } else expect(wrap.scrollTop).toBe(118);
    expect(submitFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(submit);
    const newer = render(
      <UIProviders>
        <TaskDialog
          open
          onOpenChange={() => {}}
          title="Newer dialog"
          footer={null}
        >
          <button>Newer unrelated focus owner</button>
        </TaskDialog>
      </UIProviders>,
    );
    const other = within(
      await screen.findByRole("dialog", { name: "Newer dialog" }),
    ).getByRole("button", { name: "Newer unrelated focus owner" });
    await userEvent.click(other);
    expect(document.activeElement).toBe(other);
    wrap.scrollTop = 0;
    transition(content);
    expect(wrap.scrollTop).toBe(0);
    expect(document.activeElement).toBe(other);
    newer.unmount();
    submit.focus();
    await userEvent.click(submit);
    await userEvent.keyboard("{Enter}");
    expect(requests).toHaveLength(1);
    finish(
      new Response(JSON.stringify({ detail: "Synthetic save failure" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await within(t.dialog).findByRole("alert");
    await waitFor(() =>
      expect(submit.getAttribute("aria-busy")).not.toBe("true"),
    );
    wrap.scrollTop = 0;
    submitFocus.mockClear();
    transition(content);
    if (kind === "reference") {
      // Its fixed footer is outside the scrolling field area; expanding fields
      // must not scroll the body to chase a control it cannot reveal.
      expect(wrap.contains(submit)).toBe(false);
      expect((submit as HTMLButtonElement).form).toBe(t.field.closest("form"));
      expect(wrap.scrollTop).toBe(0);
    } else expect(wrap.scrollTop).toBe(118);
    expect(submitFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(submit);
    expect((t.field as HTMLInputElement).value).toBe("Keep this draft");
  },
);
it.each(["file", "reference"] as const)(
  "keeps both Tab boundaries in the %s nested discard owner",
  async (kind) => {
    const t = await task(kind);
    await userEvent.keyboard("{Escape}");
    const review = await screen.findByRole("alertdialog", {
      name: /放弃未保存的规则/,
    });
    // Only the rendered-box seam is supplied in jsdom. Native browser Tab and
    // document focus are verified separately at narrow/short viewports.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const shown = !this.closest('[hidden], [aria-hidden="true"]');
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: shown ? 100 : 0,
          bottom: shown ? 40 : 0,
          width: shown ? 100 : 0,
          height: shown ? 40 : 0,
          toJSON() {
            return {};
          },
        };
      },
    );
    const cancel = within(review).getByRole("button", { name: "继续编辑" });
    const discard = within(review).getByRole("button", { name: "放弃修改" });
    // Focus through the public DOM without activating the destructive action.
    expect(t.dialog.isConnected).toBe(true);
    discard.focus();
    expect(fireEvent.keyDown(discard, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(cancel);
    expect(fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true })).toBe(
      false,
    );
    expect(document.activeElement).toBe(discard);
  },
);
it.each(["file", "reference"] as const)(
  "returns to the same %s field after canceling nested discard",
  async (kind) => {
    const t = await task(kind);
    await userEvent.keyboard("{Escape}");
    const review = await screen.findByRole("alertdialog", {
      name: /放弃未保存的规则/,
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(review.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(t.field));
    expect(t.dialog.isConnected).toBe(true);
    expect((t.field as HTMLInputElement).value).toBe("Keep this draft");
  },
);

it.each(["discard", "save"] as const)(
  "releases the import departure guard before its %s close callback",
  async (outcome) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    const departureChecks: boolean[] = [];
    if (outcome === "save")
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/me/resources/import" && init?.method === "POST")
            return new Response(
              JSON.stringify({ id: "accepted-file", acceptedVersion: "v1" }),
              { status: 201, headers: { "Content-Type": "application/json" } },
            );
          throw new Error(
            `Unexpected request: ${init?.method || "GET"} ${url}`,
          );
        }),
      );
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <RuleFileImport
            onClose={() => {
              const departure = new Event("beforeunload", {
                cancelable: true,
              });
              window.dispatchEvent(departure);
              departureChecks.push(departure.defaultPrevented);
            }}
          />
        </UIProviders>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "导入资源名称" }), {
      target: { value: "Completed file task" },
    });
    if (outcome === "save") {
      await userEvent.upload(
        screen.getByLabelText("选择规则文件"),
        new File(["payload:\n  - example.test\n"], "rules.yaml", {
          type: "text/yaml",
        }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "导入并保存文件" }),
      );
    } else {
      await userEvent.click(screen.getByRole("button", { name: /^取\s*消$/ }));
      const review = await screen.findByRole("alertdialog", {
        name: /放弃未保存的规则/,
      });
      await userEvent.click(
        within(review).getByRole("button", { name: "放弃修改" }),
      );
    }
    await waitFor(() => expect(departureChecks).toHaveLength(1));
    expect(departureChecks).toEqual([false]);
  },
);
it.each(["file", "reference"] as const)(
  "returns to the %s opener after explicit nested discard",
  async (kind) => {
    const t = await task(kind);
    await userEvent.keyboard("{Escape}");
    const review = await screen.findByRole("alertdialog", {
      name: /放弃未保存的规则/,
    });
    await userEvent.click(
      within(review).getByRole("button", { name: "放弃修改" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: t.title })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(t.opener));
  },
);
