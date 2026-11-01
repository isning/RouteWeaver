import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { inviteSyntheticAccount } from "./account-security-backend";

// Public HTTP fixtures only. The owner is accepted through a real invitation.
export async function processingPublicationFixture(
  admin: APIRequestContext,
  owner: APIRequestContext,
) {
  await inviteSyntheticAccount(admin, owner);
  const session = await (await owner.get("/api/auth/me")).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const id = `processing-${randomUUID()}`;
  const source = await owner.post("/api/me/sources", {
    headers,
    data: {
      id,
      name: "处理旅程来源",
      kind: "text",
      enabled: true,
      content:
        "socks5://proxy.example.test:1080#London\nsocks5://proxy.example.test:1080#Duplicate",
    },
  });
  expect(source.status()).toBe(200);
  const accepted = await source.json();
  expect(accepted.snapshot.endpoints).toHaveLength(2);
  const collection = {
    id,
    name: "处理旅程集合",
    sources: [{ sourceId: id, steps: [] }],
    steps: [],
  };
  expect(
    (
      await owner.post("/api/me/collections", { headers, data: collection })
    ).status(),
  ).toBe(200);
  const target = { adapterId: "mihomo", version: "1.19.32" };
  const profile = {
    id,
    name: "处理旅程配置",
    target,
    mode: "full",
    collectionId: id,
    ir: {
      schemaVersion: "1.0",
      id,
      name: "Processing journey",
      endpoints: [],
      groups: [
        {
          id: "selected",
          name: "Selected",
          kind: "manual",
          members: [
            { kind: "endpoint", ref: accepted.snapshot.endpoints[0].id },
          ],
        },
      ],
      rules: [],
      resources: [],
      defaultAction: { kind: "group", ref: "selected" },
      runtime: { mixedPort: 7890 },
    },
  };
  expect(
    (await owner.post("/api/me/profiles", { headers, data: profile })).status(),
  ).toBe(200);
  const outputs: { id: string; name: string; feedPath: string }[] = [];
  for (const [key, name] of [
    ["selected", "处理待更新订阅"],
    ["sibling", "处理保留订阅"],
  ]) {
    const response = await owner.post("/api/me/outputs", {
      headers,
      data: { id: `${id}-${key}`, name, profileId: id, target, mode: "full" },
    });
    expect(response.status()).toBe(201);
    outputs.push(await response.json());
  }
  const feed = async (index: number) => {
    const response = await owner.get(outputs[index].feedPath);
    expect(response.status()).toBe(200);
    return response.text();
  };
  const before = await Promise.all([feed(0), feed(1)]);
  const readSource = async () => {
    const response = await owner.get(`/api/me/sources/${id}/reveal`);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const sourceBefore = await readSource();
  expect(sourceBefore.content).toContain(
    "socks5://proxy.example.test:1080#London",
  );
  expect(sourceBefore.snapshot.endpoints).toHaveLength(2);
  async function unchanged() {
    expect(await Promise.all([feed(0), feed(1)])).toEqual(before);
    expect(await readSource()).toEqual(sourceBefore);
  }
  return {
    id,
    headers,
    collection,
    outputs,
    before,
    feed,
    unchanged,
    accepted,
    sourceBefore,
    readSource,
  };
}
