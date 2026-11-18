// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionBoundary } from "./SessionBoundary";
import { setCSRF, setToken } from "./api";

const session = {
  user: { id: "account", name: "Account", role: "user" },
  csrfToken: "synthetic-csrf",
};
const response = () => new Response(JSON.stringify(session), {
  headers: { "Content-Type": "application/json" },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function workspace() {
  setToken("");
  setCSRF("");
  vi.stubGlobal("BroadcastChannel", class {
    addEventListener() {}
    postMessage() {}
    close() {}
  });
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addListener() {},
    removeListener() {},
  } as unknown as MediaQueryList));
  const fetchSession = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetchSession);
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <SessionBoundary login={() => <p>Sign in again</p>}>
        <label>Draft name<input defaultValue="Keep my place" /></label>
      </SessionBoundary>
    </QueryClientProvider>,
  );
  const input = await screen.findByLabelText<HTMLInputElement>("Draft name");
  const host = input.closest("[data-session-workspace]")!;
  await waitFor(() => expect(host.hasAttribute("inert")).toBe(false));
  return { fetchSession, host, input };
}

it("preserves an active workspace on focus and visibility return without checking the session", async () => {
  const { fetchSession, host, input } = await workspace();
  const initialReadCount = fetchSession.mock.calls.length;
  const visibility = vi.spyOn(document, "visibilityState", "get");
  act(() => {
    input.focus();
    input.setSelectionRange(2, 5);
    fireEvent.blur(window);
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.focus(window);
  });
  expect(fetchSession).toHaveBeenCalledTimes(initialReadCount);
  expect(host.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("Keep my place");
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
});

it("preserves input focus and selection during a reconnect check", async () => {
  const { fetchSession, host, input } = await workspace();
  let finish!: (result: Response) => void;
  fetchSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => {
    input.focus();
    input.setSelectionRange(2, 5);
    fireEvent(window, new Event("online"));
  });
  await waitFor(() => expect(host.hasAttribute("inert")).toBe(true));
  act(() => input.blur());
  await act(async () => finish(response()));
  await waitFor(() => expect(host.hasAttribute("inert")).toBe(false));
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
});
