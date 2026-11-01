import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { templateFollowFixture } from "./template-follow-backend";

for (const adapter of ["mihomo", "sing-box"])
  test(`real ${adapter} template conflict review preserves local overrides and publishes only the selected output`, async ({
    request,
    playwright,
    baseURL,
  }) => {
    requireLoopback(baseURL);
    const admin = await playwright.request.newContext({ baseURL });
    try {
      const f = await templateFollowFixture(admin, request, adapter);
      const first = await f.inspect();
      await f.unchanged(); // Inspection is not apply or publication.
      const personal = await f.draft();
      personal.name = "Locally renamed after review";
      await f.save(personal);
      const savedPersonal = await f.draft();
      const stale = await request.post(
        `/api/me/template-bindings/${f.bindingId}/apply`,
        { headers: f.headers, data: { previewDigest: first.previewDigest } },
      );
      expect(stale.status()).toBe(409);
      expect(await f.draft()).toEqual(savedPersonal);
      await f.unchanged();
      const fresh = await f.inspect();
      expect(fresh.previewDigest).not.toBe(first.previewDigest);
      const apply = await request.post(
        `/api/me/template-bindings/${f.bindingId}/apply`,
        { headers: f.headers, data: { previewDigest: fresh.previewDigest } },
      );
      expect(apply.status()).toBe(200);
      const updated = await f.draft();
      expect(updated.name).toBe(personal.name);
      expect(updated.ir.groups[0].name).toBe("Personal group");
      expect(updated.ir.runtime.mixedPort).toBe(9999);
      expect(updated.ir.rules[0].match.value).toBe("blocked.example");
      await f.unchanged();
      const preview = await request.post(`/api/me/profiles/${f.id}/preview`, {
        headers: f.headers,
        data: { outputId: f.outputs[0].id },
      });
      expect(preview.status()).toBe(200);
      const checked = await preview.json();
      expect(checked).toMatchObject({
        valid: true,
        previewScope: "output-update",
        outputId: f.outputs[0].id,
      });
      expect(checked.artifacts[0].content).toContain("blocked.example");
      // This real renderer check is not a native parser/process/traffic claim.
      const publish = await request.post(
        `/api/me/outputs/${f.outputs[0].id}/publish`,
        { headers: f.headers, data: { previewDigest: checked.previewDigest } },
      );
      expect(publish.status()).toBe(200);
      // Preview text omits the renderer feed's terminal newline.
      expect((await f.feed(f.outputs[0])).trimEnd()).toBe(
        checked.artifacts[0].content.trimEnd(),
      );
      expect(await f.feed(f.outputs[0])).not.toBe(f.before[0]);
      expect(await f.feed(f.outputs[1])).toBe(f.before[1]);
    } finally {
      await admin.dispose();
    }
  });
