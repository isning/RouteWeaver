// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  outputComparisonKey,
  outputInputSequence,
  rememberOutputComparison,
  useOutputComparison,
} from "./output-comparison";
import type { Output } from "./types";

const output: Output = {
  id: "macbook",
  name: "MacBook",
  profileId: "daily",
  target: { adapterId: "sing-box", version: "1.12" },
  mode: "full",
  status: "published",
  revision: "publication-one",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains a visible historical receipt without fetching, then collects it after the row unmounts", async () => {
  // Controlled cache time, not a five-minute wall-clock wait or a longer task timeout.
  vi.useFakeTimers();
  const fetch = vi.fn(() => {
    throw new Error("Reading a remembered comparison must never fetch");
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 5 * 60 * 1000 } },
  });
  rememberOutputComparison(
    client,
    output,
    { ...output, draftComparison: { state: "changed" } },
    new Date("2026-10-22T01:02:00Z").getTime(),
    outputInputSequence(client, output.profileId),
  );
  function VisibleReceipt() {
    const observation = useOutputComparison(output);
    return <p>{observation.text}</p>;
  }
  const mounted = render(
    <QueryClientProvider client={client}>
      <VisibleReceipt />
    </QueryClientProvider>,
  );
  expect(
    screen.getByText("上次核对 2026/10/22 09:02：有未发布修改"),
  ).toBeTruthy();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
  });
  expect(
    screen.getByText("上次核对 2026/10/22 09:02：有未发布修改"),
  ).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();

  mounted.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
  });
  expect(client.getQueryData(outputComparisonKey(output))).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  client.clear();
});
