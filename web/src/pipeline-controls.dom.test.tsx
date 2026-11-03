// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { StepsEditor } from "./Pipeline";
import type { PipelineStep } from "./types";
import { holdPopoverExit } from "./test-support/hold-popover-exit";

beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("exposes only the current stage choices while the previous choice popup exits", async () => {
  const finishExit = holdPopoverExit();
  function Stages() {
    const [source, setSource] = useState<PipelineStep[]>([]);
    const [merged, setMerged] = useState<PipelineStep[]>([]);
    return (
      <UIProviders>
        <StepsEditor label="来源处理" value={source} onChange={setSource} />
        <StepsEditor label="合并后处理" value={merged} onChange={setMerged} />
        <output aria-label="stage choices">
          {JSON.stringify({ source, merged })}
        </output>
      </UIProviders>
    );
  }
  render(<Stages />);
  const user = userEvent.setup();
  const source = screen.getByRole("group", { name: "来源处理" });
  const merged = screen.getByRole("group", { name: "合并后处理" });
  const first = within(source).getByRole("combobox", { name: "添加处理步骤" });
  await user.click(first);
  const closing = document.getElementById(
    first.getAttribute("aria-controls")!,
  )!;
  await user.click(screen.getByRole("option", { name: "字段覆盖" }));
  expect(closing.isConnected).toBe(true);
  expect(closing.getAttribute("data-state")).toBe("closed");
  expect(closing.hasAttribute("inert")).toBe(true);
  const second = within(merged).getByRole("combobox", { name: "添加处理步骤" });
  await user.click(second);
  expect(screen.getAllByRole("option", { name: "去除重复连接" })).toHaveLength(
    1,
  );
  const current = document.getElementById(
    second.getAttribute("aria-controls")!,
  )!;
  const search = within(current).getByRole("combobox", { name: "搜索选项" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  finishExit(closing);
  await waitFor(() => expect(closing.isConnected).toBe(false));
  expect(document.activeElement).toBe(search);
  await user.click(screen.getByRole("option", { name: "去除重复连接" }));
  const authored = JSON.parse(
    screen.getByLabelText("stage choices").textContent!,
  );
  expect(authored.source.map((step: PipelineStep) => step.kind)).toEqual([
    "override",
  ]);
  expect(authored.merged.map((step: PipelineStep) => step.kind)).toEqual([
    "deduplicate",
  ]);
});
function Editor() {
  const [steps, setSteps] = useState<PipelineStep[]>([
    {
      id: "rename",
      kind: "rename",
      enabled: false,
      template: "Prepared {name}",
    },
    { id: "dedupe", kind: "deduplicate", enabled: true },
    { id: "sort", kind: "sort", enabled: true, sortBy: "name" },
  ]);
  return (
    <UIProviders>
      <StepsEditor label="合并后处理" value={steps} onChange={setSteps} />
      <output aria-label="authored steps">{JSON.stringify(steps)}</output>
    </UIProviders>
  );
}
it("edits a stopped processing step without implicitly enabling execution; native switch keys toggle exactly once", async () => {
  render(<Editor />);
  const user = userEvent.setup();
  expect(screen.getByRole("group", { name: "合并后处理" })).toBeTruthy();
  expect(screen.getByText("已停用")).toBeTruthy();
  const field = screen.getByRole("textbox", { name: "步骤 1 命名模板" });
  // Stopped execution is not a disabled editing surface.
  expect(field.closest(".processing-step")?.className).not.toContain(
    "opacity-",
  );
  await user.clear(field);
  await user.paste("Ready {source}");
  const toggle = screen.getByRole("switch", { name: "启用步骤 1" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  toggle.focus();
  await user.keyboard("{Enter}");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await user.keyboard(" ");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(
    JSON.parse(screen.getByLabelText("authored steps").textContent!)[0],
  ).toEqual({
    id: "rename",
    kind: "rename",
    enabled: false,
    template: "Ready {source}",
  });
});
it("keeps each processing identity, execution state, fields and focus with its reordered action", async () => {
  render(<Editor />);
  const user = userEvent.setup();
  const down = screen.getByRole("button", { name: "下移步骤 1" });
  down.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "下移步骤 2" })).toBe(
    document.activeElement,
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "步骤 2 命名模板",
      }) as HTMLInputElement
    ).value,
  ).toBe("Prepared {name}");
  const steps = JSON.parse(
    screen.getByLabelText("authored steps").textContent!,
  );
  expect(steps.map((s: PipelineStep) => s.id)).toEqual([
    "dedupe",
    "rename",
    "sort",
  ]);
  expect(steps[1].enabled).toBe(false);
});
