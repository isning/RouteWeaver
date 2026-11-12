// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
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
import { ProfileEditor } from "./Profiles";
import { ServerRoutesPage } from "./ServerRoutes";
import { emptyProfile } from "./model";
import { hasUnsavedChanges } from "./navigation";
import type { ServerDeployment } from "./types";

const clients: QueryClient[] = [];
beforeEach(() => {
  // rc-component uses the same test-id for every overlay in test mode.
  // Use real React IDs so nested dialog accessible names match the browser.
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "/");
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
  vi.unstubAllEnvs();
});

async function openEditor(kind: "profile" | "server") {
  const user = userEvent.setup();
  const profile = emptyProfile();
  profile.name = "JSON draft";
  profile.ir.name = profile.name;
  profile.ir.nativeOverride = {
    schemaVersion: "1",
    namespace: "routeweaver/native-client",
    target: profile.target,
    format: "json",
    ruleMode: "prepend",
    content: '{"private":"retain-this-value"}',
  };
  const deployment: ServerDeployment = {
    id: "route-json",
    name: "JSON route",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "route-json",
      topologyRevision: "v1",
      programs: [],
    },
  };
  const writes: { id: string; ir: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      let value: unknown = [];
      if (init?.method === "PUT" || init?.method === "POST") {
        value = JSON.parse(init.body as string);
        writes.push(value as (typeof writes)[number]);
      } else if (String(url).endsWith("/server-deployments"))
        value = [deployment];
      else if (String(url).endsWith("/server-deployments/route-json/reveal"))
        value = deployment;
      return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {kind === "profile" ? (
          <ProfileEditor initial={profile} isNew={false} onClose={close} />
        ) : (
          <ServerRoutesPage />
        )}
      </UIProviders>
    </QueryClientProvider>,
  );
  if (kind === "profile") {
    await user.click(screen.getByRole("tab", { name: "运行设置" }));
    await user.click(screen.getByText("高级：配置意图与目标版本"));
  } else {
    await user.click(
      await screen.findByRole("button", { name: "编辑转发路径 JSON route" }),
    );
    await user.click(await screen.findByText("完整配置（JSON）"));
  }
  const reopen = async () => {
    await user.click(
      screen.getByRole("button", {
        name: kind === "profile" ? "编辑配置意图 JSON" : "编辑 JSON",
      }),
    );
    return screen.findByRole("dialog", {
      name: kind === "profile" ? "配置意图 JSON" : "服务端配置 JSON",
    });
  };
  const dialog = await reopen();
  const input = within(dialog).getByRole("textbox") as HTMLTextAreaElement;
  return {
    user,
    dialog,
    input,
    reopen,
    writes,
    close,
    initial: kind === "profile" ? profile : deployment,
  };
}

it.each(["profile", "server"] as const)(
  "%s keeps invalid JSON through failed apply and canceled dismissal, then explicitly discards only the text",
  async (kind) => {
    const { user, dialog, input, reopen, writes } = await openEditor(kind);
    const original = input.value;
    fireEvent.change(input, { target: { value: '{"unfinished":' } });
    await waitFor(() => expect(hasUnsavedChanges()).toBe(true));
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "保存草稿",
          hidden: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(
      within(dialog).getByRole("button", { name: "应用到草稿" }),
    );
    expect(input.value).toBe('{"unfinished":');
    await user.click(
      within(dialog).getByRole("button", {
        name: kind === "profile" ? "关闭" : /取\s*消/,
      }),
    );
    const confirmation = await screen.findByRole("alertdialog", {
      name: "放弃尚未应用的 JSON 修改？",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "继续编辑" }),
    );
    expect(input.value).toBe('{"unfinished":');
    expect(hasUnsavedChanges()).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    const discardConfirmation = await screen.findByRole("alertdialog", {
      name: "放弃尚未应用的 JSON 修改？",
    });
    await user.click(
      within(discardConfirmation).getByRole("button", {
        name: "放弃 JSON 修改",
      }),
    );
    await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
    const reopened = await reopen();
    expect(
      (within(reopened).getByRole("textbox") as HTMLTextAreaElement).value,
    ).toBe(original);
    expect(writes).toHaveLength(0);
  },
);

it.each(["profile", "server"] as const)(
  "%s applies JSON without pretending it is saved, and saves the same identity with existing private content",
  async (kind) => {
    const { user, dialog, input, writes, initial } = await openEditor(kind);
    const edited = {
      ...JSON.parse(input.value),
      ...(kind === "profile"
        ? { defaultAction: "reject" }
        : { topologyRevision: "v2" }),
    };
    fireEvent.change(input, { target: { value: JSON.stringify(edited) } });
    await user.click(
      within(dialog).getByRole("button", { name: "应用到草稿" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: kind === "profile" ? "配置意图 JSON" : "服务端配置 JSON",
        }),
      ).toBeNull(),
    );
    expect(hasUnsavedChanges()).toBe(true);
    expect(writes).toHaveLength(0);
    await user.click(
      screen.getByRole("button", {
        name: "保存草稿",
      }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].id).toBe(initial.id);
    expect(writes[0].ir).toMatchObject(edited);
    await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
  },
);

it.each(["profile", "server"] as const)(
  "%s protects unapplied text when the outer editor is closed",
  async (kind) => {
    const { user, input, close } = await openEditor(kind);
    fireEvent.change(input, { target: { value: "unfinished JSON" } });
    // Exercise the outer editor's close seam independently of the nested overlay.
    const outerClose =
      kind === "profile"
        ? screen.getByRole("button", { name: "返回", hidden: true })
        : screen
            .getByRole("dialog", { name: "编辑 JSON route", hidden: true })
            .querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
    expect(outerClose).not.toBeNull();
    fireEvent.click(outerClose);
    const confirmation = await screen.findByRole("alertdialog", {
      name:
        kind === "profile"
          ? "放弃未保存的修改？"
          : "放弃尚未保存的转发路径修改？",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "继续编辑" }),
    );
    expect(input.value).toBe("unfinished JSON");
    expect(close).not.toHaveBeenCalled();
    expect(hasUnsavedChanges()).toBe(true);
  },
);
