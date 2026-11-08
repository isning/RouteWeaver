// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ServerRoutesPage } from "./ServerRoutes";
import { hasUnsavedChanges } from "./navigation";
import type { ServerDeployment } from "./types";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "#routes");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(change?: (draft: ServerDeployment) => void) {
  const instance = {
    id: "core",
    hostId: "server",
    name: "Core",
    adapterId: "routeweaver/sing-box",
    version: "1.14.4",
  };
  const listener = {
    id: "entry",
    name: "Policy entry",
    instanceId: instance.id,
    connection: {
      protocol: "socks",
      host: "0.0.0.0",
      port: 1080,
      username: "fixture",
      password: "listener-secret-fixture",
    },
  };
  const deployment: ServerDeployment = {
    id: "policy",
    name: "Policy draft",
    revisionToken: "policy-r1",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "policy",
      topologyRevision: "topology-r1",
      programs: [
        {
          instance,
          listener,
          egress: [],
          connectors: [
            {
              id: "transit",
              connection: {
                protocol: "socks",
                host: "transit.invalid",
                port: 1080,
                username: "fixture",
                password: "connector-secret-fixture",
              },
            },
            {
              id: "exit",
              via: "transit",
              connection: {
                protocol: "vless",
                host: "exit.invalid",
                port: 443,
                uuid: "connector-uuid-fixture",
                tls: { enabled: true, serverName: "exit.invalid" },
              },
            },
          ],
          rules: [
            {
              id: "private",
              match: { op: "resource", value: "private-domains" },
              action: { kind: "forward", ref: "exit" },
            },
            {
              id: "blocked",
              match: { op: "domain", value: "blocked.invalid" },
              action: { kind: "reject" },
            },
          ],
          resources: [
            {
              id: "private-domains",
              name: "Private domains",
              revision: "resource-r1",
              digest: "digest-fixture",
              format: "sing-box-source",
              formatVersion: 3,
              location: "remote",
              url: "https://rules.invalid/private?token=resource-secret-fixture",
              updatePolicy: "manual",
              intervalSeconds: 3600,
            },
          ],
          tls: {
            certificatePath: "/fixtures/server.pem",
            keyPath: "/fixtures/server.key",
          },
          defaultAction: { kind: "reject" },
        },
      ],
    },
  };
  change?.(deployment);
  const requests: string[] = [];
  const saved: ServerDeployment[] = [];
  const saveHeaders: Headers[] = [];
  const unexpected: string[] = [];
  let revealGate: Promise<void> | undefined;
  const summary = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, child) =>
        ["password", "username", "uuid", "privateKeyPem"].includes(key)
          ? undefined
          : child,
      ),
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      requests.push(`${method} ${path}`);
      let value: unknown;
      if (path === "/api/hosts" && method === "GET")
        value = [{ id: "server", name: "Server", address: "server.invalid" }];
      else if (path === "/api/core-instances" && method === "GET")
        value = deployment.ir.programs.map((program) => program.instance);
      else if (path === "/api/managed-endpoints" && method === "GET")
        value = summary(
          deployment.ir.programs.map((program) => program.listener),
        );
      else if (path === "/api/links" && method === "GET") value = [];
      else if (path === "/api/server-deployments" && method === "GET")
        value = summary([saved.at(-1) || deployment]);
      else if (
        path === "/api/server-deployments/policy/reveal" &&
        method === "GET"
      ) {
        if (revealGate) await revealGate;
        value = saved.at(-1) || deployment;
      } else if (
        path === "/api/server-deployments/policy" &&
        method === "PUT"
      ) {
        const next = JSON.parse(String(init?.body));
        saved.push(next);
        saveHeaders.push(new Headers(init?.headers));
        value = { ...summary(next), revisionToken: "policy-r2" };
      } else if (path.endsWith("/state") && method === "GET")
        value = { phase: "unregistered" };
      else {
        unexpected.push(`${method} ${path}`);
        return new Response(
          JSON.stringify({ detail: "Unexpected policy editor request" }),
          { status: 503 },
        );
      }
      return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ServerRoutesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    deployment,
    requests,
    saved,
    saveHeaders,
    unexpected,
    delayReveal: (gate: Promise<void>) => {
      revealGate = gate;
    },
  };
}

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 Policy draft" }),
  );
  return screen.findByRole("dialog", { name: "编辑 Policy draft" });
}

