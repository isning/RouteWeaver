import { createHash } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { emptyProfile } from "../src/model";
import type { Output, Profile } from "../src/types";
import { inviteSyntheticAccount, requireLoopback } from "./account-security-backend";

export const structuredNames = {
  profile: "工作分流与客户端设置",
  chosen: "本次更新的工作电脑",
  sibling: "保留原配置的备用设备",
  group: "工作直连",
  domain: "structured.example.test",
};
export const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// Public-API setup creates an ordinary tenant and two initial frozen outputs.
// All later structured edits, checks, publication and access recovery are UI work.
export async function structuredPublicationFixture(
  admin: APIRequestContext, owner: APIRequestContext, baseURL: string,
) {
  requireLoopback(baseURL);
  await inviteSyntheticAccount(admin, owner);
  const sessionResponse = await owner.get("/api/auth/me");
  expect(sessionResponse.status()).toBe(200);
  const session = await sessionResponse.json();
  expect(session.user.role).toBe("user");
  const headers = { "X-CSRF-Token": session.csrfToken as string };
  const capabilityResponse = await owner.get("/api/me/capabilities");
  expect(capabilityResponse.status()).toBe(200);
  const capabilities = await capabilityResponse.json() as Array<{
    adapterId: string; versions: string[]; runtime: string[];
  }>;
  const target = (adapterId: string) => {
    const supported = capabilities.filter((capability) => capability.adapterId === adapterId);
    expect(supported).toHaveLength(1);
    expect(supported[0].versions).toHaveLength(1);
    if (adapterId === "mihomo") expect(supported[0].runtime).not.toContain("tun");
    else expect(supported[0].runtime).toContain("tun");
    return { adapterId, version: supported[0].versions[0] };
  };
  const profile = emptyProfile();
  profile.id = profile.ir.id = "structured-publication-profile";
  profile.name = profile.ir.name = structuredNames.profile;
  profile.target = target("sing-box");
  profile.ir.runtime.dns = undefined;
  const created = await owner.post("/api/me/profiles", { headers, data: profile });
  expect(created.status()).toBe(200);
  const createOutput = async (id: string, name: string, adapterId: string) => {
    const response = await owner.post("/api/me/outputs", {
      headers, data: { id, name, profileId: profile.id, target: target(adapterId), mode: "full" },
    });
    expect(response.status()).toBe(201);
    return response.json() as Promise<Output>;
  };
  const chosen = await createOutput("structured-chosen", structuredNames.chosen, "mihomo");
  const sibling = await createOutput("structured-sibling", structuredNames.sibling, "sing-box");
  async function readProfile(): Promise<Profile> {
    const response = await owner.get(`/api/me/profiles/${profile.id}/reveal`);
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function metadata(id: string): Promise<Output> {
    const response = await owner.get("/api/me/outputs");
    expect(response.status()).toBe(200);
    const outputs = await response.json() as Output[];
    const matches = outputs.filter((output) => output.id === id);
    expect(matches.length, "Exactly one owned output matches the requested identity").toBe(1);
    return matches[0];
  }
  // Bearer fetches do not pass through Playwright instrumentation. No URL,
  // configuration body, credential or transport cause enters diagnostics.
  async function feed(output: Output): Promise<Buffer> {
    try {
      const url = new URL(output.feedPath || "", baseURL);
      if (url.origin !== new URL(baseURL).origin || !/^\/feed\/[A-Za-z0-9_-]{43}$/.test(url.pathname))
        throw new Error();
      const response = await globalThis.fetch(url, { redirect: "manual" });
      if (response.status !== 200) throw new Error();
      return Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Error("Cannot read the isolated frozen subscription.");
    }
  }
  const originalChosen = await feed(chosen);
  const originalSibling = await feed(sibling);
  async function unchanged() {
    expect((await feed(chosen)).equals(originalChosen), "Chosen output still serves its original bytes").toBe(true);
    expect((await feed(sibling)).equals(originalSibling), "Sibling output still serves its original bytes").toBe(true);
  }
  return { profile, chosen, sibling, originalChosen, originalSibling, feed, readProfile, metadata, unchanged };
}
