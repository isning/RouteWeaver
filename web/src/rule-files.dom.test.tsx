// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuleFileImport } from "./RuleFileImport";
import { AccessSubscription } from "./Subscriptions";
import type { ReactNode } from "react";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount(v: ReactNode) {
  return render(
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
      <UIProviders>{v}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (e) => original(e);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("uploads the same selected rule file after a failed import without submitting untrusted delivery paths", async () => {
  const writes: any[] = [];
  const done = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      writes.push(JSON.parse(init.body));
      return writes.length === 1
        ? json({ error: "Rule envelope rejected" }, 422)
        : json(
            {
              ...writes[1].resource,
              acceptedVersion: "accepted",
              sizeBytes: 25,
            },
            201,
          );
    }),
  );
  mount(<RuleFileImport onClose={done} />);
  const user = userEvent.setup();
  fireEvent.change(screen.getByLabelText("导入资源名称"), {
    target: { value: "Private domains" },
  });
  const file = new File(["payload:\n  - example.com\n"], "private.yaml", {
    type: "application/yaml",
  });
  await user.upload(screen.getByLabelText("选择规则文件"), file);
  await user.click(screen.getByRole("button", { name: "导入并保存文件" }));
  await screen.findByText("Rule envelope rejected");
  expect(
    (screen.getByLabelText("导入资源名称") as HTMLInputElement).value,
  ).toBe("Private domains");
  await user.click(screen.getByRole("button", { name: "导入并保存文件" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(writes[1]).toEqual(writes[0]);
  expect(atob(writes[0].contentBase64)).toBe("payload:\n  - example.com\n");
  expect(writes[0].resource.path).toBeUndefined();
  expect(writes[0].resource.acceptedVersion).toBeUndefined();
});
it("offers an authorized ZIP bundle download instead of a broken config subscription or QR code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        delivery: "bundle",
        feedURL: "https://example.com/feed/token",
        bundleURL: "https://example.com/feed/token/bundle",
        downloadPath: "/api/me/outputs/bundle1/bundle",
      }),
    ),
  );
  mount(
    <AccessSubscription
      output={{
        id: "bundle1",
        name: "Private rules",
        profileId: "p1",
        target: { adapterId: "mihomo", version: "1.19.32" },
        mode: "full",
        status: "published",
        delivery: "bundle",
      }}
      onClose={() => {}}
    />,
  );
  const download = await screen.findByRole("link", {
    name: "下载配置与规则文件",
  });
  expect(download.getAttribute("href")).toBe("/api/me/outputs/bundle1/bundle");
  expect(screen.queryByLabelText("订阅链接")).toBeNull();
  expect(screen.queryByRole("button", { name: "复制订阅链接" })).toBeNull();
  expect(document.querySelector(".qr-container")).toBeNull();
  expect(screen.getByText(/保留文件夹结构/)).toBeTruthy();
});
it("lets the server detect the replacement file version instead of resubmitting hidden prior format metadata", async () => {
  let body: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return json(
        { ...body.resource, formatVersion: 5, acceptedVersion: "new-version" },
        201,
      );
    }),
  );
  mount(
    <RuleFileImport
      initial={{
        id: "r1",
        name: "Existing rules",
        format: "sing-box-source",
        formatVersion: 1,
        location: "local",
        revision: "old",
        digest: "sha256:old",
        acceptedVersion: "old-version",
        sizeBytes: 30,
        updatePolicy: "pinned",
      }}
      onClose={() => {}}
    />,
  );
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText("选择规则文件"),
    new File(['{"version":5,"rules":[]}'], "rules.json"),
  );
  await user.click(screen.getByRole("button", { name: "导入并保存文件" }));
  await waitFor(() => expect(body).toBeTruthy());
  expect(body.resource.formatVersion).toBeUndefined();
  expect(body.resource.acceptedVersion).toBeUndefined();
  expect(body.resource.id).toBe("r1");
});