it.each(["Shared core", undefined] as const)(
  "distinguishes same-named listeners on two cores and edits only the selected saved program (core name: %s)",
  async (coreName) => {
    const user = userEvent.setup();
    const fixture = setup((draft) => {
      const first = draft.ir.programs[0];
      first.instance.name = coreName;
      first.listener.name = "Shared entry";
      draft.ir.programs.push({
        ...structuredClone(first),
        instance: { ...first.instance, id: "core-b" },
        listener: { ...first.listener, id: "entry-b", instanceId: "core-b" },
      });
    });
    const editor = await openEditor(user);
    const coreLabel = coreName || "sing-box";
    const firstIdentity = `Shared entry，核心 ${coreLabel}，核心标识 core，监听标识 entry`;
    const secondIdentity = `Shared entry，核心 ${coreLabel}，核心标识 core-b，监听标识 entry-b`;
    const first = within(editor).getByRole("region", {
      name: `${firstIdentity}的策略设置`,
    });
    const second = within(editor).getByRole("region", {
      name: `${secondIdentity}的策略设置`,
    });
    for (const [card, coreID, listenerID] of [
      [first, "core", "entry"],
      [second, "core-b", "entry-b"],
    ] as const) {
      expect(within(card).getByText(coreLabel, { exact: true })).toBeTruthy();
      const identities = within(card).getByRole("group", {
        name: "监听与核心身份",
      });
      expect((identities as HTMLDetailsElement).open).toBe(true);
      expect(
        within(identities).getByText(coreID, { exact: true }),
      ).toBeTruthy();
      expect(
        within(identities).getByText(listenerID, { exact: true }),
      ).toBeTruthy();
    }
    expect(
      within(first).getByRole("button", {
        name: `检查监听更新 ${firstIdentity}`,
      }),
    ).toBeTruthy();
    const selectedDefault = within(second).getByRole("combobox", {
      name: `${secondIdentity} 默认去向`,
    });
    await user.click(selectedDefault);
    await user.click(await screen.findByRole("option", { name: "直连" }));
    expect(
      within(first).getByRole("combobox", { name: `${firstIdentity} 默认去向` })
        .textContent,
    ).toBe("拒绝连接");
    expect(selectedDefault.textContent).toBe("直连");
    expect(fixture.saved).toEqual([]);
    await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(fixture.saved).toHaveLength(1));
    expect(fixture.saved[0].ir.programs).toEqual([
      fixture.deployment.ir.programs[0],
      {
        ...fixture.deployment.ir.programs[1],
        defaultAction: { kind: "direct" },
      },
    ]);
    expect(fixture.unexpected).toEqual([]);
  },
);

it("edits an existing conditional program's default destination and saves only that intent, preserving dependencies and unknown fields", async () => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    Object.assign(draft.ir, { futureEnvelope: { enabled: true } });
    Object.assign(draft.ir.programs[0], {
      futurePolicy: { mode: "retained", entries: [2, 1] },
    });
    Object.assign(draft.ir.programs[0].rules[0], { futureRule: "retained" });
    Object.assign(draft.ir.programs[0].connectors![1], {
      futureConnector: { enabled: false },
    });
  });
  const editor = await openEditor(user);
  expect(within(editor).queryByRole("tab", { name: "图形编辑" })).toBeNull();
  expect(
    within(editor).queryByRole("combobox", { name: /下一跳|第.*跳/ }),
  ).toBeNull();
  await user.click(
    within(editor).getByRole("combobox", { name: "Policy entry 默认去向" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "转发至连接器 exit" }),
  );
  expect(fixture.saved).toEqual([]);
  expect(
    fixture.requests.filter((request) => !request.startsWith("GET ")),
  ).toEqual([]);
  expect(editor.textContent).not.toMatch(
    /listener-secret-fixture|connector-secret-fixture|connector-uuid-fixture|resource-secret-fixture/,
  );
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  const sent = fixture.saved[0];
  expect(sent.ir.programs[0]).toEqual({
    ...fixture.deployment.ir.programs[0],
    defaultAction: { kind: "forward", ref: "exit" },
  });
  expect(sent.ir).toMatchObject({
    schemaVersion: "1.0",
    id: "policy",
    futureEnvelope: { enabled: true },
  });
  expect(sent.ir.topologyRevision).not.toBe("topology-r1");
  expect(fixture.saveHeaders[0].get("If-Match")).toBe("policy-r1");
  expect(
    fixture.requests.filter((request) => !request.startsWith("GET ")),
  ).toEqual(["PUT /api/server-deployments/policy"]);
  expect(fixture.unexpected).toEqual([]);
});

