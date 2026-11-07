import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import {
  initialPassword,
  inviteSyntheticAccount,
  requireLoopback,
  signInAPI,
} from "./account-security-backend";

// Public HTTP seams only, with an isolated synthetic owner and two outputs of
// the SAME profile. Updating a draft must not silently republish either output.
export async function templateFollowFixture(
  admin: APIRequestContext,
  owner: APIRequestContext,
  adapterId = "mihomo",
) {
  const account = await inviteSyntheticAccount(admin, owner);
  const session = await signInAPI(owner, account.username, initialPassword);
  const headers = { "X-CSRF-Token": session.csrfToken };
  const adminSession = await (await admin.get("/api/auth/me")).json();
  const adminHeaders = { "X-CSRF-Token": adminSession.csrfToken };
  const id = `follow-${randomUUID()}`;
  const target = {
    adapterId,
    version: adapterId === "mihomo" ? "1.19.32" : "1.14.3",
  };
  const profile = {
    id,
    name: "模板跟随草稿",
    target,
    mode: "full",
    ir: {
      schemaVersion: "1.0",
      id,
      name: "Template follow",
      endpoints: [
        {
          id: "primary",
          name: "个人常用连接",
          origin: "imported",
          connection: { protocol: "socks", host: "192.0.2.20", port: 1080 },
        },
        {
          id: "alternate",
          name: "个人备用连接",
          origin: "imported",
          connection: { protocol: "socks", host: "192.0.2.30", port: 1080 },
        },
      ],
      groups: [],
      rules: [],
      resources: [],
      defaultAction: { kind: "direct" },
      runtime: { mixedPort: 7890 },
    },
  };
  const saved = await owner.post("/api/me/profiles", {
    headers,
    data: profile,
  });
  expect(saved.status()).toBe(200);
  // Derive the allowed origin from a successful non-secret fixture request.
  // Neither a caller-supplied feed URL nor a redirect may choose a destination.
  const origin = new URL(saved.url()).origin;
  requireLoopback(origin);
  const spec = {
    endpointSlots: [{ id: "exit", name: "模板连接" }],
    groups: [
      {
        id: "proxy",
        name: "Shared group",
        kind: "manual",
        members: [{ kind: "direct" }],
      },
    ],
    rules: [] as unknown[],
    defaultAction: { kind: "group", ref: "proxy" },
    runtime: { mixedPort: 7890 },
  };
  async function publishTemplate(expectedVersion: number) {
    const response = await admin.post("/api/admin/templates", {
      headers: adminHeaders,
      data: {
        id,
        name: `Synthetic template ${id}`,
        kind: "client-profile",
        expectedVersion,
        spec,
      },
    });
    expect(response.status()).toBe(201);
  }
  await publishTemplate(0);
  const selected = await owner.post(`/api/me/templates/${id}/select`, {
    headers,
    data: {
      mode: "follow",
      version: 1,
      targetId: id,
      bindings: { endpoints: { exit: "primary" }, resources: {} },
    },
  });
  expect(selected.status()).toBe(200);
  const bindingId = (await selected.json()).binding.id;
  const outputs: { id: string; name: string; feedPath: string }[] = [];
  for (const [key, name] of [
    ["selected", "待更新订阅"],
    ["sibling", "保持不变订阅"],
  ]) {
    const response = await owner.post("/api/me/outputs", {
      headers,
      data: { id: `${id}-${key}`, name, profileId: id, target, mode: "full" },
    });
    expect(response.status()).toBe(201);
    outputs.push(await response.json());
  }
  async function feed(output: { feedPath: string }) {
    // Playwright can include bearer URLs in transport diagnostics even with
    // traces off. Keep delivery reads uninstrumented and never retain the URL,
    // body, or original transport error in a failure message or error cause.
    let result: { status: number; body: string };
    try {
      const url = new URL(output.feedPath, origin);
      if (
        url.origin !== origin ||
        url.protocol !== "http:" ||
        url.username ||
        url.password ||
        !url.pathname.startsWith("/feed/")
      )
        throw new Error();
      const response = await globalThis.fetch(url, { redirect: "manual" });
      result = { status: response.status, body: await response.text() };
    } catch {
      throw new Error("Cannot retrieve synthetic subscription delivery.");
    }
    expect(result.status, "Synthetic subscription delivery status").toBe(200);
    return result.body;
  }
  const before = await Promise.all(outputs.map(feed));
  async function draft() {
    const response = await owner.get(`/api/me/profiles/${id}/reveal`);
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function save(value: Record<string, unknown>) {
    const { revisionToken, ...profile } = value;
    expect(typeof revisionToken).toBe("string");
    expect(revisionToken).not.toBe("");
    const response = await owner.put(`/api/me/profiles/${id}`, {
      headers: { ...headers, "If-Match": revisionToken as string },
      data: profile,
    });
    expect(response.status()).toBe(200);
  }
  const personal = await draft();
  personal.ir.groups[0].name = "Personal group";
  personal.ir.runtime.mixedPort = 9999;
  await save(personal);
  // Both upstream and owner edit the same fields. Existing semantics retain
  // personal overrides while adding the upstream rule; do not invent a merge UI.
  spec.groups[0].name = "Upstream group";
  spec.runtime.mixedPort = 8888;
  spec.rules = [
    {
      id: "block",
      match: { op: "domain-suffix", value: "blocked.example" },
      action: { kind: "reject" },
    },
    {
      id: "bound",
      match: { op: "domain-suffix", value: "bound.example" },
      action: { kind: "endpoint", ref: "exit" },
    },
  ];
  await publishTemplate(1);
  async function unchanged() {
    expect(await Promise.all(outputs.map(feed))).toEqual(before);
  }
  async function inspect() {
    const response = await owner.post(
      `/api/me/template-bindings/${bindingId}/preview`,
      { headers, data: {} },
    );
    expect(response.status()).toBe(200);
    const value = await response.json();
    expect(value).toMatchObject({
      compatible: true,
      hasUpdate: true,
      nativeChecked: false,
    });
    expect(value.preservedLocalEdits.length).toBeGreaterThan(0);
    return value;
  }
  return {
    id,
    target,
    headers,
    bindingId,
    outputs,
    before,
    feed,
    draft,
    save,
    unchanged,
    inspect,
  };
}
