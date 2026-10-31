// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackupSettings } from "./Backup";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const preview = {
  manifest: { schemaVersion: 2, createdAt: "2026-10-01T00:00:00Z" },
  digest: "fixture",
  counts: { records: 1 },
  restoreAvailable: true,
};
const target = `restore_${"a".repeat(43)}.db`;
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <BackupSettings />
      </UIProviders>
    </QueryClientProvider>,
  );
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function prepare(phrase = "恢复到新数据库") {
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText("选择加密备份"),
    new File(["fixture"], "backup.age", { type: "application/octet-stream" }),
  );
  fireEvent.change(screen.getByLabelText("备份密码"), {
    target: { value: "fixture-password" },
  });
  await user.click(screen.getByRole("button", { name: "校验备份并查看影响" }));
  await screen.findByText("文件校验通过");
  fireEvent.change(screen.getByRole("textbox", { name: /^输入/ }), {
    target: { value: phrase },
  });
  return user;
}
it.each([403, 429])(
  "retains unknown across edits, then keeps manual-review record through authoritative %i failure",
  async (status) => {
    let restores = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/restore")) {
          restores++;
          if (restores === 1) throw new TypeError("synthetic lost response");
          return json(
            { detail: `current request rejected (${status})` },
            status,
          );
        }
        return json(preview);
      }),
    );
    mount();
    const user = await prepare();
    await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
    await screen.findByText("恢复结果尚未确认");
    expect((screen.getByLabelText("备份密码") as HTMLInputElement).value).toBe(
      "fixture-password",
    );
    expect(
      (screen.getByLabelText("输入“恢复到新数据库”以确认") as HTMLInputElement)
        .value,
    ).toBe("");
    fireEvent.change(screen.getByLabelText("输入“恢复到新数据库”以确认"), {
      target: { value: "恢复到新数据库" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "恢复到新数据库",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("备份密码"), {
      target: { value: "fixture-password-updated" },
    });
    await user.click(
      screen.getByRole("button", { name: "校验备份并查看影响" }),
    );
    await screen.findByText("文件校验通过");
    expect(screen.getByText("恢复结果尚未确认")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "已检查，允许再次恢复" }),
    );
    expect(screen.queryByText("文件校验通过")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "校验备份并查看影响" }),
    );
    await screen.findByText("文件校验通过");
    fireEvent.change(screen.getByLabelText("输入“恢复到新数据库”以确认"), {
      target: { value: "恢复到新数据库" },
    });
    await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
    await screen.findByText(`current request rejected (${status})`);
    expect(screen.getByText("此前恢复的人工检查记录")).toBeTruthy();
    expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
    expect(restores).toBe(2);
    await user.click(screen.getByRole("button", { name: "清空备份输入" }));
    expect(screen.getByText("此前恢复的人工检查记录")).toBeTruthy();
    expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
  },
);
it("validates success before clearing inputs and never resends while pending", async () => {
  let complete!: (value: Response) => void;
  let restores = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (!String(url).endsWith("/restore")) return json(preview);
      restores++;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  mount();
  const user = await prepare();
  const button = screen.getByRole("button", { name: "恢复到新数据库" });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(restores).toBe(1));
  complete(json({ status: "restored", target, activated: false }, 200));
  await screen.findByText("恢复结果尚未确认");
  expect(screen.queryByText("已恢复到新数据库，尚未启用")).toBeNull();
  expect((screen.getByLabelText("备份密码") as HTMLInputElement).value).toBe(
    "fixture-password",
  );
});
it("does not let a late response from an unmounted attempt change the new page", async () => {
  let complete!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      !String(url).endsWith("/restore")
        ? json(preview)
        : new Promise<Response>((resolve) => {
            complete = resolve;
          }),
    ),
  );
  const first = mount();
  const user = await prepare();
  await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  first.unmount();
  mount();
  complete(json({ status: "restored", target, activated: false }, 201));
  await waitFor(() =>
    expect(screen.queryByText("已恢复到新数据库，尚未启用")).toBeNull(),
  );
  expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
});

it("shows an ordinary validated success without an uncertainty warning", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/restore")
        ? json({ status: "restored", target, activated: false }, 201)
        : json(preview),
    ),
  );
  mount();
  const user = await prepare();
  await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  await screen.findByText("已恢复到新数据库，尚未启用");
  expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
  expect((screen.getByLabelText("备份密码") as HTMLInputElement).value).toBe(
    "",
  );
});

it("keeps the validated uncertain target through edits and a fresh preview", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/restore")
        ? json(
            {
              detail: "publication uncertain",
              restoreOutcome: "uncertain",
              target,
              activated: false,
            },
            500,
          )
        : json(preview),
    ),
  );
  mount();
  const user = await prepare();
  await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  await screen.findByText(`待检查目标：${target}`);
  fireEvent.change(screen.getByLabelText("备份密码"), {
    target: { value: "changed-password" },
  });
  await user.click(screen.getByRole("button", { name: "校验备份并查看影响" }));
  await screen.findByText("文件校验通过");
  expect(screen.getByText(`待检查目标：${target}`)).toBeTruthy();
  expect(screen.queryByText("已恢复到新数据库，尚未启用")).toBeNull();
});

