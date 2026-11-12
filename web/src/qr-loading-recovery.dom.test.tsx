// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AccessSubscription } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Output } from "./types";
const chunk = vi.hoisted(() => {
  let reject!: (reason: Error) => void;
  const promise = new Promise<typeof import("qrcode.react")>((_, fail) => {
    reject = fail;
  });
  return { promise, fail: (error: Error) => reject(error) };
});
vi.mock("qrcode.react", () => chunk.promise);
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps copying and dismissal available while QR is held, closed, reopened and rejected", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            delivery: "feed",
            feedPath: "/feed/nonfunctional-loading-test",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  const output: Output = {
    id: "phone",
    name: "Phone",
    profileId: "profile",
    status: "published",
    mode: "full",
    target: emptyProfile().target,
    delivery: "feed",
  };
  function Task() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open access</button>
        <AccessSubscription
          output={open ? output : null}
          onClose={() => setOpen(false)}
        />
      </>
    );
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <Task />
      </UIProviders>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Open access" }));
  let dialog = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await within(dialog).findByRole("status", { name: "正在加载二维码" });
  await user.click(
    within(dialog).getByRole("button", { name: "复制订阅链接" }),
  );
  expect(copy).toHaveBeenCalledWith(
    new URL("/feed/nonfunctional-loading-test", location.origin).href,
  );
  await user.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByRole("button", { name: "Open access" }));
  dialog = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await within(dialog).findByRole("status", { name: "正在加载二维码" });
  await act(async () =>
    chunk.fail(new Error("Synthetic QR chunk interrupted")),
  );
  const fallback = await within(dialog).findByText("二维码暂时无法加载，请复制订阅链接。");
  // This fixed white scanning surface must not inherit light text in dark mode.
  expect(fallback.closest(".qr-container")?.classList.contains("bg-white")).toBe(true);
  expect(fallback.classList.contains("text-neutral-600")).toBe(true);
  expect(
    within(dialog).getByRole("textbox", { name: "订阅链接" }),
  ).toBeTruthy();
  await user.click(
    within(dialog).getByRole("button", { name: "复制订阅链接" }),
  );
  expect(copy).toHaveBeenCalledTimes(2);
  await user.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
