import { mergeConfig, type Plugin } from "vite";
import base from "../vite.config";

const mode = process.env.ROUTEWEAVER_LOADING_EXPERIMENT_MODE;
if (mode !== "suspense" && mode !== "state") {
  throw new Error("Choose an explicit diagnostic-only loader mode");
}
const virtual = "virtual:routeweaver-loading-experiment";
const resolved = `\0${virtual}`;
function replaceOnce(
  code: string,
  before: string,
  after: string,
  owner: string,
) {
  if (code.split(before).length !== 2) {
    throw new Error(`Diagnostic source anchor changed: ${owner}`);
  }
  return code.replace(before, after);
}

// This virtual module is reachable only through this explicit test build config.
// It records no user content and never changes session/query state.
const probe = `
import { useLayoutEffect } from "react";
export function mark(name, detail) {
  globalThis.__rwLoadingExperiment?.mark(name, detail);
}
export async function settleModule(value) {
  mark("module-loaded");
  await globalThis.__rwLoadingExperiment?.moduleGate;
  mark("module-settled");
  return value;
}
export function MeasuredFallback({ page, children }) {
  useLayoutEffect(() => {
    if (["subscriptions", "profiles", "outputs"].includes(page)) {
      mark("fallback-commit");
      return () => mark("fallback-unmount");
    }
  }, [page]);
  return children;
}

`;
const instrumentation: Plugin = {
  name: "diagnostic-only-loading-probe",
  enforce: "pre",
  resolveId(id) {
    if (id === virtual) return resolved;
  },
  load(id) {
    if (id === resolved) return probe;
  },
  transform(input, id) {
    const path = id.split("?")[0].replaceAll("\\", "/");
    let code = input;
    if (path.endsWith("/src/App.tsx")) {
      code =
        `import { mark as __rwMark, settleModule as __rwSettle, MeasuredFallback } from "${virtual}";\n` +
        code;
      const declaration =
        'import { SubscriptionPageLoader as SubscriptionsPage } from "./SubscriptionPageLoader";';
      const loader = `const __rwLoadSubscriptions = () => {
        __rwMark("module-request");
        return import("./Subscriptions").then(m => __rwSettle({ default: m.SubscriptionsPage }));
      };`;
      code = replaceOnce(
        code,
        declaration,
        mode === "suspense"
          ? loader +
              "\nconst SubscriptionsPage = lazyPage(__rwLoadSubscriptions);"
          : declaration,
        "Subscriptions loader",
      );
      code = replaceOnce(
        code,
        "<PageSkeleton page={page} />",
        "<MeasuredFallback page={page}><PageSkeleton page={page} /></MeasuredFallback>",
        "route fallback",
      );
    } else if (path.endsWith("/src/SubscriptionPageLoader.tsx")) {
      // Candidate B is the actual production loader, not a diagnostic substitute.
      // Instrument only module settlement and the existing placeholder commit.
      code =
        `import { mark as __rwMark, settleModule as __rwSettle, MeasuredFallback } from "${virtual}";\n` +
        code;
      code = replaceOnce(
        code,
        'loadPageModule(() => import("./Subscriptions"))',
        'loadPageModule(() => { __rwMark("module-request"); return import("./Subscriptions").then(__rwSettle); })',
        "candidate module observation",
      );
      code = replaceOnce(
        code,
        "<PageSkeleton",
        '<MeasuredFallback page="subscriptions"><PageSkeleton',
        "candidate fallback start",
      );
      code = replaceOnce(
        code,
        "    />\n  );",
        "    /></MeasuredFallback>\n  );",
        "candidate fallback end",
      );
    } else if (path.endsWith("/src/Subscriptions.tsx")) {
      code = `import { mark as __rwMark } from "${virtual}";\n` + code;
      code = replaceOnce(
        code,
        "  const usageDetailsId = useId();",
        '  useLayoutEffect(() => { __rwMark("page-commit"); }, []);\n  const usageDetailsId = useId();',
        "page commit",
      );
    } else if (path.endsWith("/src/SessionLifecycle.ts")) {
      code = `import { mark as __rwMark } from "${virtual}";\n` + code;
      code = replaceOnce(
        code,
        "    this.snapshot = next;",
        '    this.snapshot = next;\n    if (next.phase === "active") __rwMark("session-active");',
        "active session",
      );
      code = replaceOnce(
        code,
        "  beforeRequest = () => {",
        '  beforeRequest = () => {\n    __rwMark("transport-check", { phase: this.snapshot.phase, concealed: this.snapshot.concealed });',
        "transport observation",
      );
    } else return;
    return { code, map: null };
  },
};

export default mergeConfig(base, { plugins: [instrumentation] });
