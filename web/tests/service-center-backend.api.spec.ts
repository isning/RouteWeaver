import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { serviceCenterFixture } from "./service-center-backend";

test("E09 invited own service and configured grant deliver isolated feeds; rotation denies only old selected URL", async ({
  request,
  playwright,
  baseURL,
}) => {
  requireLoopback(baseURL);
  const owner = await playwright.request.newContext({ baseURL });
  const other = await playwright.request.newContext({ baseURL });
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    const f = await serviceCenterFixture(request, owner, other, anonymous);
    expect(
      (await owner.get(`/api/users/${f.account.id}/entries`)).status(),
    ).toBe(403);
    const access = await owner.get(`/api/me/outputs/${f.outputs[0].id}/access`);
    expect(access.status()).toBe(200);
    expect((await access.json()).feedPath === f.outputs[0].feedPath).toBe(true);
    const response = await owner.post(
      `/api/me/outputs/${f.outputs[0].id}/rotate`,
      {
        headers: await f.headers(owner),
        data: {},
      },
    );
    expect(response.status()).toBe(200);
    await f.verifyRotation((await response.json()).feedPath);
  } finally {
    await Promise.all([owner.dispose(), other.dispose(), anonymous.dispose()]);
  }
});
