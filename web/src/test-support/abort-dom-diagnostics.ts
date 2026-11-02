import { vi, type TestContext } from "vitest";

// Observe only: never cancel input events, release overlays, clear timers or
// alter test deadlines. The fixtures using this helper contain synthetic data.
export function abortDOMDiagnostics(context: TestContext) {
  const started = performance.now();
  const checkpoints: { label: string; ms: number }[] = [];
  const mark = (label: string) => {
    checkpoints.push({ label, ms: performance.now() - started });
  };
  const report = () => {
    console.error(
      "DOM_SCENARIO_ABORT",
      JSON.stringify({
        test: context.task.name,
        elapsedMs: performance.now() - started,
        checkpoints,
        hash: location.hash,
        bodyStyle: document.body.getAttribute("style"),
        focused: document.activeElement?.outerHTML,
        body: document.body.innerHTML,
        requests: vi.isMockFunction(fetch)
          ? vi
              .mocked(fetch)
              .mock.calls.map(([url, init]) => ({
                path: String(url),
                method: init?.method || "GET",
              }))
          : [],
      }),
    );
  };
  context.signal.addEventListener("abort", report, { once: true });
  context.onTestFinished(() =>
    context.signal.removeEventListener("abort", report),
  );
  return mark;
}
