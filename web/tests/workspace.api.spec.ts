import { test, expect } from "@playwright/test";
test("private source → ordered collection → profile → published feed → revocation", async ({
  request,
}) => {
  const auth = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  expect(auth.ok()).toBeTruthy();
  const session = await auth.json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const suffix = Date.now().toString(36);
  const sourceId = `src_${suffix}`,
    collectionId = `collection_${suffix}`,
    profileId = `profile_${suffix}`,
    outputId = `output_${suffix}`;
  const source = await request.post("/api/me/sources", {
    headers,
    data: {
      id: sourceId,
      name: "London source",
      kind: "text",
      content: [
        "socks5://fixture-user:fixture-password@proxy.example.com:1080#London",
        "socks5://fixture-user:fixture-password@proxy.example.com:1080#London%20duplicate",
      ].join("\n"),
      enabled: true,
    },
  });
  expect(source.status(), await source.text()).toBe(200);
  const imported = await source.json();
  expect(imported.snapshot.endpoints).toHaveLength(2);
  const endpoint = imported.snapshot.endpoints[0];
  const collection = {
    id: collectionId,
    name: "Work collection",
    sources: [
      {
        sourceId,
        steps: [
          {
            id: "source-override",
            kind: "override",
            enabled: true,
            override: {
              region: "DE",
              tags: ["work"],
              host: "source.example",
              port: 2080,
            },
          },
          {
            id: "rename",
            kind: "rename",
            enabled: true,
            template: "Work {name}",
          },
        ],
      },
    ],
    steps: [
      { id: "dedup", kind: "deduplicate", enabled: true },
      {
        id: "aggregate-override",
        kind: "override",
        enabled: true,
        filter: { region: "DE", tags: ["work"] },
        override: { host: "aggregate.example", port: 3080, tags: [] },
      },
    ],
  };
  expect(
    (
      await request.post("/api/me/collections", { headers, data: collection })
    ).ok(),
  ).toBeTruthy();
  const processed = await request.post("/api/me/collections/preview", {
    headers,
    data: collection,
  });
  expect(processed.ok(), await processed.text()).toBeTruthy();
  const processedBody = await processed.json();
  expect(processedBody.endpoints).toHaveLength(1);
  expect(processedBody.endpoints[0].id).toBe(endpoint.id);
  expect(processedBody.endpoints[0].region).toBe("DE");
  expect(processedBody.endpoints[0].tags ?? []).toEqual([]);
  expect(processedBody.endpoints[0].connection).toMatchObject({
    host: "aggregate.example",
    port: 3080,
  });
  expect(
    processedBody.endpoints[0].provenance.map(
      (ref: { endpointId: string }) => ref.endpointId,
    ),
  ).toEqual(imported.snapshot.endpoints.map((node: { id: string }) => node.id));
  const dedupStage = processedBody.stages.find(
    (stage: { stepId: string }) => stage.stepId === "dedup",
  );
  expect(dedupStage.removedIds).toEqual([imported.snapshot.endpoints[1].id]);
  const sourceStage = processedBody.stages.find(
    (stage: { stepId: string }) => stage.stepId === "source-override",
  );
  expect(sourceStage.endpoints).toHaveLength(2);
  expect(sourceStage.endpoints[0].connection).toMatchObject({
    host: "source.example",
    port: 2080,
  });
  expect(sourceStage.endpoints[0].tags).toEqual(["work"]);
  expect(JSON.stringify(processedBody)).not.toContain("fixture-password");
  expect(processedBody.endpoints[0].name).toBe("Work London");
  expect(processedBody.stages.length).toBeGreaterThan(2);
  const profile = {
    id: profileId,
    name: "Work laptop",
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    collectionId,
    ir: {
      schemaVersion: "1.0",
      id: profileId,
      name: "Work laptop",
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [
        {
          id: "work",
          name: "Work",
          kind: "manual",
          members: [{ kind: "endpoint", ref: endpoint.id }],
        },
      ],
      rules: [
        {
          id: "company",
          match: { op: "domain-suffix", value: "example.org" },
          action: { kind: "group", ref: "work" },
        },
      ],
      resources: [],
      defaultAction: { kind: "group", ref: "work" },
      runtime: { mixedPort: 7890 },
    },
  };
  const saved = await request.post("/api/me/profiles", {
    headers,
    data: profile,
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const preview = await request.post("/api/me/profiles/preview", {
    headers,
    data: profile,
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  const previewBody = await preview.json();
  expect(previewBody.valid).toBe(true);
  expect(previewBody.nativeChecked).toBe(false);
  expect(JSON.parse(previewBody.artifacts[0].content).proxies).toEqual([
    expect.objectContaining({
      name: "Work London",
      server: "aggregate.example",
      port: 3080,
      username: "[REDACTED]",
      password: "[REDACTED]",
    }),
  ]);
  const published = await request.post("/api/me/outputs", {
    headers,
    data: {
      id: outputId,
      name: "Work subscription",
      profileId,
      target: profile.target,
      mode: "full",
    },
  });
  expect(published.status(), await published.text()).toBe(201);
  const output = await published.json();
  const access = await request.get(`/api/me/outputs/${outputId}/access`);
  expect((await access.json()).feedPath).toBe(output.feedPath);
  const feed = await request.get(output.feedPath);
  expect(feed.ok(), await feed.text()).toBeTruthy();
  expect((await feed.json()).proxies).toEqual([
    expect.objectContaining({
      name: "Work London",
      server: "aggregate.example",
      port: 3080,
      username: "fixture-user",
      password: "fixture-password",
    }),
  ]);
  expect(await feed.text()).not.toContain("<!doctype html>");
  // A rejected processing preview must not alter the accepted source or published bytes.
  const acceptedBefore = await request.get(`/api/me/sources/${sourceId}`);
  expect(acceptedBefore.ok()).toBeTruthy();
  const acceptedSource = await acceptedBefore.json();
  for (const override of [{ host: "bad host" }, { port: 65536 }]) {
    const rejected = await request.post("/api/me/collections/preview", {
      headers,
      data: {
        ...collection,
        steps: [
          ...collection.steps,
          {
            id: "invalid-override",
            kind: "override",
            enabled: true,
            override,
          },
        ],
      },
    });
    expect(rejected.status()).toBe(400);
    expect(await rejected.text()).toContain("invalid connection override");
    const sourceAfter = await request.get(`/api/me/sources/${sourceId}`);
    expect(sourceAfter.ok()).toBeTruthy();
    expect(await sourceAfter.json()).toEqual(acceptedSource);
    const unchangedFeed = await request.get(output.feedPath);
    expect(unchangedFeed.ok()).toBeTruthy();
    expect(await unchangedFeed.text()).toBe(await feed.text());
  }
  const rotate = await request.post(`/api/me/outputs/${outputId}/rotate`, {
    headers,
    data: {},
  });
  expect(rotate.ok()).toBeTruthy();
  const nextPath = (await rotate.json()).feedPath;
  expect(nextPath).not.toBe(output.feedPath);
  expect((await request.get(output.feedPath)).ok()).toBeFalsy();
  expect((await request.get(nextPath)).ok()).toBeTruthy();
  expect(
    (
      await request.post(`/api/me/outputs/${outputId}/revoke`, {
        headers,
        data: {},
      })
    ).ok(),
  ).toBeTruthy();
  expect((await request.get(nextPath)).ok()).toBeFalsy();
});
test("rejected profile publication leaves its existing feed retrievable", async ({
  request,
}) => {
  const auth = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  const { csrfToken } = await auth.json();
  const headers = { "X-CSRF-Token": csrfToken };
  const id = `draft_${Date.now().toString(36)}`;
  const base = {
    id,
    name: "Draft safety",
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    ir: {
      schemaVersion: "1.0",
      id,
      name: "Draft safety",
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [],
      rules: [],
      resources: [],
      defaultAction: { kind: "direct" },
      runtime: { mixedPort: 7890 },
    },
  };
  expect(
    (await request.post("/api/me/profiles", { headers, data: base })).ok(),
  ).toBeTruthy();
  const publish = await request.post("/api/me/outputs", {
    headers,
    data: {
      id: `out_${id}`,
      name: "Saved feed",
      profileId: id,
      target: base.target,
      mode: "full",
    },
  });
  expect(publish.ok(), await publish.text()).toBeTruthy();
  const output = await publish.json();
  const original = await (await request.get(output.feedPath)).text();
  const invalid = {
    ...base,
    ir: {
      ...base.ir,
      groups: [{ id: "empty", name: "Empty", kind: "manual", members: [] }],
    },
  };
  const save = await request.put(`/api/me/profiles/${id}`, {
    headers,
    data: invalid,
  });
  expect(save.ok(), await save.text()).toBeTruthy();
  expect(
    (
      await request.post(`/api/me/outputs/${output.id}/publish`, {
        headers,
        data: {},
      })
    ).ok(),
  ).toBeFalsy();
  expect(await (await request.get(output.feedPath)).text()).toBe(original);
});
test("managed inventory compiles a real multi-instance server path without pretending it was applied", async ({
  request,
}) => {
  const auth = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  const { csrfToken } = await auth.json();
  const headers = { "X-CSRF-Token": csrfToken };
  const suffix = Date.now().toString(36);
  const hosts = [
    { id: `h_fra_${suffix}`, name: "FRA", address: "fra.example.com" },
    { id: `h_uk_${suffix}`, name: "UK", address: "uk.example.com" },
  ];
  for (const host of hosts) {
    const response = await request.post("/api/hosts", { headers, data: host });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  const instances = hosts.map((host, i) => ({
    id: `core_${i}_${suffix}`,
    hostId: host.id,
    adapterId: i ? "routeweaver/xray" : "routeweaver/sing-box",
    version: i ? "26.3.27" : "1.14.3",
  }));
  for (const instance of instances)
    expect(
      (
        await request.post("/api/core-instances", { headers, data: instance })
      ).ok(),
    ).toBeTruthy();
  const endpoints = instances.map((instance, i) => ({
    id: `endpoint_${i}_${suffix}`,
    instanceId: instance.id,
    name: i ? "UK exit" : "FRA entry",
    connection: {
      host: "0.0.0.0",
      port: 1080 + i,
      protocol: "socks",
      username: "local-test",
      password: "local-only-fixture",
    },
  }));
  for (const endpoint of endpoints)
    expect(
      (
        await request.post("/api/managed-endpoints", {
          headers,
          data: endpoint,
        })
      ).ok(),
    ).toBeTruthy();
  const deployment = {
    id: `deployment_${suffix}`,
    name: "FRA → UK",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: `deployment_${suffix}`,
      topologyRevision: "r1",
      programs: instances.map((instance, i) => ({
        instance,
        listener: endpoints[i],
        egress: i
          ? []
          : [{ ...endpoints[1].connection, host: hosts[1].address }],
        rules: [],
        resources: [],
      })),
    },
  };
  const savedDeployment = await request.post("/api/server-deployments", {
    headers,
    data: deployment,
  });
  expect(savedDeployment.ok()).toBeTruthy();
  const openedDeployment = await savedDeployment.json();
  const validate = await request.post(
    `/api/server-deployments/${deployment.id}/validate`,
    {
      headers: { ...headers, "If-Match": openedDeployment.revisionToken },
      data: {},
    },
  );
  expect(validate.ok(), await validate.text()).toBeTruthy();
  const body = await validate.json();
  expect(body.valid).toBe(true);
  expect(body.nativeChecked).toBe(false);
  expect(body.artifacts).toHaveLength(2);
  expect(body.artifacts[0].content).toContain("uk.example.com");
  const state = await request.get(
    `/api/agent/instances/${instances[0].id}/state`,
  );
  expect((await state.json()).phase).toBe("unregistered");
  const rejected = await request.post(
    `/api/server-deployments/${deployment.id}/publish`,
    {
      headers,
      data: {
        leaseSeconds: 300,
        accessAllowed: true,
        quotaCertain: true,
        expectedFingerprint: body.fingerprint,
        operationId: `publication_${deployment.id}`,
      },
    },
  );
  expect(rejected.status()).toBe(200);
  expect(await rejected.json()).toMatchObject({
    operationId: `publication_${deployment.id}`,
    deploymentId: deployment.id,
    status: "definitively-rejected",
    code: "PUBLICATION_REJECTED",
  });
  expect(
    (
      await (
        await request.get(`/api/agent/instances/${instances[0].id}/state`)
      ).json()
    ).phase,
  ).toBe("unregistered");
});
test("explicit reveal editing preserves a synthetic credential across source and profile saves", async ({
  request,
}) => {
  const auth = await request.post("/api/auth/login", {
    data: { username: "routeweaver", password: "local-demo-password" },
  });
  const { csrfToken } = await auth.json();
  const headers = { "X-CSRF-Token": csrfToken };
  const suffix = Date.now().toString(36);
  const secret = "only-a-local-test-fixture";
  const sourceId = `secret_source_${suffix}`;
  expect(
    (
      await request.post("/api/me/sources", {
        headers,
        data: {
          id: sourceId,
          name: "Private credential fixture",
          kind: "text",
          content: `socks5://test-user:${secret}@proxy.example.com:1080#Private`,
          enabled: true,
        },
      })
    ).ok(),
  ).toBeTruthy();
  const listText = await (await request.get("/api/me/sources")).text();
  expect(listText).not.toContain(secret);
  const revealedSource = await (
    await request.get(`/api/me/sources/${sourceId}/reveal`)
  ).json();
  expect(revealedSource.content).toContain(secret);
  revealedSource.name = "Renamed private source";
  expect(
    (
      await request.put(`/api/me/sources/${sourceId}`, {
        headers,
        data: revealedSource,
      })
    ).ok(),
  ).toBeTruthy();
  const id = `secret_profile_${suffix}`;
  const profile = {
    id,
    name: "Secret-preserving profile",
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    sourceIds: [sourceId],
    ir: {
      schemaVersion: "1.0",
      id,
      name: "Secret-preserving profile",
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [],
      rules: [],
      resources: [],
      defaultAction: { kind: "direct" },
      runtime: { mixedPort: 7890 },
    },
  };
  expect(
    (await request.post("/api/me/profiles", { headers, data: profile })).ok(),
  ).toBeTruthy();
  expect(await (await request.get("/api/me/profiles")).text()).not.toContain(
    secret,
  );
  const revealedProfile = await (
    await request.get(`/api/me/profiles/${id}/reveal`)
  ).json();
  expect(JSON.stringify(revealedProfile)).toContain(secret);
  revealedProfile.name = "Edited private profile";
  expect(
    (
      await request.put(`/api/me/profiles/${id}`, {
        headers,
        data: revealedProfile,
      })
    ).ok(),
  ).toBeTruthy();
  const preview = await request.post("/api/me/profiles/preview", {
    headers,
    data: revealedProfile,
  });
  expect(preview.ok(), await preview.text()).toBeTruthy();
  expect(await preview.text()).not.toContain(secret);
  const publish = await request.post("/api/me/outputs", {
    headers,
    data: {
      id: `secret_output_${suffix}`,
      name: "Private feed",
      profileId: id,
      target: profile.target,
      mode: "full",
    },
  });
  expect(publish.ok(), await publish.text()).toBeTruthy();
  const { feedPath } = await publish.json();
  expect(await (await request.get(feedPath)).text()).toContain(secret);
});
