// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { WorkspaceFrame } from "./ui-patterns/workspace-frame";

afterEach(cleanup);

it("keeps a single task and expanded context mounted when entering a contained view", () => {
  function Task() {
    const [draft, setDraft] = useState("");
    return (
      <input
        aria-label="Task draft"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    );
  }
  const page = (contained: boolean) => (
    <WorkspaceFrame
      contentKind="list"
      contextKind="data"
      contained={contained}
      header={<h1>Subscriptions</h1>}
      context={
        <details>
          <summary>Usage details</summary>
          <p>Known usage</p>
        </details>
      }
    >
      <Task />
    </WorkspaceFrame>
  );
  const { rerender } = render(page(false));
  const field = screen.getByRole("textbox", { name: "Task draft" });
  fireEvent.change(field, { target: { value: "Unsubmitted" } });
  const disclosure = screen.getByText("Usage details").closest("details")!;
  disclosure.open = true;
  field.focus();
  rerender(page(true));
  expect(screen.getByRole("textbox", { name: "Task draft" })).toBe(field);
  expect(field).toHaveProperty("value", "Unsubmitted");
  expect(document.activeElement).toBe(field);
  expect(screen.getAllByText("Known usage")).toHaveLength(1);
  expect(screen.getByText("Usage details").closest("details")).toBe(disclosure);
  expect(disclosure.open).toBe(true);
});
