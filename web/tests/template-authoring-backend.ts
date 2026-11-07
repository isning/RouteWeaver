import { createHash, randomBytes } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { initialPassword, inviteSyntheticAccount, requireLoopback, signInAPI } from "./account-security-backend";

export const authoringNames = {
  template: "日常浏览分流模板",
  source: "管理员模板素材",
  copy: "独立维护配置",
  pinned: "固定版本配置",
  follow: "跟随版本配置",
};
export const authoringTarget = { adapterId: "mihomo", version: "1.19.32" };

// Setup only: two real tenants, one administrator source and three user drafts.
// Template extraction/publication/selection are deliberately absent here: those
// operations must be performed through the UI in the accompanying journey.
export async function templateAuthoringFixture(admin: APIRequestContext, owner: APIRequestContext) {
  const account = await inviteSyntheticAccount(admin, owner);
  await signInAPI(owner, account.username, initialPassword);
  const privatePassword = randomBytes(24).toString("hex");
  function assertNoPrivateSource(value: unknown) {
    const text = JSON.stringify(value) ?? "";
    // Guard before a payload comparison, JSON parsing error or screenshot can
    // put private source material into failure output.
    expect([privatePassword, "synthetic-author", "192.0.2.51", "author-private-exit", "管理员私人连接"].some(part => text.includes(part)), "Shared/user data excludes the source's private connection").toBe(false);
  }
  async function read(client: APIRequestContext, path: string) {
    const response = await client.get(`/api${path}`);
    expect(response.status()).toBe(200);
    const value = await response.json();
    assertNoPrivateSource(value);
    return value;
  }
  async function create(client: APIRequestContext, path: string, data: unknown, status: number) {
    const session = await read(client, "/auth/me");
    const response = await client.post(`/api${path}`, { headers: { "X-CSRF-Token": session.csrfToken }, data });
    // Do not print setup response bodies: outputs contain private bearer paths.
    expect(response.status()).toBe(status);
    return response.json();
  }
  const profile = (id: string, name: string, author = false) => ({
    id, name, target: authoringTarget, mode: "full",
    ir: {
      schemaVersion: "1.0", id, name,
      endpoints: [{
        id: author ? "author-private-exit" : "personal-exit",
        name: author ? "管理员私人连接" : "我的日常连接",
        origin: "imported",
        connection: { protocol: "socks", host: author ? "192.0.2.51" : "192.0.2.52", port: 1080,
          ...(author ? { username: "synthetic-author", password: privatePassword } : {}),
        },
      }],
      groups: [], resources: [],
      rules: author ? [{ id: "browser", match: { op: "domain-suffix", value: "shared-v1.example.test" }, action: { kind: "endpoint", ref: "author-private-exit" } }] : [],
      defaultAction: { kind: "direct" }, runtime: { mixedPort: author ? 7891 : 7890 },
    },
  });
  await create(admin, "/me/profiles", profile("author-source", authoringNames.source, true), 200);
  const outputs: { id: string; feedPath: string }[] = [];
  for (const mode of ["copy", "pinned", "follow"] as const) {
    await create(owner, "/me/profiles", profile(mode, authoringNames[mode]), 200);
    outputs.push(await create(owner, "/me/outputs", { id: `authoring-${mode}`, name: `${authoringNames[mode]}订阅`, profileId: mode, target: authoringTarget, mode: "full" }, 201));
  }
  // Use an authoritative non-secret request URL to establish the only delivery
  // origin. Keep bearer URLs, raw bytes and transport errors out of diagnostics.
  const response = await owner.get("/api/me/outputs");
  expect(response.status()).toBe(200);
  const origin = new URL(response.url()).origin;
  requireLoopback(origin);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  async function deliveryDigests() {
    return Promise.all(outputs.map(async (output) => {
      let result: { status: number; digest: string };
      try {
        const url = new URL(output.feedPath, origin);
        if (url.origin !== origin || url.protocol !== "http:" || url.username || url.password || !url.pathname.startsWith("/feed/")) throw new Error();
        const delivery = await globalThis.fetch(url, { redirect: "manual" });
        result = { status: delivery.status, digest: digest(await delivery.text()) };
      } catch {
        throw new Error("Cannot retrieve synthetic template subscription delivery.");
      }
      expect(result.status).toBe(200);
      return result.digest;
    }));
  }
  const before = await deliveryDigests();
  function assertSafeSpec(value: unknown) {
    assertNoPrivateSource(value);
    expect(value).toMatchObject({
      endpointSlots: [{ id: "endpoint-1", name: "Endpoint 1" }],
      rules: [{ id: "browser", action: { kind: "endpoint", ref: "endpoint-1" } }],
      runtime: { mixedPort: 7891 },
    });
  }
  return {
    read,
    draft: (mode: string) => read(owner, `/me/profiles/${mode}/reveal`),
    bindings: () => read(owner, "/me/template-bindings"),
    async unchangedDeliveries() { expect(await deliveryDigests()).toEqual(before); },
    assertNoPrivateSource,
    assertSafeSpec,
    parseSharedSpec(text: string) {
      assertNoPrivateSource(text);
      let value;
      try { value = JSON.parse(text); }
      catch { throw new Error("Extracted shared structure is not valid JSON."); }
      assertSafeSpec(value);
      return value;
    },
  };
}
