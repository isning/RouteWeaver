// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import { TaskDialog, TaskSheet } from "./ui-patterns/task-overlays";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  "keeps short task header, fields and decision in one sequential scroller (sheet=%s)",
  async (sheet) => {
    const Task = sheet ? TaskSheet : TaskDialog;
    render(
      <Task
        open
        onOpenChange={() => {}}
        title="导入来源"
        scrollMode="task"
        footer={<button>确认导入</button>}
      >
        <label>
          来源地址
          <input />
        </label>
      </Task>,
    );
    const dialog = screen.getByRole("dialog");
    const header = dialog.querySelector<HTMLElement>(
      "[data-task-overlay-header]",
    )!;
    const body = dialog.querySelector<HTMLElement>("[data-task-overlay-body]")!;
    const footer = dialog.querySelector<HTMLElement>(
      "[data-task-overlay-footer]",
    )!;
    expect(
      header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    const style = document.createElement("style");
    style.textContent = (
      await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")
    ).build([...dialog.classList, ...body.classList]);
    document.head.append(style);
    try {
      expect(getComputedStyle(dialog).overflowY).toBe("auto");
      expect(getComputedStyle(body).overflow).toBe("visible");
      expect(getComputedStyle(body).flex).toBe("0 0 auto");
    } finally {
      style.remove();
    }
  },
);

it.each([false, true])(
  "adapts to tall consent chrome without measuring its own shrinking body (sheet=%s)",
  async (sheet) => {
    let viewport = 900;
    let footerHeight = 200;
    const measurements: ResizeObserverCallback[] = [];
    vi.spyOn(window, "innerHeight", "get").mockImplementation(() => viewport);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          measurements.push(callback);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-task-overlay-header")
          ? 60
          : this.hasAttribute("data-task-overlay-footer")
            ? footerHeight
            : 0;
      },
    );
    const Task = sheet ? TaskSheet : TaskDialog;
    const resize = async () =>
      act(() => {
        window.dispatchEvent(new Event("resize"));
        for (const callback of measurements) callback([], {} as ResizeObserver);
      });
    render(
      <Task
        open
        onOpenChange={() => {}}
        title="检查订阅更新"
        scrollMode="auto"
        footer={
          <div>
            <p>{"Long synthetic output name ".repeat(8)}</p>
            <p>发布后请下载配置与规则文件包并导入客户端。</p>
            <button>确认更新</button>
          </div>
        }
      >
        <p>可滚动的发布证据</p>
      </Task>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-task-scroll")).toBe("body");
    viewport = 400;
    await resize();
    expect(dialog.getAttribute("data-task-scroll")).toBe("task");
    const body = dialog.querySelector<HTMLElement>("[data-task-overlay-body]")!;
    const style = document.createElement("style");
    style.textContent = (
      await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")
    ).build([...dialog.classList, ...body.classList]);
    document.head.append(style);
    try {
      expect(getComputedStyle(dialog).overflowY).toBe("auto");
      expect(getComputedStyle(body).overflow).toBe("visible");
      expect(getComputedStyle(body).flex).toBe("0 0 auto");
    } finally {
      style.remove();
    }
    // The same chrome remains insufficient after switching modes; repeated
    // observer notifications must not alternate modes based on body shrinkage.
    await resize();
    await resize();
    expect(dialog.getAttribute("data-task-scroll")).toBe("task");
    viewport = 900;
    footerHeight = 700;
    await resize();
    expect(dialog.getAttribute("data-task-scroll")).toBe("task");
    footerHeight = 200;
    await resize();
    expect(dialog.getAttribute("data-task-scroll")).toBe("body");
    viewport = 600;
    dialog.style.fontSize = "28px";
    await resize();
    expect(dialog.getAttribute("data-task-scroll")).toBe("task");
    dialog.style.fontSize = "14px";
    await resize();
    expect(dialog.getAttribute("data-task-scroll")).toBe("body");
    expect(
      screen
        .getByRole("button", { name: "确认更新" })
        .closest("[data-task-overlay-footer]"),
    ).not.toBeNull();
  },
);
