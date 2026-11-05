// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserGroups } from "./AccessPolicy";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import { entitlementEditFixture } from "./test-support/entitlement-edit-fixture";
import { groupEditFixture } from "./test-support/group-edit-fixture";
import type { Service } from "./types";
import type { ReactNode } from "react";
import type { EffectivePolicy } from "./access-policy-model";
import { UserPolicyForm } from "./UserPolicyEditor";
import { ServicePolicyEditor } from "./ServicePolicyEditor";

const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const service = {
  id: "plan-a",
  name: "Standard",
  quotaBytes: 107374182400,
  routeIds: [],
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  cycle: {
    mode: "none" as const,
    anchor: "2026-01-01T00:00:00Z",
    timezone: "UTC+8",
  },
};

const serviceFixture = serviceEditFixture(service);
const groupFixture = groupEditFixture({
  id: "g1",
  name: "Family",
  serviceId: "plan-a",
  priority: 1,
  memberIds: [],
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("keeps the group preview action name stable and exposes busy state while its response is held", async (context) => {
  const owner = ownedClickScenario(context);
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let requestHeld = false;
  let responseReleased = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/access-policy/edit-context/group/"))
        return json(groupFixture.context());
      if (String(url).endsWith("/user-groups"))
        return json([
          {
            id: "g1",
            name: "Family",
            serviceId: "plan-a",
            priority: 1,
            memberIds: [],
          },
        ]);
      if (String(url).endsWith("/access-policy/preview")) {
        requestHeld = true;
        return pending;
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  owner.assertActive();
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <UserGroups users={[]} services={[service]} routes={[]} />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  try {
    const edit = await screen.findByRole("button", { name: "编辑 Family" });
    owner.assertActive();
    await user.click(edit);
    owner.assertActive();
    const button = await screen.findByRole("button", { name: "预览影响" });
    await user.click(button);
    owner.assertActive();
    // Establish the held HTTP response and the real rendered loading state before
    // asserting the public action contract. A setup failure is not a useful RED.
    await waitFor(() => {
      expect(requestHeld).toBe(true);
      expect(responseReleased).toBe(false);
      expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
    });
    owner.assertActive();
    const named = screen.queryAllByRole("button", { name: "预览影响" });
    const observed = {
      stableName: named.length === 1 && named[0] === button,
      busy: button.getAttribute("aria-busy"),
    };
    console.info(
      "POLICY_ACTION_HELD_CONTRACT",
      JSON.stringify({
        action: "group-preview",
        requestHeld,
        responseReleased,
        loading: !!button.querySelector('[data-slot="spinner"]'),
        connected: button.isConnected,
        ...observed,
      }),
    );
    expect(
      observed,
      "POLICY_ACTION_HELD_CONTRACT: group-preview stable name and busy state",
    ).toEqual({ stableName: true, busy: "true" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    await user.click(button);
    await user.keyboard("{Enter} ");
    await act(async () => { fireEvent.submit(button.closest("form")!); });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/access-policy/preview"))).toHaveLength(1);
    expect(document.activeElement).toBe(button);
  } finally {
    responseReleased = true;
    await act(async () => {
      release(
        json(
          groupFixture.preview(groupFixture.context().record.group, {
            revision: "held-preview",
            affected: [],
            blockers: [],
          }),
        ),
      );
    });
  }
  owner.assertActive();
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  await user.click(within(review).getByRole("button", { name: "返回编辑" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "预览影响" })));
  owner.assertActive();
});

function mountActionContract(
  owner: ReturnType<typeof ownedClickScenario>,
  children: ReactNode,
) {
  owner.assertActive();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
}

function expectNamedAction(button: HTMLElement, name: string, busy: boolean) {
  expect(button.isConnected).toBe(true);
  if (button.closest('[aria-hidden="true"]')) {
    expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBe(name);
    expect(screen.queryAllByRole("button", { name })).toEqual([]);
  } else expect(screen.queryAllByRole("button", { name })).toEqual([button]);
  expect(button.getAttribute("aria-busy") === "true").toBe(busy);
}

const initialPolicy: EffectivePolicy = {
  userId: "u1",
  groupIds: [],
  routeIds: [],
  quotaBytes: 0,
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  status: "active",
  provenance: { service: "none" },
  entitlement: {
    userId: "u1",
    startsAt: "2026-01-01T00:00:00Z",
    cycle: service.cycle,
  },
};

const entitlementFixture = entitlementEditFixture(initialPolicy);

it("keeps the user preview action name stable and clears busy state after its held response settles", async (context) => {
  const owner = ownedClickScenario(context);
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let requestHeld = false;
  let responseReleased = false;
  try {
    owner.assertActive();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        entitlementFixture.transport(async (url) => {
          if (String(url).endsWith("/access-policy/preview")) {
            requestHeld = true;
            return pending;
          }
          throw new Error(`Unexpected request: ${String(url)}`);
        }),
      ),
    );
    mountActionContract(
      owner,
      <UserPolicyForm
        user={{
          id: "u1",
          name: "Alice",
          enabled: true,
          quotaBytes: 0,
          usedBytes: 0,
        }}
        initial={entitlementFixture.context()}
        services={[service]}
        routes={[]}
        onClose={() => {}}
      />,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "预览影响" });
    expectNamedAction(button, "预览影响", false);
    await user.click(button);
    owner.assertActive();
    await waitFor(() => {
      expect(requestHeld).toBe(true);
      expect(responseReleased).toBe(false);
      expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
    });
    owner.assertActive();
    expectNamedAction(button, "预览影响", true);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    await user.click(button);
    await user.keyboard("{Enter} ");
    await act(async () => { fireEvent.submit(button.closest("form")!); });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/access-policy/preview"))).toHaveLength(1);
    expect(document.activeElement).toBe(button);
    responseReleased = true;
    await act(async () => {
      release(
        json({ revision: "user-held-preview", affected: [], blockers: [] }),
      );
    });
    owner.assertActive();
    await screen.findByRole("dialog", { name: "确认授权变更" });
    owner.assertActive();
    await waitFor(() => {
      expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
      expectNamedAction(button, "预览影响", false);
    });
    owner.assertActive();
    await user.click(within(screen.getByRole("dialog", { name: "确认授权变更" })).getByRole("button", { name: "返回编辑" }));
    await waitFor(() => expect(document.activeElement).toBe(button));
    owner.assertActive();
  } finally {
    responseReleased = true;
    await act(async () => {
      release(
        json({ revision: "user-held-preview", affected: [], blockers: [] }),
      );
    });
  }
});

it("keeps the service preview action name stable and clears busy state after its held response settles", async (context) => {
  const owner = ownedClickScenario(context);
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let requestHeld = false;
  let responseReleased = false;
  let submitted: Service | undefined;
  const heldReview = () =>
    submitted
      ? json(
          serviceFixture.preview(submitted, {
            revision: "service-held-preview",
            affected: [],
            blockers: [],
          }),
        )
      : json({ detail: "Retired unsubmitted service fixture" }, 503);
  try {
    owner.assertActive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("/access-policy/edit-context/service/"))
          return json(serviceFixture.context());
        if (String(url).endsWith("/access-policy/preview")) {
          const envelope = JSON.parse(init!.body as string);
          expect(envelope.precondition).toEqual(
            serviceFixture.context().precondition,
          );
          submitted = envelope.change.service;
          requestHeld = true;
          return pending;
        }
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    mountActionContract(
      owner,
      <ServicePolicyEditor
        initial={service}
        users={[]}
        services={[service]}
        routes={[]}
        onClose={() => {}}
      />,
    );
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "预览影响" });
    owner.assertActive();
    expectNamedAction(button, "预览影响", false);
    await user.click(button);
    owner.assertActive();
    await waitFor(() => {
      expect(requestHeld).toBe(true);
      expect(responseReleased).toBe(false);
      expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
    });
    owner.assertActive();
    expectNamedAction(button, "预览影响", true);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    await user.click(button);
    await user.keyboard("{Enter} ");
    await act(async () => { fireEvent.submit(button.closest("form")!); });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/access-policy/preview"))).toHaveLength(1);
    expect(document.activeElement).toBe(button);
    responseReleased = true;
    await act(async () => {
      release(heldReview());
    });
    owner.assertActive();
    await screen.findByRole("dialog", { name: "确认授权变更" });
    owner.assertActive();
    await waitFor(() => {
      expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
      expectNamedAction(button, "预览影响", false);
    });
    owner.assertActive();
    await user.click(within(screen.getByRole("dialog", { name: "确认授权变更" })).getByRole("button", { name: "返回编辑" }));
    await waitFor(() => expect(document.activeElement).toBe(button));
    owner.assertActive();
  } finally {
    responseReleased = true;
    await act(async () => {
      release(heldReview());
    });
  }
});

