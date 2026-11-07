import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import type { Collection, PipelineStep } from "../src/types";
import {
  initialPassword,
  inviteSyntheticAccount,
  requireLoopback,
  signInAPI,
} from "./account-security-backend";

export type CollectionRevision = Collection & { revisionToken: string };

function fixtureID(value: string) {
  // Match the public resource-ID contract before sending fixture data. Report
  // only the length, never source input, credentials or a private request URL.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))
    throw new Error(`Synthetic resource ID violates the 1–64 character contract (length ${value.length}).`);
  return value;
}

// The public recipe, excluding transport metadata and server-owned identity.
export function recipe(value: Collection) {
  return {
    id: value.id,
    name: value.name,
    sources: value.sources,
    steps: value.steps,
  };
}

export async function collectionEditorRecoveryFixture(
  admin: APIRequestContext,
  owner: APIRequestContext,
  concurrent: APIRequestContext,
) {
  const account = await inviteSyntheticAccount(admin, owner);
  const session = await (await owner.get("/api/auth/me")).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  // A separate authenticated session performs the competing edit. It never
  // borrows a browser cookie, mutates a database or fabricates a revision.
  const otherSession = await signInAPI(concurrent, account.username, initialPassword);
  const otherHeaders = { "X-CSRF-Token": otherSession.csrfToken };
  const id = fixtureID(`col-recovery-${randomUUID()}`);
  const sources: Array<{ id: string; name: string; endpointId: string }> = [];
  for (const [index, name] of ["北区合成来源", "南区合成来源"].entries()) {
    const sourceID = fixtureID(`${id}-source-${index}`);
    const response = await owner.post("/api/me/sources", {
      headers,
      data: {
        id: sourceID,
        name,
        kind: "text",
        enabled: true,
        content: `socks5://synthetic-${index}.example.test:1080#Connection ${index}`,
      },
    });
    expect(response.status(), `Create owned synthetic source (ID length ${sourceID.length})`).toBe(200);
    const source = await response.json();
    expect(source.snapshot.endpoints).toHaveLength(1);
    sources.push({ id: source.id, name, endpointId: source.snapshot.endpoints[0].id });
  }
  const rename = (id: string, template: string, enabled = true): PipelineStep =>
    ({ id, kind: "rename", enabled, template, filter: {}, override: {} });
  const override = (id: string, region: string, port: number): PipelineStep =>
    ({ id, kind: "override", enabled: true, filter: {}, override: { region, port } });
  const deduplicate = (id: string): PipelineStep =>
    ({ id, kind: "deduplicate", enabled: false, filter: {}, override: {} });
  const initial: Collection = {
    id,
    name: "待恢复集合",
    sources: [
      { sourceId: sources[0].id, steps: [rename("north-name", "North {name}"), override("north-fields", "US", 1201)] },
      { sourceId: sources[1].id, steps: [rename("south-name", "South {name}"), override("south-fields", "FR", 1202)] },
    ],
    steps: [
      rename("merged-name", "Merged {name}"),
      override("merged-fields", "GB", 1500),
      deduplicate("merged-dedup"),
    ],
  };
  const created = await owner.post("/api/me/collections", { headers, data: initial });
  expect(created.status()).toBe(200);
  const opened = (await created.json()) as CollectionRevision;
  expect(typeof opened.revisionToken).toBe("string");
  expect(opened.revisionToken.length).toBeGreaterThan(0);

  const target = { adapterId: "mihomo", version: "1.19.32" };
  const profile = await owner.post("/api/me/profiles", {
    headers,
    data: {
      id,
      name: "集合恢复关联配置",
      target,
      mode: "full",
      collectionId: id,
      ir: {
        schemaVersion: "1.0", id, name: "Collection recovery",
        endpoints: [],
        groups: [{ id: "selected", name: "Selected", kind: "manual", members: [{ kind: "endpoint", ref: sources[0].endpointId }] }],
        rules: [], resources: [],
        defaultAction: { kind: "group", ref: "selected" },
        runtime: { mixedPort: 7890 },
      },
    },
  });
  expect(profile.status()).toBe(200);
  // Origin comes from a successful non-secret fixture request, never the feed.
  const origin = new URL(profile.url()).origin;
  requireLoopback(origin);
  const output = await owner.post("/api/me/outputs", {
    headers,
    data: { id, name: "集合恢复保留订阅", profileId: id, target, mode: "full" },
  });
  expect(output.status()).toBe(201);
  const { feedPath } = await output.json();
  async function feed() {
    // Playwright transport diagnostics can retain bearer URLs even with traces
    // off. Only uninstrumented Node fetch may read the synthetic delivery.
    let result: { status: number; body: string };
    try {
      const url = new URL(feedPath, origin);
      if (url.origin !== origin || url.protocol !== "http:" || url.username ||
        url.password || !url.pathname.startsWith("/feed/")) throw new Error();
      const response = await globalThis.fetch(url, { redirect: "manual" });
      result = { status: response.status, body: await response.text() };
    } catch {
      throw new Error("Cannot retrieve synthetic subscription delivery.");
    }
    expect(result.status, "Synthetic subscription delivery status").toBe(200);
    return result.body;
  }
  const deliveryBefore = await feed();
  async function read() {
    const response = await concurrent.get(`/api/me/collections/${id}`);
    expect(response.status()).toBe(200);
    return (await response.json()) as CollectionRevision;
  }
  // Reuse override IDs on purpose: replacing only persisted numeric fields
  // while keeping old raw input buffers must fail the browser assertions.
  const latest: Collection = {
    id,
    name: "其他会话已保存集合",
    sources: [
      { sourceId: sources[1].id, steps: [
        deduplicate("south-dedup"),
        override("south-fields", "JP", 3202),
        rename("south-name", "Latest south {name}"),
      ] },
      { sourceId: sources[0].id, steps: [
        override("north-fields", "DE", 3201),
        rename("north-name", "Latest north {name}", false),
      ] },
    ],
    steps: [
      override("merged-fields", "CA", 3500),
      rename("merged-name", "Latest merged {name}"),
      deduplicate("merged-dedup"),
    ],
  };
  async function advance() {
    const response = await concurrent.put(`/api/me/collections/${id}`, {
      headers: { ...otherHeaders, "If-Match": opened.revisionToken },
      data: latest,
    });
    expect(response.status(), "Separate authenticated collection edit commits").toBe(200);
    const saved = (await response.json()) as CollectionRevision;
    expect(recipe(saved)).toEqual(latest);
    expect(saved.revisionToken).not.toBe(opened.revisionToken);
    return saved;
  }
  const sourceBefore = await Promise.all(sources.map(async (source) => {
    const response = await concurrent.get(`/api/me/sources/${source.id}/reveal`);
    expect(response.status()).toBe(200);
    return response.json();
  }));
  const profilesBefore = await (await concurrent.get("/api/me/profiles")).json();
  async function unchangedDependencies() {
    // Compare booleans so neither generated delivery nor source input is copied
    // into assertion diagnostics. All identities and inputs here are synthetic.
    expect(await feed() === deliveryBefore, "Collection recovery does not republish delivery").toBe(true);
    expect(await (await concurrent.get("/api/me/profiles")).json()).toEqual(profilesBefore);
    for (const [index, source] of sources.entries()) {
      const response = await concurrent.get(`/api/me/sources/${source.id}/reveal`);
      expect(response.status()).toBe(200);
      expect(JSON.stringify(await response.json()) === JSON.stringify(sourceBefore[index]), "Collection recovery preserves saved source input").toBe(true);
    }
  }
  return { id, sources, initial, opened, latest, advance, read, unchangedDependencies };
}