// All events share one React turn: disabled props have not yet committed.
it("freezes the submitted archive and credentials across rapid input events and retains its result", async () => {
  let complete!: (value: Response) => void;
  const sent: FormData[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (!String(url).endsWith("/restore")) return json(preview);
      sent.push(init.body as FormData);
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  mount();
  await prepare();
  const file = screen.getByLabelText("选择加密备份");
  const password = screen.getByLabelText("备份密码");
  const confirmation = screen.getByLabelText("输入“恢复到新数据库”以确认");
  const button = screen.getByRole("button", { name: "恢复到新数据库" });
  act(() => {
    fireEvent.click(button);
    fireEvent.change(password, { target: { value: "different-password" } });
    fireEvent.change(file, {
      target: { files: [new File(["different"], "different.age")] },
    });
    fireEvent.change(confirmation, { target: { value: "changed" } });
    fireEvent.click(button);
  });
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(JSON.parse(String(sent[0].get("metadata")))).toEqual({
    password: "fixture-password",
    digest: "fixture",
    confirmation: "RESTORE TO NEW STORE",
  });
  expect((sent[0].get("archive") as File).name).toBe("backup.age");
  complete(json({ status: "restored", target, activated: false }, 201));
  await screen.findByText("已恢复到新数据库，尚未启用");
  expect(screen.getByText(new RegExp(target))).toBeTruthy();
  expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
});

it("does not reuse an inspection started before the operator check", async () => {
  let previews = 0;
  let complete!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/restore"))
        throw new TypeError("synthetic response loss");
      if (++previews === 1) return json(preview);
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  mount();
  const user = await prepare();
  await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  await screen.findByText("恢复结果尚未确认");
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "校验备份并查看影响" }));
    fireEvent.click(
      screen.getByRole("button", { name: "已检查，允许再次恢复" }),
    );
  });
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  await act(async () => {
    complete(json(preview));
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "校验备份并查看影响" })
        .getAttribute("aria-busy"),
    ).not.toBe("true"),
  );
  expect(screen.queryByText("文件校验通过")).toBeNull();
  expect(screen.queryByRole("button", { name: "恢复到新数据库" })).toBeNull();
  expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
  expect(screen.getByText("此前恢复的人工检查记录")).toBeTruthy();
});

it("blocks a same-turn restore while a new inspection owns the inputs", async () => {
  let previews = 0;
  let restores = 0;
  let complete!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/restore")) {
        restores++;
        return json({ status: "restored", target, activated: false }, 201);
      }
      if (++previews === 1) return json(preview);
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  mount();
  await prepare();
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "校验备份并查看影响" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  });
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  await act(async () => {
    complete(json(preview));
  });
  expect(restores).toBe(0);
});

it("keeps a manually reviewed target distinct from a newer unknown attempt", async () => {
  let restores = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (!String(url).endsWith("/restore")) return json(preview);
      if (++restores === 1)
        return json(
          {
            detail: "uncertain",
            restoreOutcome: "uncertain",
            target,
            activated: false,
          },
          500,
        );
      if (restores === 2) throw new TypeError("synthetic response loss");
      return json(
        {
          detail: "uncertain",
          restoreOutcome: "uncertain",
          target: `restore_${"b".repeat(43)}.db`,
          activated: false,
        },
        500,
      );
    }),
  );
  mount();
  const user = await prepare();
  await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  await screen.findByText(`待检查目标：${target}`);
  await user.click(
    screen.getByRole("button", { name: "已检查，允许再次恢复" }),
  );
  expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
  expect(screen.getByText(`此前检查的目标：${target}`)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "校验备份并查看影响" }));
  await screen.findByText("文件校验通过");
  fireEvent.change(screen.getByLabelText("输入“恢复到新数据库”以确认"), {
    target: { value: "恢复到新数据库" },
  });
  await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  await screen.findByText("恢复结果尚未确认");
  expect(screen.queryByText(`待检查目标：${target}`)).toBeNull();
  expect(screen.getByText(`此前检查的目标：${target}`)).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "恢复到新数据库",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "清空备份输入" }));
  expect(screen.getByText("恢复结果尚未确认")).toBeTruthy();
  expect(screen.getByText(`此前检查的目标：${target}`)).toBeTruthy();
  expect(restores).toBe(2);
  await user.click(
    screen.getByRole("button", { name: "已检查，允许再次恢复" }),
  );
  expect(screen.queryByText(`此前检查的目标：${target}`)).toBeNull();
  expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
  await prepare();
  await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  await screen.findByText(`待检查目标：restore_${"b".repeat(43)}.db`);
  expect(screen.getAllByText("此前恢复的人工检查记录")).toHaveLength(1);
  expect(screen.queryByText(`此前检查的目标：${target}`)).toBeNull();
  expect(restores).toBe(3);
});