it("keeps an implicit direct default unchanged until the user explicitly chooses a destination", async () => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    const program = draft.ir.programs[0];
    delete program.defaultAction;
    delete program.connectors;
    program.resources = [];
    program.rules = [
      {
        id: "blocked",
        match: { op: "domain", value: "blocked.invalid" },
        action: { kind: "reject" },
      },
    ];
  });
  const editor = await openEditor(user);
  const destination = within(editor).getByRole("combobox", {
    name: "Policy entry 默认去向",
  });
  expect(destination.textContent).toContain("未显式设置（直连）");
  expect(hasUnsavedChanges()).toBe(false);
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs[0]).toEqual(
    fixture.deployment.ir.programs[0],
  );
  expect(fixture.saved[0].ir.programs[0]).not.toHaveProperty("defaultAction");
  expect(fixture.saved[0].ir.topologyRevision).toBe("topology-r1");
  expect(fixture.unexpected).toEqual([]);
});

it("edits one supported rule action while preserving unsupported rules, unknown fields and all other policy sections", async () => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    const program = draft.ir.programs[0];
    Object.assign(program.defaultAction!, { futureDefault: "preserved" });
    Object.assign(program, { futureProgram: { enabled: false } });
    Object.assign(program.rules[1], { futureRule: [2, 1] });
    program.rules.push({
      id: "future-condition",
      match: { op: "future-match", value: "preserved" },
      action: { kind: "direct" },
    });
    program.rules.push({
      id: "future-action",
      match: { op: "domain-suffix", value: "future.invalid" },
      action: { kind: "future-action", ref: "preserved" },
    });
    Object.assign(program.rules[2].match, { futureMatch: { original: true } });
  });
  const editor = await openEditor(user);
  for (const section of ["默认去向", "条件规则", "用户入口", "连接器"]) {
    expect(
      within(editor).getByRole("region", { name: `Policy entry的${section}` }),
    ).toBeTruthy();
  }
  expect(
    within(editor).queryByRole("combobox", { name: "Policy entry 默认去向" }),
  ).toBeNull();
  expect(
    within(editor).queryByRole("combobox", {
      name: "Policy entry 规则 1 去向",
    }),
  ).toBeNull();
  expect(
    within(editor).queryByRole("combobox", {
      name: "Policy entry 规则 3 去向",
    }),
  ).toBeNull();
  expect(
    within(editor).queryByRole("combobox", {
      name: "Policy entry 规则 4 去向",
    }),
  ).toBeNull();
  expect(
    within(editor).getByText("该条件尚未提供去向表单，请在完整 JSON 中修改。", {
      exact: true,
    }),
  ).toBeTruthy();
  await user.click(
    within(editor).getByRole("combobox", { name: "Policy entry 规则 2 去向" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "转发至连接器 exit" }),
  );
  expect(hasUnsavedChanges()).toBe(true);
  expect(fixture.saved).toEqual([]);
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  const expected = structuredClone(fixture.deployment.ir.programs[0]);
  expected.rules[1].action = { kind: "forward", ref: "exit" };
  expect(fixture.saved[0].ir.programs).toEqual([expected]);
  expect(fixture.saveHeaders[0].get("If-Match")).toBe("policy-r1");
  expect(
    fixture.requests.filter((request) => !request.startsWith("GET ")),
  ).toEqual(["PUT /api/server-deployments/policy"]);
  expect(fixture.unexpected).toEqual([]);
});

it.each([
  ["missing", undefined],
  ["null", null],
  ["numeric", 7],
] as const)(
  "keeps a %s rule ID from a JSON draft read-only while an adjacent valid rule remains editable",
  async (_name, invalidID) => {
    const user = userEvent.setup();
    const fixture = setup((draft) => {
      draft.ir.programs[0].rules[0].match = {
        op: "domain",
        value: "private.invalid",
      };
    });
    const editor = await openEditor(user);
    await user.click(
      within(editor).getByRole("button", { name: "编辑转发设置" }),
    );
    const json = await screen.findByRole("dialog", { name: "服务端配置意图" });
    const text = within(json).getByRole("textbox", {
      name: "服务端配置意图 JSON 文本",
    }) as HTMLTextAreaElement;
    const intent = JSON.parse(text.value);
    if (invalidID === undefined) delete intent.programs[0].rules[0].id;
    else intent.programs[0].rules[0].id = invalidID;
    await user.clear(text);
    await user.paste(JSON.stringify(intent));
    await user.click(within(json).getByRole("button", { name: "应用到草稿" }));
    expect(
      within(editor).queryByRole("combobox", {
        name: "Policy entry 规则 1 去向",
      }),
    ).toBeNull();
    expect(
      within(editor).getByText("规则身份缺失或重复，请先在完整 JSON 中修复。"),
    ).toBeTruthy();
    await user.click(
      within(editor).getByRole("combobox", {
        name: "Policy entry 规则 2 去向",
      }),
    );
    await user.click(
      await screen.findByRole("option", { name: "转发至连接器 exit" }),
    );
    expect(fixture.saved).toEqual([]);
    await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(fixture.saved).toHaveLength(1));
    intent.programs[0].rules[1].action = { kind: "forward", ref: "exit" };
    expect(fixture.saved[0].ir.programs).toEqual(intent.programs);
    expect(
      fixture.requests.filter((request) => !request.startsWith("GET ")),
    ).toEqual(["PUT /api/server-deployments/policy"]);
    expect(fixture.unexpected).toEqual([]);
  },
);

