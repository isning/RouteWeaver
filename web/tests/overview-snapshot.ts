import { expect } from "@playwright/test";

// Read timestamps advance without a mutation. Keep every quota, permission and
// prediction business field in read-only/cross-account equality assertions.
export function stableOverviewSnapshot(overview: Record<string, unknown>) {
  if (overview.quotaForecast === undefined) return overview;
  expect(overview.quotaForecast).not.toBeNull();
  expect(typeof overview.quotaForecast).toBe("object");
  const { asOf, ...prediction } = overview.quotaForecast as Record<string, unknown>;
  expect(typeof asOf).toBe("string");
  expect(Number.isFinite(Date.parse(String(asOf)))).toBe(true);
  return { ...overview, quotaForecast: prediction };
}
