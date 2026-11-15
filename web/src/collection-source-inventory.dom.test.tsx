// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { CollectionsPage, SourcesPage } from "./Sources";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});
it.each(["success", "failure"])(
  "entering collections rereads fresh cached sources and preserves the draft on %s",
  async (outcome) => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/me/sources"))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
    });
    clients.push(client);
    // The overview read this before another tab or API created the new provider.
    client.setQueryData(
      ["sources"],
      [
        {
          id: "old",
          name: "旧来源",
          kind: "text",
          enabled: true,
          snapshot: { endpoints: [] },
        },
      ],
    );
    client.setQueryData(["collections"], []);
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <CollectionsPage />
        </UIProviders>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining("/me/sources"),
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "新建集合" })[0]);
    const dialog = within(
      await screen.findByRole("dialog", { name: "新建集合" }),
    );
    fireEvent.change(dialog.getByLabelText("集合名称"), {
      target: { value: "保留的草稿" },
    });
    await act(async () =>
      finish(
        new Response(
          JSON.stringify(
            outcome === "failure"
              ? { detail: "temporarily unavailable" }
              : [
                  {
                    id: "new",
                    name: "北区线路",
                    kind: "text",
                    enabled: true,
                    snapshot: { endpoints: [] },
                  },
                ],
          ),
          {
            status: outcome === "failure" ? 503 : 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    if (outcome === "success") {
      fireEvent.click(dialog.getByRole("combobox", { name: "订阅来源" }));
      expect(
        await screen.findByRole("option", { name: "北区线路" }),
      ).toBeTruthy();
    } else {
      expect(await screen.findByText("暂时无法加载来源")).toBeTruthy();
      expect(
        (
          dialog.getByRole("combobox", {
            name: "订阅来源",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(screen.getByRole("button", { name: "重试加载来源" })).toBeTruthy();
    }
    expect((dialog.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
      "保留的草稿",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("entering source management rereads an overview snapshot instead of hiding a newly created source", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify([
          {
            id: "new",
            name: "北区线路",
            kind: "text",
            enabled: true,
            snapshot: { endpoints: [] },
          },
        ]),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15000 } },
  });
  clients.push(client);
  client.setQueryData(["sources"], []);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("button", { name: "更多操作 北区线路" })).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
