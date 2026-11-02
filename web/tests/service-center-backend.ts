import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { inviteSyntheticAccount } from "./account-security-backend";

export const serviceName = "邀请制参考服务";
export const routeName = "授权参考线路";
export const selectedName = "日常设备订阅";
export const siblingName = "保留设备订阅";

// Explicitly configured legacy platform entries, not managed-node observations.
// Public HTTP only: no DB edits, auth shortcut, runtime core or external traffic.
export async function serviceCenterFixture(
  admin: APIRequestContext,
  owner: APIRequestContext,
  other: APIRequestContext,
  anonymous: APIRequestContext,
) {
  const account = await inviteSyntheticAccount(admin, owner);
  const otherAccount = await inviteSyntheticAccount(admin, other);
  const headers = async (client: APIRequestContext) => ({
    "X-CSRF-Token": (await (await client.get("/api/auth/me")).json()).csrfToken,
  });
  const adminHeaders = await headers(admin);
  const id = `service-center-${randomUUID()}`;
  const connection = {
    protocol: "socks",
    host: "127.0.0.1",
    port: 1080,
    username: "synthetic-user",
    password: "synthetic-entry-secret",
  };
  const postAdmin = async (path: string, data: unknown, status = 200) => {
    const response = await admin.post(`/api/${path}`, {
      headers: adminHeaders,
      data,
    });
    expect(response.status(), `Provision ${path}`).toBe(status);
  };
  await postAdmin("nodes", {
    id,
    name: "参考连接",
    ...connection,
    status: "unknown",
  });
  await postAdmin("routes", {
    id,
    name: routeName,
    engine: "xray",
    hops: [id],
    userIds: [],
  });
  const cycle = { mode: "monthly", day: 1, timezone: "UTC+8" };
  await postAdmin("services", {
    id,
    name: serviceName,
    quotaBytes: 104857600,
    routeIds: [id],
    cycle,
  });
  const expiry = new Date(Date.now() + 14 * 86400000).toISOString();
  const outputSets: { id: string; name: string; feedPath: string }[][] = [];
  for (const [client, user, names] of [
    [owner, account, [selectedName, siblingName]],
    [other, otherAccount, ["其他用户订阅"]],
  ] as const) {
    const granted = await admin.put(`/api/users/${user.id}/entitlement`, {
      headers: adminHeaders,
      data: { serviceId: id, expiresAt: expiry, cycle },
    });
    expect(granted.status()).toBe(200);
    await postAdmin(
      `users/${user.id}/entries`,
      {
        id: "entry",
        name: routeName,
        routeId: id,
        credentialVersion: "v1",
        connection: { ...connection, username: user.id },
      },
      201,
    );
    const ownHeaders = await headers(client);
    const target = { adapterId: "mihomo", version: "1.19.32" };
    const profile = await client.post("/api/me/profiles", {
      headers: ownHeaders,
      data: {
        id: "daily",
        name: "日常分流",
        target,
        mode: "full",
        platformEntryIds: ["entry"],
        ir: {
          schemaVersion: "1.0",
          id: "daily",
          name: "Daily",
          endpoints: [],
          groups: [],
          rules: [],
          resources: [],
          defaultAction: { kind: "endpoint", ref: "entry" },
          runtime: { mixedPort: 7890 },
        },
      },
    });
    expect(profile.status()).toBe(200);
    const outputs = [];
    for (const [index, name] of names.entries()) {
      const response = await client.post("/api/me/outputs", {
        headers: ownHeaders,
        data: {
          id: `feed-${index}`,
          name,
          profileId: "daily",
          target,
          mode: "full",
        },
      });
      expect(response.status()).toBe(201);
      outputs.push(await response.json());
    }
    outputSets.push(outputs);
  }
  const [outputs, otherOutputs] = outputSets;
  const feed = async (path: string) => {
    const response = await anonymous.get(path);
    expect(response.status()).toBe(200);
    return response.body();
  };
  const ownBefore = await feed(outputs[0].feedPath);
  const siblingBefore = await feed(outputs[1].feedPath);
  const otherBefore = await feed(otherOutputs[0].feedPath);
  const otherOverview = await (await other.get("/api/me/overview")).json();
  const overview = await (await owner.get("/api/me/overview")).json();
  expect(overview.user.id).toBe(account.id);
  expect(overview.status).toBe("active");
  expect(overview.service.name).toBe(serviceName);
  expect(overview.quotaBytes).toBe(104857600);
  expect(overview.routes).toEqual([
    expect.objectContaining({ id, name: routeName }),
  ]);
  const ownConnection = JSON.parse(ownBefore.toString()).proxies[0];
  expect(ownConnection.username).toBe(account.id);
  expect(ownConnection.username).not.toBe(otherAccount.id);
  const unchangedOthers = async () => {
    expect((await feed(outputs[1].feedPath)).equals(siblingBefore)).toBe(true);
    expect((await feed(otherOutputs[0].feedPath)).equals(otherBefore)).toBe(
      true,
    );
    expect(await (await other.get("/api/me/overview")).json()).toEqual(
      otherOverview,
    );
    const otherAccess = await other.get(
      `/api/me/outputs/${otherOutputs[0].id}/access`,
    );
    expect(otherAccess.status()).toBe(200);
    expect(
      (await otherAccess.json()).feedPath === otherOutputs[0].feedPath,
    ).toBe(true);
  };
  const verifyRotation = async (nextPath: string) => {
    expect(nextPath !== outputs[0].feedPath).toBe(true);
    expect((await anonymous.get(outputs[0].feedPath)).status()).toBe(404);
    expect((await feed(nextPath)).equals(ownBefore)).toBe(true);
    await unchangedOthers();
  };
  return {
    account,
    outputs,
    ownBefore,
    overview,
    feed,
    headers,
    unchangedOthers,
    verifyRotation,
  };
}
