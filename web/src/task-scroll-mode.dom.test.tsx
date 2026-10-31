// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import { TaskDialog, TaskSheet } from "./ui-patterns/task-overlays";

afterEach(cleanup);
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
