import { expect, type APIRequestContext } from "@playwright/test";

/** Explicit fixture setup only: intentional edits of the current saved draft.
 * Stale-editor tests must instead carry the token captured when that editor opened.
 */
export async function currentProfileFixtureHeaders(
  client: APIRequestContext,
  id: string,
  headers: Record<string, string>,
) {
  const response = await client.get(`/api/me/profiles/${id}`);
  expect(response.status(), "Read current profile fixture baseline").toBe(200);
  const { revisionToken } = await response.json();
  expect(typeof revisionToken).toBe("string");
  expect(revisionToken.length).toBeGreaterThan(0);
  return { ...headers, "If-Match": revisionToken };
}
