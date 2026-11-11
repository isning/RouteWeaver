// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { AppField, AppForm } from "./ui-patterns/form";
import { TaskSheet } from "./ui-patterns/task-overlays";
import { MultiChoice } from "./ui-patterns/choice-select";
import { FilterFields, StepsEditor } from "./Pipeline";
import type { EndpointFilter, PipelineStep, Service } from "./types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { UIProviders } from "./ui-patterns/providers";
import { holdPopoverExit } from "./test-support/hold-popover-exit";

const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "adds another processing filter tag after Escape and an immediate same-trigger reopen (retained exit=%s)",
  async (retainedExit) => {
    const finishExit = retainedExit ? holdPopoverExit() : undefined;
    function ProcessingDraft() {
      const [steps, setSteps] = useState<PipelineStep[]>([
        {
          id: "keep-office",
          kind: "keep",
          enabled: false,
          filter: { namePattern: "Office", region: "HK", tags: ["remote"] },
        },
      ]);
      return (
        <UIProviders>
          <StepsEditor label="来源处理" value={steps} onChange={setSteps} />
          <output aria-label="处理草稿">{JSON.stringify(steps)}</output>
        </UIProviders>
      );
    }
    render(<ProcessingDraft />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox", { name: /包含标签/ });
    await user.click(trigger);
    const content = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    )!;
    await user.keyboard("backup{Enter}");
    expect(screen.getByRole("button", { name: "移除 backup" })).toBeTruthy();
    await user.keyboard("unfinished{Escape}");
    if (retainedExit) {
      expect(content.isConnected).toBe(true);
      expect(content.hasAttribute("inert")).toBe(true);
    }
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // This click, rather than forced focus, owns the next editing interaction.
    await user.click(trigger);
    const search = screen.getByRole("combobox", { name: "搜索选项" });
    const reopenedContent = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    )!;
    expect(search).toHaveProperty("value", "");
    await waitFor(() => expect(document.activeElement).toBe(search));
    await user.keyboard("travel{Enter}");
    expect(screen.getByRole("button", { name: "移除 travel" })).toBeTruthy();
    expect(JSON.parse(screen.getByLabelText("处理草稿").textContent!)).toEqual([
      {
        id: "keep-office",
        kind: "keep",
        enabled: false,
        filter: {
          namePattern: "Office",
          region: "HK",
          tags: ["remote", "backup", "travel"],
        },
      },
    ]);
    await user.keyboard("{Escape}");
    finishExit?.(reopenedContent);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  },
);

