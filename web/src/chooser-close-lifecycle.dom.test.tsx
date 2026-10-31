// @vitest-environment jsdom
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { TaskDialog, type TaskOverlayProps } from "./ui-patterns/task-overlays";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfilePublicationDialog } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Profile } from "./types";

// Keep the actual TaskDialog/Radix rendering; hold only public close settlement.
// Browser focus/geometry is independently verified against the frozen build.
const closeQueue = vi.hoisted(() => ({ held: [] as Array<() => void> }));
vi.mock("./ui-patterns/task-overlays", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./ui-patterns/task-overlays")>();
  const HeldTaskDialog = (props: TaskOverlayProps) => (
    <actual.TaskDialog
      {...props}
      onClosed={() => {
        if (props.onClosed) closeQueue.held.push(props.onClosed);
      }}
    />
  );
  return { ...actual, TaskDialog: HeldTaskDialog };
});
const profile = {
  ...emptyProfile(),
  id: "chooser-owner",
  name: "Working draft",
};
const output = {
  id: "chooser-output",
  name: "Existing link",
  profileId: profile.id,
  target: profile.target,
  mode: "full",
  status: "published",
};
const clients: QueryClient[] = [];
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
function mount(initialProfile = profile, initialSuspended = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const closed = vi.fn();
  function Host({
    current,
    suspended,
  }: {
    current: Profile;
    suspended: boolean;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Check publication</button>
        <button>Newer owner</button>
        {open && (
          <ProfilePublicationDialog
            profile={current}
            suspended={suspended}
            onClose={() => {
              closed();
              setOpen(false);
            }}
          />
        )}
      </>
    );
  }
  const wrap = (current: Profile, suspended: boolean) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <Host current={current} suspended={suspended} />
      </UIProviders>
    </QueryClientProvider>
  );
  const view = render(wrap(initialProfile, initialSuspended));
  return {
    ...view,
    closed,
    client,
    change: (current: Profile, suspended = false) =>
      view.rerender(wrap(current, suspended)),
  };
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#profiles");
  closeQueue.held.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (
        (!init?.method || init.method === "GET") &&
        String(url) === "/api/me/outputs"
      )
        return json([output]);
      throw new Error(
        `No operation permitted in chooser cancellation test: ${init?.method || "GET"} ${url}`,
      );
    }),
  );
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
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return (this.isConnected &&
      !this.closest('[hidden], [inert], [aria-hidden="true"]')
        ? [{ width: 80, height: 32 }]
        : []) as unknown as DOMRectList;
    },
  );
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function openChooser() {
  const opener = screen.getByRole("button", { name: "Check publication" });
  await userEvent.click(opener);
  const element = await screen.findByRole("dialog", { name: "选择客户端订阅" });
  return { opener, element, dialog: within(element) };
}
it("settles explicit chooser cancellation before returning only its exact opener", async () => {
  const { closed } = mount();
  const { opener, dialog } = await openChooser();
  await dialog.findByRole("radio", { name: /更新「Existing link」/ });
  await userEvent.click(dialog.getByRole("button", { name: "返回编辑" }));
  expect(closed).not.toHaveBeenCalled();
  await waitFor(() => expect(closeQueue.held).toHaveLength(1));
  await act(async () => closeQueue.held.shift()!());
  expect(closed).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(opener);
  expect(screen.queryByRole("dialog")).toBeNull();
});

