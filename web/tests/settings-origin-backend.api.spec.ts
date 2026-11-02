import { test, expect } from "./isolated-control-plane-fixture";
import {
  demoPassword,
  requireLoopback,
  signInAPI,
} from "./account-security-backend";
import {
  originPath,
  originState,
  sameEffective,
  stageOrigin,
} from "./settings-origin-backend";

// No DNS/HTTPS probe: custom addresses are reserved synthetic draft strings only.
test("E13 real settings revisions reject invalid/stale drafts and fence activation until explicit default approval", async ({
  request,
  baseURL,
}) => {
  requireLoopback(baseURL);
  const session = await signInAPI(request, "routeweaver", demoPassword);
  const initial = await originState(request);
  await stageOrigin(
    request,
    session.csrfToken,
    "http://invalid.example/path",
    initial.revision,
    400,
  );
  expect(await originState(request)).toEqual(initial);
  const draft = await (
    await stageOrigin(
      request,
      session.csrfToken,
      "https://draft.example",
      initial.revision,
    )
  ).json();
  sameEffective(draft, initial);
  expect(draft.verificationStatus).toBe("unverified");
  const activate = (revision: number) =>
    request.post(`${originPath}/activate`, {
      headers: { "X-CSRF-Token": session.csrfToken },
      data: { expectedRevision: revision },
    });
  expect((await activate(draft.revision)).status()).toBe(409);
  expect(await originState(request)).toEqual(draft);
  const concurrent = await (
    await stageOrigin(
      request,
      session.csrfToken,
      "https://concurrent.example",
      draft.revision,
    )
  ).json();
  await stageOrigin(
    request,
    session.csrfToken,
    "https://retained.example",
    draft.revision,
    409,
  );
  expect(await originState(request)).toEqual(concurrent);
  const pending = await (
    await stageOrigin(request, session.csrfToken, "", concurrent.revision)
  ).json();
  expect(pending.verificationStatus).toBe("not-required");
  expect(pending.configuredRevision).not.toBe(pending.effectiveRevision);
  sameEffective(pending, initial);
  const replacement = await (
    await stageOrigin(
      request,
      session.csrfToken,
      "https://replacement.example",
      pending.revision,
    )
  ).json();
  expect((await activate(pending.revision)).status()).toBe(409);
  expect(await originState(request)).toEqual(replacement);
  const reviewed = await (
    await stageOrigin(request, session.csrfToken, "", replacement.revision)
  ).json();
  const result = await activate(reviewed.revision);
  expect(result.status()).toBe(200);
  const effective = await result.json();
  expect(effective.effectiveRevision).toBe(reviewed.configuredRevision);
  expect(effective.effectiveOrigin).toBe("");
  expect(effective.currentLinkExample).toBe(initial.currentLinkExample);
  expect(effective.tokensUnchanged).toBe(true);
  expect(await originState(request)).toEqual(effective);
});
