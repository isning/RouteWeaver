import { createServer } from "node:net";
import { expect, type APIRequestContext } from "@playwright/test";
import { inviteSyntheticAccount } from "./account-security-backend";
export async function seedNativePublication(
  admin: APIRequestContext,
  owner: APIRequestContext,
  occupiedPort?: number,
) {
  const account = await inviteSyntheticAccount(admin, owner);
  const me = await (await admin.get("/api/auth/me")).json();
  const headers = { "X-CSRF-Token": me.csrfToken };
  const call = async (path: string, data: unknown, status = 200) => {
    const r = await admin.post(`/api/${path}`, { headers, data });
    expect(r.status(), path).toBe(status);
    return r.json();
  };
  let port = occupiedPort;
  if (port === undefined) {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const host = {
    id: "bridge-host",
    name: "原生验收主机",
    address: "127.0.0.1",
  };
  const instance = {
    id: "bridge-core",
    hostId: host.id,
    name: "原生验收实例",
    adapterId: "routeweaver/managed-xray",
    version: "26.3.27-rw1",
  };
  const endpoint = {
    id: "bridge-entry",
    instanceId: instance.id,
    name: "原生验收入口",
    connection: {
      protocol: "vless",
      host: "127.0.0.1",
      port,
      uuid: "00000000-0000-4000-8000-000000000001",
    },
  };
  const draft = {
    id: "bridge-deployment",
    name: "原生验收转发路径",
    ir: {
      id: "bridge-deployment",
      schemaVersion: "1.0",
      topologyRevision: "browser-native",
      programs: [
        {
          instance,
          listener: endpoint,
          destinationPolicy: { allowCIDRs: ["127.0.0.1/32"] },
        },
      ],
    },
  };
  await call("hosts", host);
  await call("core-instances", instance);
  await call("managed-endpoints", endpoint);
  await call("server-deployments", draft);
  await call("published-routes", {
    id: "bridge-route",
    name: "原生验收线路",
    deploymentId: draft.id,
    endpointIds: [endpoint.id],
    publicHost: "127.0.0.1",
    publicPort: port,
  });
  const cycle = { mode: "none", timezone: "UTC+8" };
  await call("services", {
    id: "bridge-plan",
    name: "原生验收服务",
    quotaBytes: 1048576,
    routeIds: ["bridge-route"],
    cycle,
  });
  expect(
    (
      await admin.put(`/api/users/${account.id}/entitlement`, {
        headers,
        data: { serviceId: "bridge-plan", cycle },
      })
    ).status(),
  ).toBe(200);
  await call(
    "published-routes/bridge-route/principals",
    {
      accountId: account.id,
      entryId: "bridge-principal",
      credentialVersion: "v1",
    },
    201,
  );
  const enrollment = await call(
    "agent/enrollments",
    {
      nodeId: host.id,
      instanceId: instance.id,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    201,
  );
  return { host, instance, draft, enrollment, call };
}
