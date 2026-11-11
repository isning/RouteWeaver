import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page, TestInfo, Response, Request } from "@playwright/test";

export type SetupPhase = "normal-ui-login" | "cold-workspace" | "new-tab";
export type SetupOutcome =
  "confirmed" | "session-error" | "timeout-or-page-error";
type AuthEvent = {
  operation: "login" | "me";
  method: "GET" | "POST" | "other";
  status: number | null;
};
export type SetupDiagnostic =
  | { kind: "http"; phase: SetupPhase; events: AuthEvent[] }
  | {
      kind: "domain";
      worker: number;
      setup: "normal-ui-login" | "reuse-valid-session";
    }
  | {
      kind: "confirmation";
      phase: SetupPhase;
      outcome: SetupOutcome;
      elapsedMs: number;
      timeoutMs: number;
    };
type DiagnosticInfo = Pick<TestInfo, "outputPath" | "attach">;
const counts = new WeakMap<DiagnosticInfo, number>();

// Copy only explicitly allowlisted scalar fields. Never serialize responses,
// requests, errors, headers, bodies, cookies, URLs, or arbitrary caller objects.
export function diagnosticPayload(value: SetupDiagnostic) {
  switch (value.kind) {
    case "http":
      return {
        phase: value.phase,
        count: value.events.length,
        events: value.events.map(({ operation, method, status }) => ({
          operation,
          method,
          status,
        })),
      };
    case "domain":
      return { worker: value.worker, setup: value.setup };
    case "confirmation":
      return {
        setup: value.phase,
        outcome: value.outcome,
        elapsedMs: value.elapsedMs,
        timeoutMs: value.timeoutMs,
      };
  }
}

export async function persistSetupDiagnostic(
  info: DiagnosticInfo,
  value: SetupDiagnostic,
) {
  const count = (counts.get(info) ?? 0) + 1;
  counts.set(info, count);
  const name = value.kind === "http" ? `${value.phase}-http` : value.kind;
  const path = info.outputPath(`session-setup-${name}-${count}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(diagnosticPayload(value)), "utf8");
  await info.attach(`session-setup-${name}`, {
    path,
    contentType: "application/json",
  });
}

export function observeSetupAuth(page: Page) {
  const events: AuthEvent[] = [];
  const record = (url: string, method: string, status: number | null) => {
    const path = new URL(url).pathname;
    if (path !== "/api/auth/login" && path !== "/api/auth/me") return;
    events.push({
      operation: path === "/api/auth/login" ? "login" : "me",
      method: method === "GET" || method === "POST" ? method : "other",
      status,
    });
  };
  const response = (value: Response) => {
    record(value.url(), value.request().method(), value.status());
  };
  // Typed separately because Playwright's overloaded event signatures differ.
  const failed = (value: Request) => record(value.url(), value.method(), null);
  page.on("response", response);
  page.on("requestfailed", failed);
  return {
    stop() {
      page.off("response", response);
      page.off("requestfailed", failed);
      return events;
    },
  };
}