it.each([
  ["routeweaver/xray", "26.10.31"],
  ["routeweaver/sing-box", "1.14.4"],
])(
  "edits existing domain, suffix and CIDR rule destinations on %s without changing their conditions or order",
  async (adapterId, version) => {
    const user = userEvent.setup();
    const fixture = setup((draft) => {
      const program = draft.ir.programs[0];
      program.instance.adapterId = adapterId;
      program.instance.version = version;
      program.resources = [];
      program.rules = [
        {
          id: "exact",
          match: { op: "domain", value: "one.invalid" },
          action: { kind: "direct" },
        },
        {
          id: "suffix",
          match: { op: "domain-suffix", value: "two.invalid" },
          action: { kind: "reject" },
        },
        {
          id: "cidr",
          match: { op: "ip-cidr", value: "192.0.2.0/24" },
          action: { kind: "forward", ref: "exit" },
        },
      ];
    });
    const editor = await openEditor(user);
    for (const [index, option] of [
      "拒绝连接",
      "转发至连接器 transit",
      "直连",
    ].entries()) {
      await user.click(
        within(editor).getByRole("combobox", {
          name: `Policy entry 规则 ${index + 1} 去向`,
        }),
      );
      await user.click(await screen.findByRole("option", { name: option }));
    }
    expect(fixture.saved).toEqual([]);
    await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(fixture.saved).toHaveLength(1));
    expect(fixture.saved[0].ir.programs[0]).toEqual({
      ...fixture.deployment.ir.programs[0],
      rules: [
        {
          id: "exact",
          match: { op: "domain", value: "one.invalid" },
          action: { kind: "reject" },
        },
        {
          id: "suffix",
          match: { op: "domain-suffix", value: "two.invalid" },
          action: { kind: "forward", ref: "transit" },
        },
        {
          id: "cidr",
          match: { op: "ip-cidr", value: "192.0.2.0/24" },
          action: { kind: "direct" },
        },
      ],
    });
    expect(
      fixture.requests.filter((request) => !request.startsWith("GET ")),
    ).toEqual(["PUT /api/server-deployments/policy"]);
    expect(fixture.unexpected).toEqual([]);
  },
);

it.each(["默认去向", "规则 2 去向"])(
  "supports keyboard %s changes and keeps the draft after cancelling dismissal, without exposing chain controls",
  async (field) => {
    const user = userEvent.setup();
    const fixture = setup();
    const editor = await openEditor(user);
    const destination = within(editor).getByRole("combobox", {
      name: `Policy entry ${field}`,
    });
    destination.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "直连" });
    await user.keyboard("{Home}{Enter}");
    await waitFor(() => expect(destination.textContent).toBe("直连"));
    expect(hasUnsavedChanges()).toBe(true);
    expect(within(editor).queryByRole("tab", { name: "图形编辑" })).toBeNull();
    expect(
      within(editor).queryByRole("button", { name: /上移第|下移第|移除第/ }),
    ).toBeNull();
    await user.keyboard("{Escape}");
    const confirmation = await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的转发路径修改？",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "继续编辑" }),
    );
    expect(
      within(editor).getByRole("combobox", { name: `Policy entry ${field}` })
        .textContent,
    ).toBe("直连");
    expect(
      fixture.requests.filter((request) => !request.startsWith("GET ")),
    ).toEqual([]);
    await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(fixture.saved).toHaveLength(1));
    expect(
      field === "默认去向"
        ? fixture.saved[0].ir.programs[0].defaultAction
        : fixture.saved[0].ir.programs[0].rules[1].action,
    ).toEqual({ kind: "direct" });
  },
);

