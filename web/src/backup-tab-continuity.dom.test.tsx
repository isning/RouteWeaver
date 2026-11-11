// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminPage } from "./Admin";
import { UIProviders } from "./ui-patterns/providers";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

// Public AdminPage tabs and synthetic HTTP responses only. No real archive,
// restore directory, credentials or database are used by these journeys.
it.each(["before departure", "while hidden"] as const)(
  "keeps an uncertain restore and its operator-check gate when it settles %s during a local tab visit",
  async (settles) => {
    const uncertainTarget = `restore_${"a".repeat(43)}.db`;
    const nextTarget = `restore_${"b".repeat(43)}.db`;
    const password = "synthetic-backup-password";
    const archive = new File(["synthetic archive"], "recovery-fixture.age", {
      type: "application/octet-stream",
    });
    let completeRestore!: (response: Response) => void;
    const firstRestore = new Promise<Response>((resolve) => { completeRestore = resolve; });
    const uncertainResponse = json({
      detail: "publication uncertain",
      restoreOutcome: "uncertain",
      target: uncertainTarget,
      activated: false,
    }, 500);
    const previews: FormData[] = [];
    const restores: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/settings") return json({
        name: "RouteWeaver", timezone: "UTC+8", registration: "invite",
      });
      if (path === "/api/admin/subscription-origin") return json({
        revision: 1,
        configuredRevision: 1,
        draftOrigin: "",
        effectiveRevision: 1,
        effectiveOrigin: "",
        defaultOrigin: "",
        currentLinkExample: "/feed/{existing-token}",
        proposedLinkExample: "/feed/{existing-token}",
        verificationStatus: "not-required",
        tokensUnchanged: true,
      });
      if (path === "/api/admin/backups/preview" && init?.method === "POST") {
        previews.push(init.body as FormData);
        return json({
          manifest: { schemaVersion: 2, createdAt: "2026-10-01T00:00:00Z" },
          digest: "synthetic-reviewed-archive",
          counts: { records: 1 },
          restoreAvailable: true,
        });
      }
      if (path === "/api/admin/backups/restore" && init?.method === "POST") {
        restores.push(init.body as FormData);
        return restores.length === 1 ? firstRestore : json({
          status: "restored", target: nextTarget, activated: false,
        }, 201);
      }
      throw new Error(`Unexpected HTTP request: ${init?.method || "GET"} ${path}`);
    }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    clients.push(client);
    render(<QueryClientProvider client={client}>
      <UIProviders><AdminPage page="settings" /></UIProviders>
    </QueryClientProvider>);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "编辑平台名称" });
    await user.click(screen.getByRole("tab", { name: "备份与恢复" }));
    await user.upload(screen.getByLabelText("选择加密备份"), archive);
    fireEvent.change(screen.getByLabelText("备份密码"), { target: { value: password } });
    const inspect = () => screen.getByRole("button", { name: "校验备份并查看影响" });
    const restore = () => screen.getByRole("button", { name: "恢复到新数据库" }) as HTMLButtonElement;
    const confirmation = () => screen.getByLabelText("输入“恢复到新数据库”以确认") as HTMLInputElement;
    const enterConfirmation = () => fireEvent.change(confirmation(), {
      target: { value: "恢复到新数据库" },
    });
    await user.click(inspect());
    await screen.findByText("文件校验通过");
    enterConfirmation();
    await user.click(restore());
    await waitFor(() => expect(restores).toHaveLength(1));

    if (settles === "before departure") {
      await act(async () => { completeRestore(uncertainResponse); });
      await screen.findByText("恢复结果尚未确认");
      expect(screen.getByText(`待检查目标：${uncertainTarget}`)).toBeTruthy();
    }
    await user.click(screen.getByRole("tab", { name: "基本设置" }));
    expect(screen.queryByRole("region", { name: "备份与恢复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "恢复到新数据库" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Work in the newly selected tab while the earlier restore may still settle.
    await user.click(screen.getByRole("button", { name: "编辑平台名称" }));
    const currentName = await screen.findByLabelText("平台名称") as HTMLInputElement;
    expect(document.activeElement).toBe(currentName);
    if (settles === "while hidden") {
      await act(async () => { completeRestore(uncertainResponse); });
      // Observe consumption at the HTTP boundary, not the mutation's internals.
      await waitFor(() => expect(uncertainResponse.bodyUsed).toBe(true));
    }
    expect(document.activeElement).toBe(currentName);
    await user.type(currentName, "X");
    expect(currentName.value).toBe("RouteWeaverX");
    expect(document.activeElement).toBe(currentName);
    expect(previews).toHaveLength(1);
    expect(restores).toHaveLength(1);

    await user.click(screen.getByRole("tab", { name: "备份与恢复" }));
    await screen.findByText("恢复结果尚未确认");
    expect(screen.getByText(`待检查目标：${uncertainTarget}`)).toBeTruthy();
    expect(screen.getByText("recovery-fixture.age", { exact: true })).toBeTruthy();
    expect((screen.getByLabelText("备份密码") as HTMLInputElement).value).toBe(password);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "备份与恢复" }));
    expect(confirmation().value).toBe("");

    // Reinspection is allowed, but cannot reconcile an uncertain restore.
    await user.click(inspect());
    await screen.findByText("文件校验通过");
    enterConfirmation();
    expect(restore().disabled).toBe(true);
    await user.click(restore());
    expect(screen.getByText(`待检查目标：${uncertainTarget}`)).toBeTruthy();
    expect(previews).toHaveLength(2);
    expect(restores).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "已检查，允许再次恢复" }));
    expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
    expect(screen.getByText("此前恢复的人工检查记录")).toBeTruthy();
    expect(screen.queryByText("文件校验通过")).toBeNull();
    expect(screen.queryByRole("button", { name: "恢复到新数据库" })).toBeNull();
    expect(screen.queryByLabelText("输入“恢复到新数据库”以确认")).toBeNull();
    expect(restores).toHaveLength(1);

    // The acknowledgement ends the old review, so a fresh preview and new typed
    // confirmation are required before exactly one new restore can be sent.
    await user.click(inspect());
    await screen.findByText("文件校验通过");
    expect(previews).toHaveLength(3);
    expect(confirmation().value).toBe("");
    expect(restore().disabled).toBe(true);
    enterConfirmation();
    await user.click(restore());
    await screen.findByText("已恢复到新数据库，尚未启用");
    expect(restores).toHaveLength(2);
    expect((restores[1].get("archive") as File).name).toBe("recovery-fixture.age");
    expect(JSON.parse(String(restores[1].get("metadata")))).toEqual({
      password,
      digest: "synthetic-reviewed-archive",
      confirmation: "RESTORE TO NEW STORE",
    });
    expect(screen.queryByText("恢复结果尚未确认")).toBeNull();
    expect(screen.getByText("此前恢复的人工检查记录")).toBeTruthy();
    expect((screen.getByLabelText("备份密码") as HTMLInputElement).value).toBe("");
  },
);
