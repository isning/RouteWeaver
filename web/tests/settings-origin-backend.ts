import { expect, type APIRequestContext } from "@playwright/test";

export const originPath = "/api/admin/subscription-origin";
export interface OriginState {
  revision: number;
  configuredRevision: number;
  draftOrigin: string;
  effectiveRevision: number;
  effectiveOrigin: string;
  verificationStatus: string;
  currentLinkExample: string;
  proposedLinkExample: string;
  tokensUnchanged: boolean;
}
export async function originState(
  client: APIRequestContext,
): Promise<OriginState> {
  const result = await client.get(originPath);
  expect(result.status()).toBe(200);
  return result.json();
}
export function sameEffective(actual: OriginState, expected: OriginState) {
  expect(actual.effectiveRevision).toBe(expected.effectiveRevision);
  expect(actual.effectiveOrigin).toBe(expected.effectiveOrigin);
  expect(actual.currentLinkExample).toBe(expected.currentLinkExample);
  expect(actual.tokensUnchanged).toBe(true);
}
export async function stageOrigin(
  client: APIRequestContext,
  csrfToken: string,
  origin: string,
  revision: number,
  status = 200,
) {
  const result = await client.put(originPath, {
    headers: { "X-CSRF-Token": csrfToken },
    data: { origin, expectedRevision: revision },
  });
  expect(result.status()).toBe(status);
  return result;
}