it("keeps the common apply action name stable and clears busy state after a held rejection without losing review", async (context) => {
  const owner = ownedClickScenario(context);
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let requestHeld = false;
  let responseReleased = false;
  const rejected = () =>
    new Response(
      JSON.stringify({ detail: "Policy was not saved; review is retained." }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  try {
    owner.assertActive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/access-policy/edit-context/group/"))
          return json(groupFixture.context());
        if (String(url).endsWith("/user-groups"))
          return json([
            {
              id: "g1",
              name: "Family",
              serviceId: "plan-a",
              priority: 1,
              memberIds: [],
            },
          ]);
        if (String(url).endsWith("/access-policy/preview"))
          return json(
            groupFixture.preview(groupFixture.context().record.group, {
              revision: "apply-held-review",
              affected: [],
              blockers: [],
            }),
          );
        if (String(url).endsWith("/access-policy/apply")) {
          requestHeld = true;
          return pending;
        }
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    mountActionContract(
      owner,
      <UserGroups users={[]} services={[service]} routes={[]} />,
    );
    const user = userEvent.setup();
    const edit = await screen.findByRole("button", { name: "编辑 Family" });
    owner.assertActive();
    await user.click(edit);
    owner.assertActive();
    await user.click(await screen.findByRole("button", { name: "预览影响" }));
    owner.assertActive();
    const review = await screen.findByRole("dialog", { name: "确认授权变更" });
    owner.assertActive();
    await user.click(screen.getByRole("checkbox", { name: /我已核对/ }));
    owner.assertActive();
    const button = screen.getByRole("button", { name: "更新授权" });
    expectNamedAction(button, "更新授权", false);
    await user.click(button);
    owner.assertActive();
    await waitFor(() => {
      expect(requestHeld).toBe(true);
      expect(responseReleased).toBe(false);
      expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
    });
    owner.assertActive();
    expectNamedAction(button, "更新授权", true);
    responseReleased = true;
    await act(async () => {
      release(rejected());
    });
    owner.assertActive();
    await within(review).findByText(
      "Policy was not saved; review is retained.",
    );
    owner.assertActive();
    await waitFor(() => {
      expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
      expectNamedAction(button, "更新授权", false);
    });
    owner.assertActive();
    expect(screen.getByRole("dialog", { name: "确认授权变更" })).toBe(review);
  } finally {
    responseReleased = true;
    await act(async () => {
      release(rejected());
    });
  }
});
