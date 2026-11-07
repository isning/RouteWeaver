import { createHash, randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import type { Collection, Output, Profile, Source } from "../src/types";
import {
  inviteSyntheticAccount,
  requireLoopback,
} from "./account-security-backend";

export const sourcePublicationNames = {
  source: "凭据更新旅程来源",
  collection: "保留处理步骤的集合",
  originalProfile: "更新前分流配置",
  currentProfile: "当前分流配置",
  lateProfile: "候选生成后新增配置",
  chosen: "本次更新的客户端",
  sibling: "保持原版的客户端",
};

// Synthetic text import only. These are never live proxy credentials or URLs.
const username = "synthetic-source-owner";
const passwords = {
  before: "synthetic-source-before",
  after: "synthetic-source-after",
};
export function sourcePublicationInput(version: keyof typeof passwords) {
  return `socks5://${username}:${passwords[version]}@source.example.test:1080#London`;
}

export type JourneySource = Source & {
  revision: string;
  snapshot: NonNullable<Source["snapshot"]> & { snapshotId: string };
};

export async function sourcePublicationOwner(
  admin: APIRequestContext,
  owner: APIRequestContext,
) {
  await inviteSyntheticAccount(admin, owner);
  const response = await owner.get("/api/auth/me");
  expect(response.status()).toBe(200);
  return { "X-CSRF-Token": (await response.json()).csrfToken as string };
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// Supporting setup uses public HTTP only. Source import/edit/apply, review and
// selected publication remain real browser tasks in the accompanying spec.
export async function sourcePublicationFixture(
  owner: APIRequestContext,
  headers: Record<string, string>,
  source: JourneySource,
) {
  const id = `source-pub-${randomUUID()}`;
  const target = { adapterId: "mihomo", version: "1.19.32" };
  expect(source.snapshot.endpoints).toHaveLength(1);
  const endpointId = source.snapshot.endpoints[0].id;
  const collection: Collection = {
    id,
    name: sourcePublicationNames.collection,
    sources: [{ sourceId: source.id, steps: [] }],
    steps: [
      {
        id: "retain-port",
        kind: "override",
        enabled: true,
        override: { region: "GB", port: 2080 },
      },
    ],
  };
  const createdCollection = await owner.post("/api/me/collections", {
    headers,
    data: collection,
  });
  expect(createdCollection.status()).toBe(200);
  const profile: Profile = {
    id,
    name: sourcePublicationNames.originalProfile,
    collectionId: id,
    target,
    mode: "full",
    ir: {
      schemaVersion: "1.0",
      id,
      name: "Source credential journey",
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [
        {
          id: "selected",
          name: "Selected",
          kind: "manual",
          members: [{ kind: "endpoint", ref: endpointId }],
        },
      ],
      rules: [
        {
          id: "local",
          match: { op: "domain-suffix", value: "direct.example.test" },
          action: { kind: "direct" },
        },
      ],
      resources: [],
      defaultAction: { kind: "group", ref: "selected" },
      runtime: { mixedPort: 7890 },
    },
  };
  const createdProfile = await owner.post("/api/me/profiles", {
    headers,
    data: profile,
  });
  expect(createdProfile.status()).toBe(200);
  // Derive origin from a non-secret resource request, never from an access URL.
  const origin = new URL(createdProfile.url()).origin;
  requireLoopback(origin);
  const outputs: Output[] = [];
  for (const [suffix, name] of [
    ["chosen", sourcePublicationNames.chosen],
    ["sibling", sourcePublicationNames.sibling],
  ]) {
    const response = await owner.post("/api/me/outputs", {
      headers,
      data: {
        id: `${id}-${suffix}`,
        name,
        profileId: id,
        target,
        mode: "full",
      },
    });
    expect(response.status()).toBe(201);
    const value = (await response.json()) as Output;
    expect(value.status).toBe("published");
    outputs.push(value);
  }
  async function readProfile(profileId = id): Promise<Profile> {
    const response = await owner.get(`/api/me/profiles/${profileId}/reveal`);
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function readCollection(): Promise<Collection> {
    const response = await owner.get(`/api/me/collections/${id}`);
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function readSource(): Promise<JourneySource> {
    const response = await owner.get(`/api/me/sources/${source.id}`);
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function outputState(outputId: string) {
    const response = await owner.get("/api/me/outputs");
    expect(response.status()).toBe(200);
    const output = ((await response.json()) as Output[]).find(
      (item) => item.id === outputId,
    )!;
    expect(!!output, "Selected output exists").toBe(true);
    const accessResponse = await owner.get(
      `/api/me/outputs/${outputId}/access`,
    );
    expect(accessResponse.status()).toBe(200);
    const access = await accessResponse.json();
    let delivery: { status: number; body: string; pathDigest: string };
    try {
      const url = new URL(access.feedPath, origin);
      if (
        url.origin !== origin ||
        url.protocol !== "http:" ||
        url.username ||
        url.password ||
        !url.pathname.startsWith("/feed/")
      )
        throw new Error();
      // Keep bearer paths and feed bytes out of Playwright diagnostics. Redirects
      // are never followed, and no external source transport is contacted.
      const fetched = await globalThis.fetch(url, { redirect: "manual" });
      delivery = {
        status: fetched.status,
        body: await fetched.text(),
        pathDigest: digest(url.pathname),
      };
    } catch {
      throw new Error(
        "Cannot retrieve isolated synthetic source subscription.",
      );
    }
    expect(delivery.status, "Synthetic feed delivery status").toBe(200);
    let config: {
      proxies: Array<Record<string, unknown>>;
      "proxy-groups": unknown;
      rules: unknown;
    };
    try {
      config = JSON.parse(delivery.body);
    } catch {
      throw new Error("Synthetic feed is not a JSON client configuration.");
    }
    expect(
      config.proxies.length,
      "Synthetic feed contains exactly one connection",
    ).toBe(1);
    const proxy = config.proxies[0];
    // Boolean credential oracles prevent failure diffs from attaching secrets.
    const credential = {
      before:
        proxy.username === username && proxy.password === passwords.before,
      after: proxy.username === username && proxy.password === passwords.after,
    };
    return {
      id: output.id,
      profileId: output.profileId,
      target: output.target,
      mode: output.mode,
      status: output.status,
      revision: output.revision,
      accessRevision: output.accessRevision,
      routingSummary: output.routingSummary,
      accessDigest: delivery.pathDigest,
      contentDigest: digest(delivery.body),
      credential,
      connection: {
        name: proxy.name,
        type: proxy.type,
        server: proxy.server,
        port: proxy.port,
      },
      groups: config["proxy-groups"],
      rules: config.rules,
    };
  }
  const before = await Promise.all(
    outputs.map((output) => outputState(output.id)),
  );
  for (const state of before) {
    expect(state.credential).toEqual({ before: true, after: false });
    expect(state.connection).toMatchObject({
      name: "London",
      type: "socks5",
      server: "source.example.test",
      port: 2080,
    });
    expect(state.rules).toEqual([
      "DOMAIN-SUFFIX,direct.example.test,DIRECT",
      "MATCH,Selected",
    ]);
  }
  const collectionBefore = await readCollection();
  let profilesBefore = [await readProfile()];
  const lateId = `${id}-late`;
  async function advanceDependencies() {
    const { revisionToken, ...current } = await readProfile();
    expect(typeof revisionToken).toBe("string");
    const renamed = await owner.put(`/api/me/profiles/${id}`, {
      headers: { ...headers, "If-Match": revisionToken! },
      data: { ...current, name: sourcePublicationNames.currentProfile },
    });
    expect(renamed.status()).toBe(200);
    const added = await owner.post("/api/me/profiles", {
      headers,
      data: {
        ...profile,
        id: lateId,
        name: sourcePublicationNames.lateProfile,
        ir: { ...profile.ir, id: lateId },
      },
    });
    expect(added.status()).toBe(200);
    profilesBefore = [await readProfile(), await readProfile(lateId)];
  }
  async function recipesUnchanged() {
    expect(await readCollection()).toEqual(collectionBefore);
    for (const saved of profilesBefore)
      expect(await readProfile(saved.id)).toEqual(saved);
  }
  async function publicationsUnchanged() {
    expect(
      await Promise.all(outputs.map((output) => outputState(output.id))),
    ).toEqual(before);
  }
  return {
    id,
    lateId,
    outputs,
    before,
    readSource,
    outputState,
    advanceDependencies,
    recipesUnchanged,
    publicationsUnchanged,
  };
}
