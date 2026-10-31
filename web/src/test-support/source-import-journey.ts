import { FUNCTIONAL_DOM_TEST_TIMEOUT_MS } from "./functional-dom-contract";

// Full jsdom tasks cross parent, source and review surfaces, or reopen a parent
// to verify persisted intent. They use the shared functional-task budget rather
// than a shorter legacy override; this is not a product latency SLA or speedup.
// Individual findBy/waitFor and hook budgets remain unchanged.
export const SOURCE_IMPORT_JOURNEY_TIMEOUT_MS = FUNCTIONAL_DOM_TEST_TIMEOUT_MS;