it.each([
  [
    "unknown action fields",
    (draft: ServerDeployment) =>
      Object.assign(draft.ir.programs[0].defaultAction!, {
        futureAction: "retained",
      }),
    /此表单无法解释/,
  ],
  [
    "unknown schema",
    (draft: ServerDeployment) => {
      draft.ir.schemaVersion = "2.0";
    },
    /此配置版本/,
  ],
  [
    "unknown runtime",
    (draft: ServerDeployment) => {
      draft.ir.programs[0].instance.version = "future-version";
    },
    /此核心版本/,
  ],
  [
    "legacy egress",
    (draft: ServerDeployment) => {
      draft.ir.programs[0].egress = [
        draft.ir.programs[0].connectors![0].connection,
      ];
      delete draft.ir.programs[0].connectors;
    },
    /此监听使用顺序出口/,
  ],
  [
    "conflicting exits",
    (draft: ServerDeployment) => {
      draft.ir.programs[0].egress = [
        draft.ir.programs[0].connectors![0].connection,
      ];
    },
    /同时存在顺序出口和命名连接器/,
  ],
] as const)(
  "keeps %s read-only with an exact reason and retains it in JSON and save",
  async (_name, change, reason) => {
    const user = userEvent.setup();
    const fixture = setup(change);
    const editor = await openEditor(user);
    expect(
      within(editor).queryByRole("combobox", { name: "Policy entry 默认去向" }),
    ).toBeNull();
    expect(within(editor).getByText(reason)).toBeTruthy();
    if (_name !== "unknown action fields")
      expect(
        within(editor).queryByRole("combobox", { name: /规则 \d+ 去向/ }),
      ).toBeNull();
    await user.click(
      within(editor).getByRole("button", { name: "编辑转发设置" }),
    );
    const json = await screen.findByRole("dialog", { name: "服务端配置意图" });
    const intent = JSON.parse(
      (
        within(json).getByRole("textbox", {
          name: "服务端配置意图 JSON 文本",
        }) as HTMLTextAreaElement
      ).value,
    );
    expect(intent).toEqual(fixture.deployment.ir);
    await user.click(within(json).getByRole("button", { name: "取消" }));
    await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(fixture.saved).toHaveLength(1));
    expect(fixture.saved[0].ir).toEqual(fixture.deployment.ir);
    expect(fixture.unexpected).toEqual([]);
  },
);

it.each(["routeweaver/managed-xray", "routeweaver/sing-box"])(
  "keeps %s principal decisions, credentials and accounting scope read-only without claiming their origin",
  async (adapterId) => {
    const user = userEvent.setup();
    const fixture = setup((draft) => {
      const program = draft.ir.programs[0];
      program.instance.adapterId = adapterId;
      program.instance.version =
        adapterId === "routeweaver/managed-xray" ? "26.3.27-rw1" : "1.14.4";
      program.listener.authentication = "principals";
      program.destinationPolicy = { allowCidrs: ["127.0.0.1/32"] };
      program.principals = [
        {
          subjectId: "subject",
          accountId: "alice",
          routeId: "route-a",
          credentialVersion: "credential-r1",
          credential: { uuid: "principal-secret-fixture" },
          action: { kind: "forward", ref: "exit" },
          policyRevision: "policy-identity",
          cycleId: "cycle-identity",
        },
      ];
    });
    const editor = await openEditor(user);
    expect(
      within(editor).queryByRole("combobox", { name: "Policy entry 默认去向" }),
    ).toBeNull();
    expect(
      within(editor).getByText(/此监听关联用户入口或托管计量/),
    ).toBeTruthy();
    expect(
      within(editor).queryByRole("combobox", { name: /规则 \d+ 去向/ }),
    ).toBeNull();
    if (adapterId === "routeweaver/managed-xray") {
      expect(
        within(editor).getByText("此 Xray 核心不支持该条件，检查不会通过。", {
          exact: true,
        }),
      ).toBeTruthy();
      expect(
        within(editor).getByText("此 Xray 核心不支持规则资源，检查不会通过。", {
          exact: true,
        }),
      ).toBeTruthy();
    }
    const principals = within(editor).getByRole("region", {
      name: "Policy entry的用户入口",
    });
    expect(within(principals).getByText("账号 alice")).toBeTruthy();
    expect(within(principals).getByText("线路 route-a")).toBeTruthy();
    expect(within(principals).queryByRole("textbox")).toBeNull();
    expect(principals.textContent).not.toMatch(/平台生成|由线路维护/);
    expect(editor.textContent).not.toMatch(
      /principal-secret-fixture|policy-identity|cycle-identity|resource-secret-fixture/,
    );
    await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(fixture.saved).toHaveLength(1));
    expect(fixture.saved[0].ir).toEqual(fixture.deployment.ir);
    expect(fixture.unexpected).toEqual([]);
  },
);

