// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type TestContext,
} from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { useRef } from "react";
import {
  AppForm,
  AppField,
  type AppFormSubmitHandle,
  useForm,
} from "./ui-patterns/form";
import { Input } from "./components/ui/input";
import { UIProviders } from "./ui-patterns/providers";
import { setCSRF, setToken } from "./api";
import { entitlementEditFixture } from "./test-support/entitlement-edit-fixture";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

let currentContext: TestContext;
beforeEach((context) => {
  currentContext = context;
});
const clients: QueryClient[] = [];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setCSRF("");
  setToken("");
});

it("returns an invalid personal service preview to its choice while retaining the pause draft in the actual workspace", async (context) => {
  const owner = ownedClickScenario(currentContext);
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#users");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const user = {
    id: "alice",
    name: "Alice",
    enabled: true,
    quotaBytes: 0,
    usedBytes: 0,
  };
  const entitlement = {
    userId: user.id,
    startsAt: "2026-01-01T00:00:00Z",
    paused: false,
    cycle: {
      mode: "monthly",
      day: 1,
      anchor: "2026-01-01T00:00:00Z",
      timezone: "UTC+8",
    },
  };
  const fixture = entitlementEditFixture({
    userId: user.id,
    groupIds: [],
    routeIds: [],
    quotaBytes: 0,
    onlineIpLimit: 0,
    connectionLimit: 0,
    entryRateBps: 0,
    status: "active",
    provenance: {},
    entitlement,
  });
  const unexpected: string[] = [],
    writes: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input),
        method = init?.method || "GET";
      if (method !== "GET") {
        const body = JSON.parse(String(init?.body));
        writes.push({ url, body });
        if (method === "POST" && url === "/api/access-policy/preview")
          return json(
            fixture.preview(body.change.entitlement, {
              revision: "preview-1",
              affected: [],
              blockers: [],
            }),
          );
        throw new Error("Unexpected write");
      }
      if (url === "/api/auth/me")
        return json({
          user: { id: "admin", name: "Admin", role: "admin" },
          csrfToken: "fixture",
        });
      if (url === "/api/state")
        return json({
          nodes: [],
          users: [user],
          routes: [],
          revisions: [],
          capabilities: [],
        });
      if (url === "/api/settings")
        return json({ name: "Policy fixture", registration: "invite" });
      if (
        [
          "/api/published-routes",
          "/api/services",
          "/api/rates",
          "/api/user-groups",
        ].includes(url)
      )
        return json([]);
      if (url === "/api/access-policy/edit-context/entitlement/alice")
        return json(fixture.context());
      if (url === "/api/users/alice/admission-status")
        return json({
          asOf: entitlement.startsAt,
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      unexpected.push(`${method} ${url}`);
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  render(
    <UIProviders>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </UIProviders>,
  );
  await screen.findByRole("main");
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  owner.assertActive();
  await owner.click(() =>
    screen.findByRole("button", { name: "更多操作 Alice" }),
  );
  await owner.click(() => screen.getByRole("menuitem", { name: "授权与续期" }));
  await screen.findByLabelText("开通时间");
  owner.assertActive();
  const ui = within(screen.getByRole("dialog", { name: "Alice 的服务授权" }));
  await owner.click(() => ui.getByRole("switch", { name: "暂停平台服务" }));
  await owner.click(() => ui.getByRole("radio", { name: "指定个人方案" }));
  const choice = ui.getByRole("combobox", { name: "个人指定方案" });
  const preview = ui.getByRole("button", {
    name: "预览影响",
  }) as HTMLButtonElement;
  expect(preview.type).toBe("button");
  expect(preview.form?.checkValidity()).toBe(true);
  await owner.click(() => preview);
  await ui.findByText("请选择个人方案，或切换为继承用户组方案");
  owner.assertActive();
  expect(choice.getAttribute("aria-invalid")).toBe("true");
  expect(
    ui
      .getByRole("switch", { name: "暂停平台服务" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    ui
      .getByRole("radio", { name: "指定个人方案" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  await waitFor(() => expect(document.activeElement).toBe(choice));
  owner.assertActive();
  await owner.click(() => preview);
  await waitFor(() => expect(document.activeElement).toBe(choice));
  owner.assertActive();
  expect(writes).toEqual([]);
  await owner.click(() => ui.getByRole("radio", { name: "继承用户组方案" }));
  await owner.click(() => preview);
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    url: "/api/access-policy/preview",
    body: {
      precondition: { exists: true, revision: "opened-entitlement-alice" },
      change: { entitlement: { userId: "alice", serviceId: "", paused: true } },
    },
  });
  await owner.click(() =>
    within(review).getByRole("button", { name: "返回编辑" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull(),
  );
  owner.assertActive();
  expect(
    ui
      .getByRole("switch", { name: "暂停平台服务" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await owner.click(() => ui.getByRole("button", { name: "取消" }));
  const discard = await screen.findByRole("alertdialog", {
    name: "放弃尚未保存的授权修改？",
  });
  await owner.click(() =>
    within(discard).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Alice 的服务授权" }),
    ).toBeNull(),
  );
  owner.assertActive();
  await owner.click(() =>
    screen.getByRole("button", { name: "更多操作 Alice" }),
  );
  await owner.click(() => screen.getByRole("menuitem", { name: "授权与续期" }));
  await screen.findByLabelText("开通时间");
  owner.assertActive();
  const fresh = within(
    screen.getByRole("dialog", { name: "Alice 的服务授权" }),
  );
  expect(
    fresh
      .getByRole("switch", { name: "暂停平台服务" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  await owner.click(() => fresh.getByRole("radio", { name: "指定个人方案" }));
  await owner.click(() => fresh.getByRole("button", { name: "预览影响" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      fresh.getByRole("combobox", { name: "个人指定方案" }),
    ),
  );
  owner.assertActive();
  expect(writes).toHaveLength(1);
  expect(unexpected).toEqual([]);
});

// Shared public imperative seam: isolated async validation ownership, not App/keyboard evidence.
function ImperativeForm({
  task,
  disabled = false,
  validator,
  plainSubmit = false,
}: {
  task: object | null;
  plainSubmit?: boolean;
  disabled?: boolean;
  validator?: () => Promise<void>;
}) {
  const submit = useRef<AppFormSubmitHandle>(null);
  const [form] = useForm();
  return (
    <>
      <AppForm
        form={form}
        submitErrorFocusOwner={task}
        submitWithErrorFocusRef={submit}
        disabled={disabled}
      >
        <AppField
          name="name"
          label="Name"
          rules={
            validator
              ? [{ validator }]
              : [{ required: true, message: "Name required" }]
          }
        >
          <Input />
        </AppField>
        <button
          type="button"
          onClick={() =>
            plainSubmit ? form.submit() : submit.current?.submit()
          }
        >
          Preview
        </button>
      </AppForm>
      <button>Other task</button>
    </>
  );
}
it.each(["null owner", "disabled form", "plain imperative submit"])(
  "does not recover imperative validation focus for %s",
  async (mode) => {
    const owner = ownedClickScenario(currentContext);
    render(
      <ImperativeForm
        task={mode === "null owner" ? null : {}}
        disabled={mode === "disabled form"}
        plainSubmit={mode === "plain imperative submit"}
      />,
    );
    await owner.click(() => screen.getByRole("button", { name: "Preview" }));
    await screen.findByText("Name required");
    owner.assertActive();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Preview" }),
    );
  },
);
it.each(["newer interaction", "task replacement", "owner retired"])(
  "drops held imperative validation focus after %s",
  async (mode) => {
    const owner = ownedClickScenario(currentContext);
    let reject!: (error: Error) => void;
    const validator = () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    const task = {};
    const mounted = render(
      <ImperativeForm task={task} validator={validator} />,
    );
    await owner.click(() => screen.getByRole("button", { name: "Preview" }));
    if (mode === "newer interaction") {
      await owner.click(() =>
        screen.getByRole("button", { name: "Other task" }),
      );
      act(() => screen.getByRole("button", { name: "Preview" }).focus());
    } else
      mounted.rerender(
        <ImperativeForm
          task={mode === "owner retired" ? null : {}}
          validator={validator}
        />,
      );
    const focused = document.activeElement;
    await act(async () => reject(new Error("Held invalid name")));
    owner.assertActive();
    await screen.findByText("Held invalid name");
    owner.assertActive();
    expect(document.activeElement).toBe(focused);
  },
);
