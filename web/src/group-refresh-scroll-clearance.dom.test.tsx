// @vitest-environment jsdom
// Rendered CSS contract only; native keyboard sampling owns painted geometry.
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { compile } from "tailwindcss";
import { UIProviders } from "./ui-patterns/providers";
import { UserGroups } from "./AccessPolicy";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
it("reserves native scroll clearance for the group Refresh control and its focus ring", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) !== "/api/user-groups" || (init?.method && init.method !== "GET"))
      throw new Error("Unexpected request");
    return new Response("[]", { headers: { "Content-Type": "application/json" } });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders>
    <UserGroups users={[]} services={[]} routes={[]} />
  </UIProviders></QueryClientProvider>);
  const refresh = await screen.findByRole("button", { name: "刷新用户组" });
  const stylesheet = document.createElement("style");
  stylesheet.textContent = (await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;"))
    .build([...document.body.querySelectorAll<HTMLElement>("[class]")].flatMap(node => [...node.classList]));
  document.head.append(stylesheet);
  try {
    // One spacing unit is 4px, leaving room for the official 3px focus ring.
    expect(getComputedStyle(refresh).scrollMargin).toBe("var(--spacing)");
    expect(getComputedStyle(screen.getByRole("button", { name: "新建用户组" })).scrollMargin).toBe("0");
  } finally { stylesheet.remove(); }
});
