// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { WorkspaceFrame } from "./ui-patterns/workspace-frame";
import { RouteContent } from "./ui-patterns/route-content";
import { routeContentKind } from "./ui-patterns/content-width";
import { PageSkeleton } from "./ui-patterns/loading-state";

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

it("keeps a focused draft mounted when route width policies change", () => {
  const page = (route: string) => <RouteContent page={route}><input aria-label="Route draft" defaultValue="" /></RouteContent>;
  const { rerender } = render(page("subscriptions"));
  const field = screen.getByRole("textbox", { name: "Route draft" });
  fireEvent.change(field, { target: { value: "Retained draft" } });
  field.focus();
  for (const route of ["profiles", "outputs", "subscriptions"]) {
    rerender(page(route));
    expect(screen.getByRole("textbox", { name: "Route draft" })).toBe(field);
    expect(field).toHaveProperty("value", "Retained draft");
    expect(document.activeElement).toBe(field);
  }
});

it("gives every route a task width without capping independent context panes", () => {
  for (const route of ["subscriptions", "profiles", "outputs", "settings", "account-security"]) expect(routeContentKind(route)).toBe("frame");
  for (const route of ["fleet", "routes", "legacy-routes"]) expect(routeContentKind(route)).toBe("workspace");
  for (const route of ["published-routes", "notifications", "inbox", "templates", "sources", "collections", "resources", "nodes", "users", "services", "activity", "servers"]) expect(routeContentKind(route)).toBe("list");
});

it("uses the same workspace presentation while alias routes are loading", () => {
  for (const route of ["subscriptions", "profiles", "outputs", "settings"]) {
    const { container, unmount } = render(<PageSkeleton page={route} />);
    const frame = container.querySelector(".workspace-frame")!;
    expect(frame.getAttribute("data-presentation")).toBe(["profiles", "outputs"].includes(route) ? "contained" : "workspace");
    expect(frame.querySelectorAll(".workspace-context")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "正在打开页面" }).getAttribute("aria-busy")).toBe("true");
    unmount();
  }
});

it("leaves nested context canvases fluid while preserving the existing draft owner", () => {
  const frame = (nested: boolean) => <WorkspaceFrame contentKind="settings" contextKind="navigation" contained nestedContext={nested ? "navigation" : undefined} header={<h1>Settings</h1>}><input aria-label="Nested draft" defaultValue="Unsaved" /></WorkspaceFrame>;
  const { container, rerender } = render(frame(false));
  const field = screen.getByRole("textbox", { name: "Nested draft" });
  field.focus();
  rerender(frame(true));
  expect(screen.getByRole("textbox", { name: "Nested draft" })).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(field).toHaveProperty("value", "Unsaved");
  expect(container.querySelector(".workspace-canvas > .workspace-content")?.className).not.toContain("max-w-");
  expect(container.querySelector(".workspace-header .context-heading")?.className).toContain("max-w-[52rem]");
});
