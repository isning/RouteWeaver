import { ruleResourceReference } from "../src/rule-file-model";
import { expect, test } from "@playwright/test";
import { emptyProfile } from "../src/model";
test("owned rule files publish a frozen ZIP bundle while a bare config feed is blocked", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
      data: { username: "routeweaver", password: "local-demo-password" },
    }),
    headers = { "X-CSRF-Token": (await login.json()).csrfToken },
    suffix = Date.now().toString(36),
    body = "payload:\n  - '+.private-rule.example'\n";
  const resource = {
    id: `rules-${suffix}`,
    name: "Private file",
    format: "mihomo-yaml",
    behavior: "domain",
    updatePolicy: "pinned",
  };
  const input = {
    resource,
    contentBase64: Buffer.from(body).toString("base64"),
  };
  const imported = await request.post("/api/me/resources/import", {
    headers,
    data: input,
  });
  expect(imported.status(), await imported.text()).toBe(201);
  const accepted = await imported.json();
  expect(accepted.acceptedVersion).toBeTruthy();
  expect(JSON.stringify(accepted)).not.toContain("private-rule.example");
  const profile = emptyProfile();
  profile.name = "Bundled config";
  profile.ir.resources = [ruleResourceReference(accepted)];
  profile.ir.rules = [
    {
      id: `rule-${suffix}`,
      match: { op: "resource", value: resource.id },
      action: { kind: "reject" },
    },
  ];
  const saved = await request.post("/api/me/profiles", {
    headers,
    data: profile,
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const preview = await request.post(`/api/me/profiles/${profile.id}/preview`, {
    headers,
    data: {},
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  expect(await preview.text()).not.toContain("private-rule.example");
  const published = await request.post("/api/me/outputs", {
    headers,
    data: {
      id: `bundle-${suffix}`,
      name: "Bundled config",
      profileId: profile.id,
    },
  });
  expect(published.status(), await published.text()).toBe(201);
  const output = await published.json();
  expect(output.delivery).toBe("bundle");
  const access = await (
    await request.get(`/api/me/outputs/${output.id}/access`)
  ).json();
  expect(access).toMatchObject({
    delivery: "bundle",
    downloadPath: output.downloadPath,
  });
  expect((await request.get(access.feedPath)).status()).toBe(409);
  const bundle = await request.get(access.downloadPath);
  expect(bundle.headers()["content-type"]).toBe("application/zip");
  const frozen = await bundle.body();
  expect(frozen.subarray(0, 4).toString("hex")).toBe("504b0304");
  expect(frozen.includes(Buffer.from(accepted.path))).toBe(true);
  const replaced = await request.post("/api/me/resources/import", {
    headers,
    data: {
      ...input,
      contentBase64: Buffer.from("payload:\n  - '+.next.example'\n").toString(
        "base64",
      ),
    },
  });
  expect(replaced.status()).toBe(201);
  expect(await (await request.get(access.downloadPath)).body()).toEqual(frozen);
  const invalid = await request.post("/api/me/resources/import", {
    headers,
    data: { ...input, resource: { ...resource, path: "../../escape" } },
  });
  expect(invalid.status()).toBe(400);
  const revoke = await request.post(`/api/me/outputs/${output.id}/revoke`, {
    headers,
    data: {},
  });
  expect(revoke.ok()).toBeTruthy();
  expect((await request.get(access.bundlePath)).ok()).toBe(false);
});