it("previews exactly the selected service routes after reopening and toggling choices", async () => {
  const finishExit = holdPopoverExit();
  const service: Service = {
    id: "office",
    name: "Office",
    quotaBytes: 0,
    routeIds: ["north"],
    onlineIpLimit: 0,
    connectionLimit: 0,
    entryRateBps: 0,
    cycle: {
      mode: "none",
      anchor: "2026-01-01T00:00:00+08:00",
      timezone: "Asia/Shanghai",
    },
  };
  const requests: { path: string; body: { change: { service: Service } } }[] =
    [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/access-policy/edit-context/service/office")
      return json({
        target: { kind: "service", id: "office" },
        record: { service },
        precondition: { exists: true, revision: "opened-office" },
      });
    if (url === "/api/access-policy/preview") {
      const body = JSON.parse(String(init?.body));
      requests.push({ path: url, body });
      return json({
        revision: "review-office",
        affected: [],
        blockers: [],
        guard: "opened-record",
        resource: {
          target: { kind: "service", id: "office" },
          before: { service },
          after: { service: body.change.service },
        },
      });
    }
    throw new Error(`Unexpected policy request: ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ServicePolicyEditor
          initial={service}
          services={[service]}
          users={[]}
          routes={[
            { id: "north", name: "North" },
            { id: "east", name: "East" },
            { id: "west", name: "West" },
          ]}
          onClose={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const name = await screen.findByRole("textbox", { name: "服务方案名称" });
  await user.clear(name);
  await user.type(name, "Office draft");
  const trigger = screen.getByRole("combobox", { name: "方案授权线路" });
  await user.click(trigger);
  const content = document.getElementById(
    trigger.getAttribute("aria-controls")!,
  )!;
  await user.keyboard("East{Enter}{Escape}");
  expect(screen.getByRole("button", { name: "移除 North" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "移除 East" })).toBeTruthy();
  expect(content.hasAttribute("inert")).toBe(true);
  await user.click(trigger);
  const search = screen.getByRole("combobox", { name: "搜索选项" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  await user.keyboard("West{Enter}");
  expect(screen.getByRole("button", { name: "移除 West" })).toBeTruthy();
  await user.keyboard("{Control>}a{/Control}East{Enter}");
  expect(screen.queryByRole("button", { name: "移除 East" })).toBeNull();
  await user.keyboard("{Escape}");
  finishExit(content);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.click(screen.getByRole("button", { name: "移除 North" }));
  await user.click(screen.getByRole("button", { name: "预览影响" }));
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(
    within(review).getByRole("table", { name: "方案变更" }).textContent,
  ).toContain("west");
  expect(requests).toEqual([
    {
      path: "/api/access-policy/preview",
      body: {
        change: {
          service: { ...service, name: "Office draft", routeIds: ["west"] },
        },
        precondition: { exists: true, revision: "opened-office" },
      },
    },
  ]);
});

it.each(["field", "picker"])(
  "keeps the newer processing %s focused when the reopened tag picker finishes closing",
  async (destination) => {
    const finishExit = holdPopoverExit();
    function FilterDraft() {
      const [filter, setFilter] = useState<EndpointFilter>({
        namePattern: "Office",
        region: "HK",
        tags: ["remote"],
      });
      return (
        <UIProviders>
          <TaskSheet open onOpenChange={() => {}} title="处理条件">
            <FilterFields value={filter} onChange={setFilter} />
            <output aria-label="条件草稿">{JSON.stringify(filter)}</output>
          </TaskSheet>
        </UIProviders>
      );
    }
    render(<FilterDraft />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox", { name: /包含标签/ });
    await user.click(trigger);
    const content = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    )!;
    await user.keyboard("{Escape}");
    await user.click(trigger);
    await user.keyboard("backup{Enter}{Escape}");
    expect(content.hasAttribute("inert")).toBe(true);
    if (destination === "field") {
      const field = screen.getByRole("textbox", { name: "地区" });
      await user.click(field);
      finishExit(content);
      await waitFor(() => expect(content.isConnected).toBe(false));
      await user.keyboard(" West");
      expect(document.activeElement).toBe(field);
      expect(
        JSON.parse(screen.getByLabelText("条件草稿").textContent!),
      ).toEqual({
        namePattern: "Office",
        region: "HK West",
        tags: ["remote", "backup"],
      });
    } else {
      const next = screen.getByRole("combobox", { name: /连接协议/ });
      await user.click(next);
      const search = screen.getByRole("combobox", { name: "搜索选项" });
      await waitFor(() => expect(document.activeElement).toBe(search));
      finishExit(content);
      await waitFor(() => expect(content.isConnected).toBe(false));
      await user.keyboard("vless");
      expect(document.activeElement).toBe(search);
      expect(search).toHaveProperty("value", "vless");
      await user.keyboard("{Enter}");
      expect(
        JSON.parse(screen.getByLabelText("条件草稿").textContent!),
      ).toEqual({
        namePattern: "Office",
        region: "HK",
        tags: ["remote", "backup"],
        protocol: "vless",
      });
    }
  },
);

it.each([false, true])(
  "ends a locked tag edit and resumes with the exact retained selections and a fresh query (exit finished=%s)",
  async (finishBeforeUnlock) => {
    const finishExit = holdPopoverExit();
    function TagDraft({ disabled }: { disabled: boolean }) {
      const [submitted, setSubmitted] = useState<unknown>(null);
      return (
        <UIProviders>
          <TaskSheet open onOpenChange={() => {}} title="服务器标签">
            <AppForm
              disabled={disabled}
              initialValues={{ tags: ["retained", "retained"] }}
              onFinish={setSubmitted}
            >
              <AppField name="tags" label="标签" trigger="onValueChange">
                <MultiChoice
                  creatable
                  clearable
                  options={[{ value: "retained", label: "保留标签" }]}
                />
              </AppField>
              <button type="submit" disabled={disabled}>
                保存标签
              </button>
            </AppForm>
            <output aria-label="保存的标签">{JSON.stringify(submitted)}</output>
          </TaskSheet>
        </UIProviders>
      );
    }
    const view = render(<TagDraft disabled={false} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox", { name: "标签" });
    await user.click(trigger);
    const content = document.getElementById(
      trigger.getAttribute("aria-controls")!,
    )!;
    await user.keyboard("{Escape}");
    await user.click(trigger);
    await user.keyboard("unfinished");
    view.rerender(<TagDraft disabled />);
    expect(trigger).toHaveProperty("disabled", true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(content.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByRole("button", { name: "移除 保留标签" })).toBeNull();
    expect(screen.queryByRole("button", { name: "清除全部" })).toBeNull();
    if (finishBeforeUnlock) {
      finishExit(content);
      await waitFor(() => expect(content.isConnected).toBe(false));
      expect(document.activeElement).not.toBe(trigger);
    }
    view.rerender(<TagDraft disabled={false} />);
    expect(
      screen.getAllByRole("button", { name: "移除 保留标签" }),
    ).toHaveLength(2);
    await user.click(trigger);
    expect(screen.getByRole("combobox", { name: "搜索选项" })).toHaveProperty(
      "value",
      "",
    );
    await user.keyboard("new-tag{Enter}{Escape}");
    await user.click(screen.getByRole("button", { name: "保存标签" }));
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByLabelText("保存的标签").textContent!),
      ).toEqual({ tags: ["retained", "retained", "new-tag"] }),
    );
  },
);