it("does not offer a cyclic or unresolved connector as a valid new destination", async () => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    const program = draft.ir.programs[0];
    program.connectors![0].via = "exit";
    program.connectors!.push({
      id: "missing-upstream",
      via: "absent",
      connection: { protocol: "socks", host: "target.invalid", port: 1080 },
    });
    program.defaultAction = { kind: "forward", ref: "not-found" };
  });
  const editor = await openEditor(user);
  const destination = within(editor).getByRole("combobox", {
    name: "Policy entry 默认去向",
  });
  expect(destination.textContent).toContain("连接器不可用：not-found");
  await user.click(destination);
  expect(
    (
      await screen.findByRole("option", { name: "转发至连接器 exit" })
    ).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(
    screen
      .getByRole("option", { name: "转发至连接器 missing-upstream" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await user.click(screen.getByRole("option", { name: "拒绝连接" }));
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs[0]).toEqual({
    ...fixture.deployment.ir.programs[0],
    defaultAction: { kind: "reject" },
  });
});

it.each(["默认去向", "规则 2 去向"])(
  "merges a delayed TLS file read without overwriting a newer %s edit",
  async (field) => {
    const user = userEvent.setup();
    const fixture = setup((draft) => {
      draft.ir.programs[0].listener.connection.tls = { enabled: true };
    });
    const editor = await openEditor(user);
    await user.click(
      within(editor).getByRole("button", { name: "TLS 证书与安全参数" }),
    );
    let release!: (value: string) => void;
    const delayed = new Promise<string>((resolve) => {
      release = resolve;
    });
    const certificate = new File(["old-certificate"], "certificate.pem", {
      type: "application/x-pem-file",
    });
    Object.defineProperty(certificate, "text", { value: () => delayed });
    await user.upload(
      within(editor).getByLabelText("读取 TLS 证书"),
      certificate,
    );
    expect(
      (
        within(editor).getByRole("button", {
          name: "保存草稿",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(
      within(editor).getByRole("combobox", { name: `Policy entry ${field}` }),
    );
    await user.click(await screen.findByRole("option", { name: "直连" }));
    expect(
      (
        within(editor).getByRole("button", {
          name: "保存草稿",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => release("new-certificate-fixture"));
    expect(
      (
        within(editor).getByRole("button", {
          name: "保存草稿",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(fixture.saved).toHaveLength(1));
    expect(fixture.saved[0].ir.programs[0]).toEqual({
      ...fixture.deployment.ir.programs[0],
      ...(field === "默认去向"
        ? { defaultAction: { kind: "direct" } }
        : {
            rules: [
              fixture.deployment.ir.programs[0].rules[0],
              {
                ...fixture.deployment.ir.programs[0].rules[1],
                action: { kind: "direct" },
              },
            ],
          }),
      tls: {
        ...fixture.deployment.ir.programs[0].tls,
        certificatePem: "new-certificate-fixture",
      },
    });
  },
);

it("does not reopen a delayed policy reveal after newer same-page navigation", async () => {
  const user = userEvent.setup();
  const fixture = setup();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.delayReveal(delayed);
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 Policy draft" }),
  );
  await act(async () => {
    history.replaceState(null, "", "#routes?deployment=missing");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await act(async () => release());
  expect(
    screen.queryByRole("dialog", { name: "编辑 Policy draft" }),
  ).toBeNull();
  expect(
    fixture.requests.filter((request) => !request.startsWith("GET ")),
  ).toEqual([]);
});


it.each([
  ["routeweaver/sing-box", "1.14.4"],
  ["routeweaver/xray", "26.10.31"],
])("edits leaf conditions on %s without replacing rule identity, actions or unknown policy data", async (adapterId, version) => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    const program = draft.ir.programs[0];
    program.instance = { ...program.instance, adapterId, version };
    Object.assign(program, { futureProgram: { keep: true } });
    Object.assign(program.rules[1], { futureRule: [1, 2] });
    program.rules[1].match.children = [];
    program.rules.push({ id: "extension", match: { op: "domain", value: "keep.invalid" }, action: { kind: "direct" } });
    Object.assign(program.rules[2].match, { futureMatch: "keep" });
  });
  const editor = await openEditor(user);
  expect(within(editor).queryByRole("textbox", { name: "Policy entry 规则 1 条件值" })).toBeNull();
  expect(within(editor).queryByRole("textbox", { name: "Policy entry 规则 3 条件值" })).toBeNull();
  const input = within(editor).getByRole("textbox", { name: "Policy entry 规则 2 条件值" });
  await user.clear(input);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect((within(editor).getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(input, "changed.invalid");
  await user.click(within(editor).getByRole("combobox", { name: "Policy entry 规则 2 条件类型" }));
  await user.click(await screen.findByRole("option", { name: "域名后缀" }));
  expect(hasUnsavedChanges()).toBe(true);
  expect(fixture.saved).toEqual([]);
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  const expected = structuredClone(fixture.deployment.ir.programs[0]);
  expected.rules[1].match = { op: "domain-suffix", value: "changed.invalid", children: [] };
  expect(fixture.saved[0].ir.programs).toEqual([expected]);
  expect(fixture.saveHeaders[0].get("If-Match")).toBe("policy-r1");
  expect(fixture.requests.filter((request) => !request.startsWith("GET "))).toEqual(["PUT /api/server-deployments/policy"]);
  expect(fixture.unexpected).toEqual([]);
});

it.each([
  ["domain", "bad domain", "good.invalid"],
  ["domain-suffix", "https://bad.invalid", "good.invalid"],
  ["ip-cidr", "192.0.2.0/33", "192.0.2.7/24"],
  ["ip-cidr", "2001:db8::/129", "2001:db8::1/32"],
  ["ip-cidr", "1:2:3:4:5:6:7:8::/64", "::ffff:192.0.2.7/128"],
  ["ip-cidr", "192.00.2.0/24", "::/0"],
])("keeps invalid %s edits visible, blocks save, and accepts a corrected literal", async (op, invalid, valid) => {
  const user = userEvent.setup();
  const fixture = setup((draft) => { draft.ir.programs[0].rules[1].match = { op, value: valid }; });
  const editor = await openEditor(user);
  const input = within(editor).getByRole("textbox", { name: "Policy entry 规则 2 条件值" });
  await user.clear(input);
  await user.type(input, invalid);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const save = within(editor).getByRole("button", { name: "保存草稿" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await user.click(save);
  expect(fixture.saved).toEqual([]);
  await user.clear(input);
  await user.type(input, valid);
  expect(input.getAttribute("aria-invalid")).toBe("false");
  await user.click(save);
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs[0].rules[1].match).toEqual({ op, value: valid });
});


it.each(["null", "omitted"])("retains %s rules in a connector-only policy while editing its default", async (shape) => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    if (shape === "null") Object.assign(draft.ir.programs[0], { rules: null });
    else Reflect.deleteProperty(draft.ir.programs[0], "rules");
  });
  const editor = await openEditor(user);
  await user.click(within(editor).getByRole("combobox", { name: "Policy entry 默认去向" }));
  await user.click(await screen.findByRole("option", { name: "直连" }));
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs).toEqual([{ ...fixture.deployment.ir.programs[0], defaultAction: { kind: "direct" } }]);
});


it("edits a connector address and upstream through the policy page while preserving references and security fields", async () => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    Object.assign(draft.ir.programs[0].connectors![1].connection, { futureConnection: { retain: true } });
    Object.assign(draft.ir.programs[0].connectors![1], { futureConnector: [2, 1] });
  });
  const editor = await openEditor(user);
  const host = within(editor).getByRole("textbox", { name: "Policy entry 连接器 2 地址" });
  await user.clear(host);
  const save = within(editor).getByRole("button", { name: "保存草稿" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await user.type(host, "updated-exit.invalid");
  await user.click(within(editor).getByRole("combobox", { name: "Policy entry 连接器 2 上游连接器" }));
  await user.click(await screen.findByRole("option", { name: "无上游连接器" }));
  expect(hasUnsavedChanges()).toBe(true);
  expect(fixture.saved).toEqual([]);
  await user.click(within(editor).getByRole("button", { name: "编辑转发设置" }));
  const json = await screen.findByRole("dialog", { name: "服务端配置意图" });
  const intent = JSON.parse((within(json).getByRole("textbox", { name: "服务端配置意图 JSON 文本" }) as HTMLTextAreaElement).value);
  const expected = structuredClone(fixture.deployment.ir.programs[0]);
  expected.connectors![1].connection.host = "updated-exit.invalid";
  delete expected.connectors![1].via;
  expect(intent.programs).toEqual([expected]);
  await user.click(within(json).getByRole("button", { name: "取消" }));
  await user.click(save);
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs).toEqual([expected]);
  expect(fixture.saveHeaders[0].get("If-Match")).toBe("policy-r1");
  expect(fixture.requests.filter((request) => !request.startsWith("GET "))).toEqual(["PUT /api/server-deployments/policy"]);
});

it("adds, reorders and confirms removal of supported rules without changing surviving IDs or connector references", async () => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    draft.ir.programs[0].rules[0].match = { op: "domain-suffix", value: "first.invalid" };
  });
  const editor = await openEditor(user);
  await user.click(within(editor).getByRole("button", { name: "Policy entry 新增规则" }));
  const input = within(editor).getByRole("textbox", { name: "Policy entry 规则 3 条件值" });
  expect((within(editor).getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(input, "added.invalid");
  await user.click(within(editor).getByRole("button", { name: "Policy entry 规则 3 上移" }));
  expect((within(editor).getByRole("textbox", { name: "Policy entry 规则 2 条件值" }) as HTMLInputElement).value).toBe("added.invalid");
  await user.click(within(editor).getByRole("button", { name: "Policy entry 删除规则 3" }));
  let confirmation = await screen.findByRole("alertdialog", { name: "删除规则 3？" });
  expect(confirmation.textContent).toContain("后续规则");
  await user.click(within(confirmation).getByRole("button", { name: "保留规则" }));
  expect(within(editor).getByRole("textbox", { name: "Policy entry 规则 3 条件值" })).toBeTruthy();
  await user.click(within(editor).getByRole("button", { name: "Policy entry 删除规则 3" }));
  confirmation = await screen.findByRole("alertdialog", { name: "删除规则 3？" });
  await user.click(within(confirmation).getByRole("button", { name: "删除规则" }));
  await waitFor(() => expect(document.activeElement).toBe(within(editor).getByRole("combobox", { name: "Policy entry 规则 2 条件类型" })));
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs).toEqual([{
    ...fixture.deployment.ir.programs[0],
    rules: [fixture.deployment.ir.programs[0].rules[0], { id: "rule-1", match: { op: "domain", value: "added.invalid" }, action: { kind: "reject" } }],
  }]);
  expect(fixture.saveHeaders[0].get("If-Match")).toBe("policy-r1");
});

it("keeps rule-list operations read-only for unknown rule extensions while allowing a supported condition patch", async () => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    draft.ir.programs[0].rules[0].match = { op: "domain", value: "first.invalid" };
    Object.assign(draft.ir.programs[0].rules[0], { futureRule: { preserve: true } });
  });
  const editor = await openEditor(user);
  expect(within(editor).queryByRole("button", { name: "Policy entry 新增规则" })).toBeNull();
  expect(within(editor).queryByRole("button", { name: /Policy entry 删除规则/ })).toBeNull();
  const input = within(editor).getByRole("textbox", { name: "Policy entry 规则 2 条件值" });
  await user.clear(input);
  await user.type(input, "changed.invalid");
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs[0].rules[0]).toEqual(fixture.deployment.ir.programs[0].rules[0]);
});

