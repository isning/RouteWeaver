import { createElement, type ReactElement } from "react";
import { waitFor, type RenderResult } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import { SessionBoundary } from "../SessionBoundary";
import { FleetPlanForm } from "../Fleet";

// Exercise the real authentication boundary. Only auth/me is served here;
// every business request still reaches the individual test's fetch handler.
export async function renderFleetSession(
  node: ReactElement,
  renderContent: (content: ReactElement) => RenderResult,
  options: { force?: boolean } = {},
): Promise<RenderResult> {
  if (!options.force && node.type !== FleetPlanForm) return renderContent(node);
  const businessFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input instanceof Request ? input.url : String(input);
    if (path === "/api/auth/me") {
      return Promise.resolve(new Response(JSON.stringify({
        user: { id: "fleet-test-admin", name: "Fleet test admin", role: "admin" },
        csrfToken: "synthetic-fleet-csrf",
      }), { headers: { "Content-Type": "application/json" } }));
    }
    return businessFetch(input, init);
  });
  const view = renderContent(createElement(SessionBoundary, {
    children: node,
    login: () => createElement("p", null, "Test session unavailable"),
  }));
  await waitFor(() => {
    const workspace = view.container.querySelector<HTMLElement>("[data-session-workspace]");
    if (!workspace || workspace.hidden || workspace.hasAttribute("inert") || workspace.getAttribute("aria-busy") !== "false") {
      throw new Error("Waiting for the verified Fleet workspace");
    }
  });
  return view;
}

beforeEach(() => sessionStorage.clear());