async function cancelChooser(dialog: ReturnType<typeof within>) {
  await userEvent.click(dialog.getByRole("button", { name: "返回编辑" }));
  await waitFor(() => expect(closeQueue.held).toHaveLength(1));
}
it.each(["Escape", "Close"])(
  "settles %s cancellation through the same owned close",
  async (kind) => {
    const { closed } = mount();
    const { opener, element, dialog } = await openChooser();
    if (kind === "Close")
      await userEvent.click(dialog.getByRole("button", { name: "关闭" }));
    else
      fireEvent.keyDown(element, {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
      });
    expect(closed).not.toHaveBeenCalled();
    await waitFor(() => expect(closeQueue.held).toHaveLength(1));
    await act(async () => closeQueue.held.shift()!());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  },
);
it("preserves a newer focused control during chooser cancellation", async () => {
  const { closed } = mount();
  const { dialog } = await openChooser();
  await cancelChooser(dialog);
  const newer = screen.getByRole("button", { name: "Newer owner" });
  act(() => newer.focus());
  expect(document.activeElement).toBe(newer);
  await act(async () => closeQueue.held.shift()!());
  expect(closed).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(newer);
});
it.each(["inert", "disabled", "hidden"])(
  "does not return to an unavailable %s chooser opener",
  async (kind) => {
    const { closed } = mount();
    const { opener, dialog } = await openChooser();
    await cancelChooser(dialog);
    opener.setAttribute(kind, "");
    const focus = vi.spyOn(opener, "focus");
    await act(async () => closeQueue.held.shift()!());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
  },
);
it("finishes same-task cancellation during suspension without taking parent focus", async () => {
  const { closed, change } = mount();
  const { opener, dialog } = await openChooser();
  await cancelChooser(dialog);
  const focus = vi.spyOn(opener, "focus");
  change(profile, true);
  await act(async () => closeQueue.held.shift()!());
  expect(closed).toHaveBeenCalledTimes(1);
  expect(focus).not.toHaveBeenCalled();
});
it("does not complete an old cancellation over a newer same-ID profile intent", async () => {
  const { closed, change } = mount();
  const { opener, dialog } = await openChooser();
  await cancelChooser(dialog);
  const focus = vi.spyOn(opener, "focus");
  change({ ...profile, name: "Newer same-ID draft" });
  expect(
    await screen.findByRole("dialog", { name: "选择客户端订阅" }),
  ).toBeTruthy();
  await act(async () => closeQueue.held.shift()!());
  expect(closed).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(screen.getByText("Newer same-ID draft")).toBeTruthy();
});
it("does not complete or refocus a departed chooser cancellation", async () => {
  const { closed, unmount } = mount();
  const { opener, dialog } = await openChooser();
  await cancelChooser(dialog);
  const focus = vi.spyOn(opener, "focus");
  unmount();
  await act(async () => closeQueue.held.shift()!());
  expect(closed).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
});
it("does not replace a closing chooser when its held read first resolves to no outputs", async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
  );
  const { closed, client } = mount();
  const { dialog } = await openChooser();
  await cancelChooser(dialog);
  await act(async () => release(json([])));
  // Observe the held read settlement through the public
  // query-client boundary, then assert the actual rendered task did not change.
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(closed).not.toHaveBeenCalled();
  await act(async () => closeQueue.held.shift()!());
  expect(closed).toHaveBeenCalledTimes(1);
});
it("does not restore its opener after navigation changes while cancellation settles", async () => {
  const { closed } = mount();
  const { opener, dialog } = await openChooser();
  await cancelChooser(dialog);
  const focus = vi.spyOn(opener, "focus");
  history.replaceState(null, "", "#sources");
  await act(async () => closeQueue.held.shift()!());
  expect(closed).toHaveBeenCalledTimes(1);
  expect(focus).not.toHaveBeenCalled();
});
it.each(["new", "existing"])(
  "preserves explicit %s review entry without running cancellation or publication",
  async (kind) => {
    const mutations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (!init?.method || init.method === "GET")
          return json(String(url) === "/api/me/outputs" ? [output] : []);
        mutations.push(`${init.method} ${url}`);
        if (
          init.method === "POST" &&
          String(url) === `/api/me/profiles/${profile.id}/preview`
        )
          return json({
            valid: true,
            outputId: output.id,
            previewScope: "output-update",
            previewDigest: "a".repeat(64),
            publicationEffect: { version: 1, link: "preserve" },
            artifacts: [],
          });
        throw new Error("A target selection may only read a pure preview");
      }),
    );
    const { closed } = mount();
    const { dialog } = await openChooser();
    await dialog.findByRole("radio", { name: /更新「Existing link」/ });
    await userEvent.click(
      dialog.getByRole("radio", {
        name: kind === "new" ? "创建新的客户端订阅" : /更新「Existing link」/,
      }),
    );
    await userEvent.click(dialog.getByRole("button", { name: "检查所选订阅" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "选择客户端订阅" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(closed).not.toHaveBeenCalled();
    expect(closeQueue.held).toHaveLength(0);
    expect(
      mutations.every(
        (request) => request === `POST /api/me/profiles/${profile.id}/preview`,
      ),
    ).toBe(true);
  },
);
it("preserves ordinary first-creation entry when the initial read has no outputs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_, init) => {
      if (init?.method && init.method !== "GET")
        throw new Error("No creation is permitted");
      return json([]);
    }),
  );
  const { closed } = mount();
  await userEvent.click(
    screen.getByRole("button", { name: "Check publication" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "选择客户端订阅" })).toBeNull(),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(closed).not.toHaveBeenCalled();
  expect(closeQueue.held).toHaveLength(0);
});
