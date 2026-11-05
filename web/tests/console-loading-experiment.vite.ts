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
import { createElement, useEffect, useLayoutEffect, useState } from "react";
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
export function statePage(load, fallback) {
  return function DiagnosticStatePage(props) {
    const [Page, setPage] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
      let current = true;
      load().then(
        (value) => { if (current) setPage(() => value.default); },
        (failure) => { if (current) setError(failure); },
      );
      return () => { current = false; };
    }, []);
    if (error) throw error;
    return Page ? createElement(Page, props) : fallback();
  };
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
        `import { mark as __rwMark, settleModule as __rwSettle, MeasuredFallback, statePage as __rwStatePage } from "${virtual}";\n` +
        code;
      const declaration =
        'const SubscriptionsPage = lazyPage(() => import("./Subscriptions").then(m => ({ default: m.SubscriptionsPage })));';
      const loader = `const __rwLoadSubscriptions = () => {
        __rwMark("module-request");
        return import("./Subscriptions").then(m => __rwSettle({ default: m.SubscriptionsPage }));
      };`;
      code = replaceOnce(
        code,
        declaration,
        loader +
          (mode === "suspense"
            ? "\nconst SubscriptionsPage = lazyPage(__rwLoadSubscriptions);"
            : '\nconst SubscriptionsPage = __rwStatePage(__rwLoadSubscriptions, () => <MeasuredFallback page="subscriptions"><PageSkeleton page="subscriptions" /></MeasuredFallback>);'),
        "Subscriptions loader",
      );
      code = replaceOnce(
        code,
        "<PageSkeleton page={page} />",
        "<MeasuredFallback page={page}><PageSkeleton page={page} /></MeasuredFallback>",
        "route fallback",
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