it.each(["inspect", "restore", "create"])(
  "keeps the %s action name stable while pending",
  async (action) => {
    let finish!: (response: Response) => void;
    let started = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = String(url);
        const selected =
          action === "restore"
            ? path.endsWith("/restore")
            : action === "inspect"
              ? path.endsWith("/preview")
              : path.endsWith("/backups");
        if (!selected) return json(preview);
        started = true;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    mount();
    const user = userEvent.setup();
    let label: string;
    if (action === "restore") {
      await prepare();
      label = "恢复到新数据库";
    } else if (action === "inspect") {
      await user.upload(
        screen.getByLabelText("选择加密备份"),
        new File(["fixture"], "backup.age", {
          type: "application/octet-stream",
        }),
      );
      fireEvent.change(screen.getByLabelText("备份密码"), {
        target: { value: "fixture-password" },
      });
      label = "校验备份并查看影响";
    } else {
      await user.click(screen.getByRole("button", { name: "创建加密备份" }));
      fireEvent.change(screen.getByLabelText("设置备份密码"), {
        target: { value: "fixture-password" },
      });
      fireEvent.change(screen.getByLabelText("再次输入密码"), {
        target: { value: "fixture-password" },
      });
      label = "加密并下载";
    }
    await user.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(started).toBe(true));
    try {
      const button = screen.getByRole("button", { name: label });
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(screen.queryByRole("img", { name: "loading" })).toBeNull();
    } finally {
      await act(async () =>
        finish(json({ detail: "synthetic request finished" }, 503)),
      );
    }
  },
);

it("keeps file validation subordinate to an unknown restore and preserves the credential warning", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/restore"))
        throw new TypeError("synthetic response loss");
      return json({
        ...preview,
        counts: { records: 1, sources: 2, "future-kind": 3 },
      });
    }),
  );
  mount();
  const user = await prepare();
  expect(screen.getByRole("status").textContent).toBe("文件校验通过");
  expect(
    screen.getByText(
      "备份包含当时的账号、二次验证、会话与订阅凭据。启用前，请复核备份后撤销过的权限和凭据。",
    ),
  ).toBeTruthy();
  const summary = screen.getByText("备份详情");
  expect(summary.closest("details")?.open).toBe(false);
  await user.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(screen.getByText("记录", { exact: true })).toBeTruthy();
  expect(screen.getByText("来源", { exact: true })).toBeTruthy();
  expect(screen.getByText("future-kind", { exact: true })).toBeTruthy();
  expect(screen.getAllByText(/backup.age/)).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "恢复到新数据库" }));
  await screen.findByText("恢复结果尚未确认");
  expect(screen.getByRole("status").textContent).toBe("文件校验通过");
  expect(screen.queryByText("已恢复到新数据库，尚未启用")).toBeNull();
});

it.each(["", "恢复", "RESTORE TO NEW STORE", "恢复到新数据库 "])(
  "requires the exact localized confirmation instead of %j",
  async (phrase) => {
    let restores = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/restore")) {
          restores++;
          return json({ status: "restored", target, activated: false }, 201);
        }
        return json(preview);
      }),
    );
    mount();
    const user = await prepare(phrase);
    const button = screen.getByRole("button", { name: "恢复到新数据库" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(restores).toBe(0);
  },
);

it("requires a separate restore gesture after Chinese composition and Enter, then sends the unchanged protocol confirmation", async () => {
  const sent: FormData[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (!String(url).endsWith("/restore")) return json(preview);
      sent.push(init.body as FormData);
      return json({ status: "restored", target, activated: false }, 201);
    }),
  );
  mount();
  const user = await prepare("");
  const input = screen.getByRole("textbox", { name: /^输入/ });
  await user.click(input);
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "恢复到新数据库" } });
  fireEvent.keyDown(input, {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  fireEvent.keyUp(input, {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  fireEvent.compositionEnd(input, { data: "恢复到新数据库" });
  await user.keyboard("{Enter}");
  expect(sent).toHaveLength(0);
  const button = screen.getByRole("button", { name: "恢复到新数据库" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByLabelText("输入“恢复到新数据库”以确认")).toBe(input);
  await user.click(button);
  await screen.findByText("已恢复到新数据库，尚未启用");
  expect(sent).toHaveLength(1);
  expect(JSON.parse(String(sent[0].get("metadata")))).toEqual({
    password: "fixture-password",
    digest: "fixture",
    confirmation: "RESTORE TO NEW STORE",
  });
  expect((sent[0].get("archive") as File).name).toBe("backup.age");
});