export async function legacyCollectionEditorFixture(
  admin: APIRequestContext,
  owner: APIRequestContext,
  concurrent: APIRequestContext,
) {
  const account = await inviteSyntheticAccount(admin, owner);
  const session = await (await owner.get("/api/auth/me")).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const otherSession = await signInAPI(concurrent, account.username, initialPassword);
  const otherHeaders = { "X-CSRF-Token": otherSession.csrfToken };
  const id = fixtureID(`col-legacy-${randomUUID()}`);
  const source = { id: fixtureID(`${id}-source`), name: "旧版合成来源" };
  const sourceResponse = await owner.post("/api/me/sources", {
    headers,
    data: { ...source, kind: "text", enabled: true,
      content: "socks5://legacy.example.test:1080#Legacy connection" },
  });
  expect(sourceResponse.status(), `Create legacy synthetic source (ID length ${source.id.length})`).toBe(200);
  const emptyID = fixtureID(`${id}-empty`);
  const sourceStepsID = fixtureID(`${id}-source-steps`);
  const cases = [
    {
      initial: { id: emptyID, name: "旧版空集合", sources: null, steps: null },
      normalized: { id: emptyID, name: "旧版空集合", sources: [], steps: [] } satisfies Collection,
    },
    {
      initial: { id: sourceStepsID, name: "旧版来源集合", sources: [{ sourceId: source.id, steps: null }], steps: null },
      normalized: { id: sourceStepsID, name: "旧版来源集合", sources: [{ sourceId: source.id, steps: [] }], steps: [] } satisfies Collection,
    },
  ];
  const records: Array<(typeof cases)[number] & { revisionToken: string }> = [];
  for (const value of cases) {
    // Legacy callers send no revision precondition. Nil slices really persist
    // and return JSON null, rather than a fabricated malformed browser response.
    const response = await owner.post("/api/me/collections", { headers, data: value.initial });
    expect(response.status(), `Create legacy synthetic collection (ID length ${value.initial.id.length})`).toBe(200);
    const opened = await response.json();
    expect(opened).toMatchObject(value.initial);
    expect(typeof opened.revisionToken).toBe("string");
    expect(opened.revisionToken.length).toBeGreaterThan(0);
    records.push({ ...value, revisionToken: opened.revisionToken as string });
  }
  async function read(id: string) {
    const response = await concurrent.get(`/api/me/collections/${id}`);
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function advance(record: (typeof records)[number]) {
    const latest = { ...record.initial, name: `${record.initial.name}当前版本` };
    const response = await concurrent.put(`/api/me/collections/${latest.id}`, {
      headers: otherHeaders,
      data: latest,
    });
    expect(response.status(), "Legacy concurrent edit with null slices commits").toBe(200);
    const saved = await response.json();
    expect(saved).toMatchObject(latest);
    expect(saved.revisionToken).not.toBe(record.revisionToken);
    return saved;
  }
  return { source, records, read, advance };
}
