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
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { ServersPage } from "./Infrastructure";
import { endpointImpactConnection } from "../tests/fixtures/endpoint-impact";

const endpoint = {
  id: "shared",
  instanceId: "core",
  name: "Shared entry",
  revisionToken: "opened-private-revision",
  connection: { ...endpointImpactConnection },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function setup({
  failPreview = false,
  failSave = false,
  previewGate,
}: {
  failPreview?: boolean;
  failSave?: boolean;
  previewGate?: Promise<void>;
} = {}) {
  const reviews: Record<string, unknown>[] = [];
  const writes: { value: Record<string, unknown>; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path.endsWith("/impact")) {
        const value = JSON.parse(init.body);
        expect(new Headers(init.headers).get("If-Match")).toBe(
          endpoint.revisionToken,
        );
        expect(value.revisionToken).toBeUndefined();
        expect(value.connection).toEqual(endpointImpactConnection);
        reviews.push(value);
        await previewGate;
        if (failPreview && reviews.length === 1)
          return json({ detail: "影响清单暂时不可用" }, 503);
        return json({
          endpoint: { id: endpoint.id, name: endpoint.name },
          proposed: {
            name: value.name,
            instanceId: "core",
            instanceName: "Reference core",
            host: "127.0.0.1",
            port: 1080,
            protocol: "socks",
          },
          changedFields: ["名称"],
          deployments: [{ id: "deployment", name: "Shared forwarding" }],
          routes: [{ id: "route", name: "Shared public route" }],
          links: [{ id: "link", name: "link" }],
          reviewToken: `review-${reviews.length}`,
        });
      }
      if (init?.method === "PUT") {
        writes.push({
          value: JSON.parse(init.body),
          headers: new Headers(init.headers),
        });
        if (failSave && writes.length === 1)
          return json({ detail: "引用已变化，请重新审阅" }, 409);
        return json(writes.at(-1)!.value);
      }
      if (path === "/api/hosts")
        return json([
          { id: "host", name: "Reference host", address: "127.0.0.1" },
        ]);
      if (path === "/api/core-instances")
        return json([
          {
            id: "core",
            hostId: "host",
            adapterId: "routeweaver/xray",
            version: "26.10.31",
          },
        ]);
      if (path === "/api/managed-endpoints") return json([endpoint]);
      if (path.endsWith("/reveal")) return json(endpoint);
      if (path.includes("/observability")) return json({ config: {} });
      return json([]);
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <ConfirmationProvider>
        <ServersPage />
      </ConfirmationProvider>
    </QueryClientProvider>,
  );
  return { reviews, writes };
}
async function edit() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "监听端点 1" }));
  await user.click(screen.getByRole("button", { name: /编辑/ }));
  const dialog = await screen.findByRole("dialog", { name: "编辑监听端点" });
  const name = within(dialog).getByLabelText("端点名称");
  await user.clear(name);
  await user.type(name, "Reviewed name");
  return {
    user,
    dialog,
    name,
    save: within(dialog).getByRole("button", { name: "保存" }),
  };
}
it("retains draft on failed impact read and twice canceled review, without writing or exposing secrets", async () => {
  const { reviews, writes } = setup({ failPreview: true });
  const { user, name, save } = await edit();
  await user.click(save);
  expect(await screen.findByText("影响清单暂时不可用")).toBeTruthy();
  expect((name as HTMLInputElement).value).toBe("Reviewed name");
  expect(writes).toHaveLength(0);
  for (let n = 0; n < 2; n++) {
    await user.click(save);
    const review = await screen.findByRole("alertdialog", {
      name: "保存端点「Shared entry」的修改？",
    });
    expect(
      within(review).getByText("Shared forwarding", { exact: false }),
    ).toBeTruthy();
    expect(
      within(review).getByText("Shared public route", { exact: false }),
    ).toBeTruthy();
    expect(review.textContent).not.toContain("fixture-private");
    expect(
      within(review).getByText(
        /保存为：Reviewed name · Reference core · socks · 127.0.0.1:1080/,
      ),
    ).toBeTruthy();
    expect(
      within(review).getByText(
        /本次仅更新端点清单，保留已保存的转发配置、当前出口与节点配置/,
      ),
    ).toBeTruthy();
    const keep = within(review).getByRole("button", { name: "返回编辑" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    if (n === 0) await user.click(keep);
    else await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(save));
    expect((name as HTMLInputElement).value).toBe("Reviewed name");
    expect(writes).toHaveLength(0);
  }
  expect(reviews).toHaveLength(3);
});
it("requires a fresh review after dependency conflict and writes only the reviewed draft", async () => {
  const { reviews, writes } = setup({ failSave: true });
  const { user, name, save } = await edit();
  for (let n = 0; n < 2; n++) {
    await user.click(save);
    const review = await screen.findByRole("alertdialog", {
      name: "保存端点「Shared entry」的修改？",
    });
    await user.click(
      within(review).getByRole("button", { name: "确认保存端点" }),
    );
    await waitFor(() => expect(writes).toHaveLength(n + 1));
    if (n === 0) {
      expect(await screen.findByText("引用已变化，请重新审阅")).toBeTruthy();
      expect((name as HTMLInputElement).value).toBe("Reviewed name");
    }
  }
  expect(reviews).toHaveLength(2);
  expect(writes.map((w) => w.headers.get("X-Endpoint-Impact"))).toEqual([
    "review-1",
    "review-2",
  ]);
  expect(writes[0].value).toEqual(reviews[0]);
  expect(writes[1].value).toEqual(reviews[1]);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑监听端点" })).toBeNull(),
  );
});

it("keeps the preview opener focusable while blocking duplicate submissions and restores it after Escape", async () => {
  let release!: () => void;
  const previewGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { reviews, writes } = setup({ previewGate });
  const { user, name, save } = await edit();
  await user.click(save);
  await waitFor(() => expect(reviews).toHaveLength(1));
  expect(save.getAttribute("aria-busy")).toBe("true");
  expect(save.getAttribute("aria-disabled")).toBe("true");
  // Native disabling blurs this opener in browsers, unlike jsdom. Keep the
  // logical task owner focusable while ActionButton/form guards block work.
  expect((save as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(save);
  await user.click(save);
  await user.keyboard("{Enter}");
  expect(reviews).toHaveLength(1);
  expect(writes).toHaveLength(0);
  await act(async () => {
    release();
    await previewGate;
  });
  const review = await screen.findByRole("alertdialog", {
    name: "保存端点「Shared entry」的修改？",
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(review).getByRole("button", { name: "返回编辑" }),
    ),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(save));
  expect((name as HTMLInputElement).value).toBe("Reviewed name");
  expect(reviews).toHaveLength(1);
  expect(writes).toHaveLength(0);
});