it("generates a rule identity without colliding with existing rule identities", async () => {
  const user = userEvent.setup();
  const fixture = setup((draft) => {
    const rules = draft.ir.programs[0].rules;
    rules[0].id = "rule-1";
    rules[0].match = { op: "domain", value: "first.invalid" };
    rules[1].id = "rule-2";
  });
  const editor = await openEditor(user);
  expect((within(editor).getByRole("button", { name: "Policy entry 规则 1 上移" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(editor).getByRole("button", { name: "Policy entry 新增规则" }));
  await user.type(within(editor).getByRole("textbox", { name: "Policy entry 规则 3 条件值" }), "new.invalid");
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs[0].rules.map(rule => rule.id)).toEqual(["rule-1", "rule-2", "rule-3"]);
});

it.each([false, 0, ""])("does not replace malformed rules %s with a new list", async (rules) => {
  const user = userEvent.setup();
  const fixture = setup((draft) => { Object.assign(draft.ir.programs[0], { rules }); });
  const editor = await openEditor(user);
  expect(within(editor).queryByRole("button", { name: "Policy entry 新增规则" })).toBeNull();
  await user.click(within(editor).getByRole("combobox", { name: "Policy entry 默认去向" }));
  await user.click(await screen.findByRole("option", { name: "直连" }));
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(fixture.saved).toHaveLength(1));
  expect(fixture.saved[0].ir.programs).toEqual([{ ...fixture.deployment.ir.programs[0], defaultAction: { kind: "direct" } }]);
});
