// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionsPage, UpdateOutput } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Profile } from "./types";

const scopeNote =
  "比较使用当前已应用的来源内容；手动模式的更新需先应用到来源，再重新比较。";
const profile: Profile = {
  ...emptyProfile(),
  id: "profile",
  name: "Daily routing",
  sourceIds: ["accepted-source"],
};
const output = {
  id: "phone",
  name: "Phone",
  profileId: profile.id,
  target: profile.target,
  mode: "full",
  status: "published",
};
const emptyCategory = {
  state: "available",
  beforeCount: 0,
  afterCount: 0,
  changedCount: 0,
  rows: [],
  omittedRowCount: 0,
};
const clients: QueryClient[] = [];
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  history.replaceState(null, "", "#subscriptions");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function check(
  profileRecord: Profile | null = profile,
  changed: boolean | null = false,
) {
  const requests: { path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = String(input),
        method = init?.method || "GET";
      requests.push({ path, method });
      if (path === "/api/me/overview")
        return json({ status: "active", routes: [] });
      if (path === "/api/me/profiles")
        return json(profileRecord ? [profileRecord] : []);
      if (method === "GET" && path === "/api/me/outputs/independent") return json({ items: [] });
      if (path === "/api/me/outputs") return json([output]);
      if (path === "/api/me/profiles/profile/preview")
        return json({
          valid: true,
          outputId: output.id,
          previewScope: "output-update",
          previewDigest: "a".repeat(64),
          publicationEffect: { version: 1, link: "preserve" },
          artifacts: [],
          semanticChanges:
            changed === null
              ? undefined
              : {
                  version: 1,
                  renderedConfigurationChanged: changed,
                  groups: emptyCategory,
                  nodes: emptyCategory,
                },
        });
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {profileRecord === null ? (
          <UpdateOutput output={output} onClose={() => {}} />
        ) : (
          <SubscriptionsPage />
        )}
      </UIProviders>
    </QueryClientProvider>,
  );
  if (profileRecord === null) {
    await userEvent.click(
      screen.getByRole("button", { name: "预览此订阅更新" }),
    );
  } else {
    const row = await screen.findByRole("row", { name: "客户端订阅 Phone" });
    await userEvent.click(
      within(row).getByRole("button", { name: "检查更新" }),
    );
  }
  const dialog = await screen.findByRole("dialog", {
    name: "检查订阅更新「Phone」",
  });
  await within(dialog).findByText("兼容检查通过。");
  return { dialog, requests };
}
it("states the accepted-source scope beside an unchanged configuration text result using only loaded profile context", async () => {
  const { dialog, requests } = await check();
  expect(
    within(dialog).getByText("生成的配置文本与已发布版本相同。"),
  ).toBeTruthy();
  expect(within(dialog).getByText(scopeNote)).toBeTruthy();
  expect(requests).toHaveLength(7);
  expect(requests.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
    "GET /api/me/outputs",
    "GET /api/me/outputs",
    "GET /api/me/outputs",
    "GET /api/me/outputs/independent",
    "GET /api/me/overview",
    "GET /api/me/profiles",
    "POST /api/me/profiles/profile/preview",
  ]);
});

it("uses a known collection-backed profile without reading the collection or inventing a pending candidate", async () => {
  const { dialog, requests } = await check({
    ...profile,
    sourceIds: [],
    collectionId: "existing-collection",
  });
  expect(within(dialog).getAllByText(scopeNote)).toHaveLength(1);
  expect(
    within(dialog).getByText("生成的配置文本与已发布版本相同。"),
  ).toBeTruthy();
  expect(
    requests.filter(
      ({ path }) => path.includes("/sources") || path.includes("/collections"),
    ),
  ).toEqual([]);
  expect(within(dialog).queryByText(/有.*个.*待确认/)).toBeNull();
  expect(
    within(dialog).getByRole("button", { name: "确认更新「Phone」" }),
  ).toHaveProperty("disabled", false);
  expect(
    requests.filter(
      ({ path }) => path.includes("/publish") || path.includes("/accept"),
    ),
  ).toEqual([]);
});
it.each<[string, Profile | null]>([
  ["local-only", { ...profile, sourceIds: [], collectionId: undefined }],
  ["unavailable profile context", null],
])("does not show source guidance for %s", async (_context, record) => {
  const { dialog, requests } = await check(record);
  expect(
    within(dialog).getByText("生成的配置文本与已发布版本相同。"),
  ).toBeTruthy();
  expect(within(dialog).queryByText(scopeNote)).toBeNull();
  expect(
    requests.filter(
      ({ path }) =>
        path.includes("/sources") ||
        path.includes("/collections") ||
        path.includes("/reveal"),
    ),
  ).toEqual([]);
});
it.each([
  ["changed", true],
  ["unknown", null],
] as const)(
  "does not attach no-change context to a %s comparison",
  async (_state, changed) => {
    const { dialog } = await check(profile, changed);
    expect(
      within(dialog).queryByText("生成的配置文本与已发布版本相同。"),
    ).toBeNull();
    expect(within(dialog).queryByText(scopeNote)).toBeNull();
  },
);
it("rechecking repeats the explicit preview only and keeps one scoped explanation, without accepting or publishing", async () => {
  const { dialog, requests } = await check();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "重新检查" }),
  );
  await within(dialog).findByText("兼容检查通过。");
  expect(within(dialog).getAllByText(scopeNote)).toHaveLength(1);
  expect(requests.filter(({ method }) => method === "POST")).toEqual([
    { path: "/api/me/profiles/profile/preview", method: "POST" },
    { path: "/api/me/profiles/profile/preview", method: "POST" },
  ]);
});
