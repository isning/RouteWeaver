import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { expect, type APIRequestContext } from "@playwright/test";
import { emptyProfile } from "../src/model";
import { ruleResourceReference } from "../src/rule-file-model";
import type { Output, Profile, RuleResource } from "../src/types";
import { inviteSyntheticAccount } from "./account-security-backend";

export const ruleJourneyNames = {
  resource: "工作域名规则文件",
  profile: "固定规则版本的配置",
  chosen: "本次更新的规则订阅",
  sibling: "保留原文件的订阅",
  followProfile: "跟随接纳版本的配置",
  followOutput: "明确跟随的规则订阅",
};
export const ruleFileBody = (version: 1 | 2 | 3) =>
  `payload:\n  - '+.rules-v${version}.example.test'\n`;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

// Decode only this test's bounded server-created ZIP, not an uploaded archive.
// No fixture archive/configuration bytes are written to diagnostics or disk.
function bundleFiles(body: Buffer): Map<string, Buffer> {
  try {
    const end = body.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > body.length) throw new Error();
    const count = body.readUInt16LE(end + 10);
    if (count < 1 || count > 66) throw new Error();
    let offset = body.readUInt32LE(end + 16);
    const files = new Map<string, Buffer>();
    for (let index = 0; index < count; index++) {
      if (body.readUInt32LE(offset) !== 0x02014b50) throw new Error();
      const method = body.readUInt16LE(offset + 10);
      const size = body.readUInt32LE(offset + 20);
      const nameSize = body.readUInt16LE(offset + 28);
      const extraSize = body.readUInt16LE(offset + 30);
      const commentSize = body.readUInt16LE(offset + 32);
      const local = body.readUInt32LE(offset + 42);
      const name = body.subarray(offset + 46, offset + 46 + nameSize).toString();
      if (body.readUInt32LE(local) !== 0x04034b50 || files.has(name)) throw new Error();
      const start = local + 30 + body.readUInt16LE(local + 26) + body.readUInt16LE(local + 28);
      if (start + size > body.length) throw new Error();
      const compressed = body.subarray(start, start + size);
      const content = method === 8
        ? inflateRawSync(compressed, { maxOutputLength: 16 << 20 })
        : method === 0 ? compressed : undefined;
      if (!content || content.length !== body.readUInt32LE(offset + 24)) throw new Error();
      files.set(name, content);
      offset += 46 + nameSize + extraSize + commentSize;
    }
    return files;
  } catch {
    throw new Error("Cannot inspect the isolated rule-file configuration bundle.");
  }
}

export async function ruleResourceOwner(admin: APIRequestContext, owner: APIRequestContext) {
  await inviteSyntheticAccount(admin, owner);
  const response = await owner.get("/api/auth/me");
  expect(response.status()).toBe(200);
  return { "X-CSRF-Token": (await response.json()).csrfToken as string };
}

// Supporting profiles and initial output snapshots are public-API setup only.
// File import/replacement, rule selection, pin advance and later publication
// are actual UI operations in the accompanying normal-CLI browser journey.
export function ruleResourceFixture(owner: APIRequestContext, headers: Record<string, string>) {
  async function createProfile(id: string, name: string, resource?: RuleResource) {
    const profile = emptyProfile();
    profile.id = id;
    profile.ir.id = id;
    profile.name = profile.ir.name = name;
    if (resource) {
      profile.ir.resources = [ruleResourceReference(resource)];
      profile.ir.rules = [{
        id: "rule-file", match: { op: "resource", value: resource.id },
        action: { kind: "reject" },
      }];
    }
    const response = await owner.post("/api/me/profiles", { headers, data: profile });
    expect(response.status()).toBe(200);
    return readProfile(id);
  }
  async function readProfile(id: string): Promise<Profile> {
    const response = await owner.get(`/api/me/profiles/${id}/reveal`);
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function createOutput(id: string, name: string, profileId: string): Promise<Output> {
    const response = await owner.post("/api/me/outputs", {
      headers, data: { id, name, profileId },
    });
    expect(response.status()).toBe(201);
    const output = await response.json() as Output;
    expect(output.delivery).toBe("bundle");
    return output;
  }
  async function resources(): Promise<RuleResource[]> {
    const response = await owner.get("/api/me/resources");
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function bundleState(output: Output, resource: RuleResource) {
    const response = await owner.get(`/api/me/outputs/${output.id}/access`);
    expect(response.status()).toBe(200);
    const access = await response.json();
    // Authenticated owner download has no bearer token in its path. Never put
    // the separately returned bearer access URLs into assertions or artifacts.
    const path = `/api/me/outputs/${output.id}/bundle`;
    expect(access.downloadPath === path, "Owner bundle download path").toBe(true);
    expect(access.delivery).toBe("bundle");
    expect(typeof access.bundlePath === "string" && /^\/feed\/[A-Za-z0-9_-]{43}\/bundle$/.test(access.bundlePath),
      "Bundle access includes a valid bearer path").toBe(true);
    const downloaded = await owner.get(path);
    expect(downloaded.status()).toBe(200);
    expect(downloaded.headers()["content-type"]).toBe("application/zip");
    const body = await downloaded.body();
    const files = bundleFiles(body);
    const rule = files.get(resource.path!);
    expect(!!rule, "Bundle includes the requested accepted file").toBe(true);
    let config: {
      "rule-providers"?: Record<string, { path?: string; type?: string }>;
      rules?: string[];
    };
    try { config = JSON.parse(files.get("mihomo.json")!.toString()); }
    catch { throw new Error("The isolated bundle lacks a readable client configuration."); }
    const provider = config["rule-providers"]?.[resource.id];
    expect(provider?.type === "file" && provider.path === resource.path,
      "Compiled configuration uses the accepted bundled file").toBe(true);
    expect(Array.isArray(config.rules) && config.rules.length === 2 &&
      config.rules[0] === `RULE-SET,${resource.id},REJECT` && config.rules[1] === "MATCH,DIRECT",
      "Compiled rule rejects the chosen file's matches and preserves direct fallback").toBe(true);
    const manifest = JSON.parse(files.get("manifest.json")!.toString()) as {
      outputRevision: string;
      files: Array<{ path: string; resourceId?: string; acceptedVersion?: string }>;
    };
    const entry = manifest.files.find((item) => item.resourceId === resource.id);
    expect(entry?.acceptedVersion).toBe(resource.acceptedVersion);
    expect(entry?.path).toBe(resource.path);
    expect(files.size, "One configuration, one rule file and one manifest").toBe(3);
    // Compare exact bytes by digest so a failure never dumps rule contents.
    expect(digest(rule!), "Accepted rule-file bytes match their digest").toBe(resource.digest.slice(7));
    return {
      bundleDigest: digest(body),
      ruleDigest: digest(rule!),
      revision: manifest.outputRevision,
      accessDigest: digest(access.bundlePath),
    };
  }
  return { createProfile, readProfile, createOutput, resources, bundleState };
}
