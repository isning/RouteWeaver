// Functional jsdom harness contracts, not product/browser latency SLAs.
// Explicit per-test budgets still take precedence over this DOM-only default.
export const FUNCTIONAL_DOM_TEST_TIMEOUT_MS = 20_000;

// Only the first functional control after mounting a page/Workspace may use
// this named bootstrap budget. Ordinary findBy/waitFor defaults remain 1 s.
export const INITIAL_PAGE_READY_TIMEOUT_MS = 5_000;
