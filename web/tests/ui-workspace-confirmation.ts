import { test, type Page } from "@playwright/test";
import {
  persistSetupDiagnostic,
  type SetupOutcome,
} from "./ui-session-diagnostics";

// Setup only: SessionLifecycle allows 15s for /auth/me including its body,
// followed by at most 3s of rendering. This is not an interaction timeout.
export const WORKSPACE_SETUP_TIMEOUT_MS = 18_000;

// Self-contained browser predicate, also exercised against real DOM fixtures.
export function workspaceConfirmationState() {
  const visible = (element: Element) => {
    if (element.closest("[hidden],[inert],[aria-hidden='true']")) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility !== "visible" ||
        style.opacity === "0"
      )
        return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  // Only explicit session-recovery errors are terminal here. A normal business
  // alert inside the confirmed workspace is not a failed login.
  const errors = document.querySelectorAll(
    '[role="region"][aria-label="恢复登录"] [role="alert"]',
  );
  if ([...errors].some(visible)) return "session-error" as const;
  const workspaces = [
    ...document.querySelectorAll("[data-session-workspace]"),
  ].filter(
    (workspace) =>
      workspace.getAttribute("aria-busy") === "false" && visible(workspace),
  );
  if (workspaces.length !== 1) return false;
  // Both the new overview default and an explicit subscriptions deep link are
  // valid landing pages. Session confirmation must not depend on old routing.
  const headings = [
    ...workspaces[0].querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'),
  ].filter(
    (heading) =>
      ["概览", "我的订阅"].includes(heading.textContent?.trim() || "") &&
      visible(heading),
  );
  return headings.length === 1 ? ("confirmed" as const) : false;
}

export async function waitForConfirmedWorkspace(
  page: Page,
  setup: "normal-ui-login" | "cold-workspace" | "new-tab" = "cold-workspace",
) {
  const started = Date.now();
  let outcome: SetupOutcome = "timeout-or-page-error";
  try {
    const result = await page.waitForFunction(
      workspaceConfirmationState,
      null,
      {
        timeout: WORKSPACE_SETUP_TIMEOUT_MS,
      },
    );
    try {
      const state = await result.jsonValue();
      if (state === "confirmed" || state === "session-error") outcome = state;
    } finally {
      await result.dispose();
    }
    if (outcome !== "confirmed")
      throw new Error(
        `Workspace setup (${setup}) stopped at an explicit session-recovery error; no retry was attempted.`,
      );
  } finally {
    // No cookie, credentials, response body, business text, or URL is recorded.
    await persistSetupDiagnostic(test.info(), {
      kind: "confirmation",
      phase: setup,
      outcome,
      elapsedMs: Date.now() - started,
      timeoutMs: WORKSPACE_SETUP_TIMEOUT_MS,
    });
  }
}
