// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceSelect, MultiChoice } from "./ui-patterns/choice-select";
import { UIProviders } from "./ui-patterns/providers";
import { useState } from "react";
import { holdPopoverExit } from "./test-support/hold-popover-exit";
import { TaskSheet } from "./ui-patterns/task-overlays";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])("returns an ordinary selection to its trigger inside a sheet (searchable=%s)", async (searchable) => {
  function Choices() {
    const [value, setValue] = useState<string>();
    return (
      <UIProviders>
        <TaskSheet open onOpenChange={() => {}} title="模板版本">
          <ChoiceSelect
            aria-label="检查的模板版本"
            value={value}
            onValueChange={setValue}
            searchable={searchable}
            options={[{ value: "2", label: "v2" }]}
          />
        </TaskSheet>
      </UIProviders>
    );
  }
  render(<Choices />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "检查的模板版本" });
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: "v2" }));
  expect(trigger.textContent).toContain("v2");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.getByRole("dialog", { name: "模板版本" })).toBeTruthy();
});

it("preserves a newer picker through delayed single-choice exit and restores its trigger on selection", async () => {
  const finishExit = holdPopoverExit();
  const options = [{ value: "remote", label: "远程办公" }];
  render(
    <UIProviders>
      <ChoiceSelect aria-label="第一项" options={options} />
      <ChoiceSelect aria-label="下一项" options={options} />
    </UIProviders>,
  );
  const user = userEvent.setup();
  const first = screen.getByRole("combobox", { name: "第一项" });
  await user.click(first);
  const closing = document.getElementById(first.getAttribute("aria-controls")!)!;
  await user.click(screen.getByRole("option", { name: "远程办公" }));
  expect(closing.isConnected).toBe(true);
  expect(closing.hasAttribute("inert")).toBe(true);
  const next = screen.getByRole("combobox", { name: "下一项" });
  await user.click(next);
  const search = screen.getByRole("combobox", { name: "搜索选项" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  finishExit(closing);
  await waitFor(() => expect(closing.isConnected).toBe(false));
  // Keyboard input crosses the deferred autofocus turn without refocusing the input.
  await user.keyboard("远程");
  expect(document.activeElement).toBe(search);
  expect(search).toHaveProperty("value", "远程");
  expect(next.getAttribute("aria-expanded")).toBe("true");
  const nextContent = document.getElementById(next.getAttribute("aria-controls")!)!;
  await user.click(screen.getByRole("option", { name: "远程办公" }));
  finishExit(nextContent);
  await waitFor(() => expect(document.activeElement).toBe(next));
});

it.each([false, true])("does not steal newer field focus during delayed exit (different dialog=%s)", async (differentDialog) => {
  const finishExit = holdPopoverExit();
  function Choices() {
    const [open, setOpen] = useState(false);
    return (
      <UIProviders>
        <ChoiceSelect aria-label="选项" options={[{ value: "2", label: "v2" }]} />
        {differentDialog ? (
          <>
            <button onClick={() => setOpen(true)}>打开新任务</button>
            <TaskSheet open={open} onOpenChange={setOpen} title="新任务">
              <input aria-label="新名称" />
            </TaskSheet>
          </>
        ) : <input aria-label="新名称" />}
      </UIProviders>
    );
  }
  render(<Choices />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "选项" });
  await user.click(trigger);
  const closing = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  await user.click(screen.getByRole("option", { name: "v2" }));
  expect(closing.isConnected).toBe(true);
  if (differentDialog) await user.click(screen.getByRole("button", { name: "打开新任务" }));
  const field = screen.getByRole("textbox", { name: "新名称" });
  await user.click(field);
  finishExit(closing);
  await waitFor(() => expect(closing.isConnected).toBe(false));
  await user.keyboard("new name");
  expect(document.activeElement).toBe(field);
  expect(field).toHaveProperty("value", "new name");
});

it("conceals a multi-choice exit without losing selected chips or stealing newer focus", async () => {
  const finishExit = holdPopoverExit();
  const options = [{ value: "remote", label: "远程办公" }];
  function Choices() {
    const [value, setValue] = useState<string[]>([]);
    return (
      <UIProviders>
        <MultiChoice
          aria-label="标签"
          value={value}
          onValueChange={setValue}
          options={options}
        />
        <ChoiceSelect aria-label="下一项" options={options} />
      </UIProviders>
    );
  }
  render(<Choices />);
  const user = userEvent.setup();
  const tags = screen.getByRole("combobox", { name: "标签" });
  await user.click(tags);
  const closing = document.getElementById(tags.getAttribute("aria-controls")!)!;
  await user.click(screen.getByRole("option", { name: "远程办公" }));
  await user.keyboard("{Escape}");
  expect(closing.isConnected).toBe(true);
  expect(closing.hasAttribute("inert")).toBe(true);
  expect(screen.queryByRole("option", { name: "远程办公" })).toBeNull();
  expect(screen.getByRole("button", { name: "移除 远程办公" })).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "下一项" }));
  const search = screen.getByRole("combobox", { name: "搜索选项" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  finishExit(closing);
  await waitFor(() => expect(closing.isConnected).toBe(false));
  expect(document.activeElement).toBe(search);
  expect(screen.getAllByRole("option", { name: "远程办公" })).toHaveLength(1);
  await user.keyboard("{Escape}");
  await user.click(tags);
  expect(
    screen
      .getByRole("option", { name: "远程办公" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "移除 远程办公" })).toBeTruthy();
});
it("bounds rendering while searching every endpoint identity and preserving explicit option names", async () => {
  const changed = vi.fn();
  const options = Array.from({ length: 2000 }, (_, i) => ({
    value: `endpoint-${i}`,
    label: (
      <>
        Shared endpoint <small>Region {i}</small>
      </>
    ),
    "aria-label": `Endpoint identity ${i}`,
  }));
  render(
    <UIProviders>
      <ChoiceSelect
        aria-label="Endpoint"
        options={options}
        onValueChange={changed}
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Endpoint" }));
  expect(screen.getAllByRole("option").length).toBeLessThan(50);
  await user.type(
    screen.getByRole("combobox", { name: "搜索选项" }),
    "endpoint-1999",
  );
  await user.click(
    await screen.findByRole("option", { name: "Endpoint identity 1999" }),
  );
  expect(changed).toHaveBeenCalledWith("endpoint-1999");
  await user.click(screen.getByRole("combobox", { name: "Endpoint" }));
  expect(screen.getByRole("combobox", { name: "搜索选项" })).toHaveProperty(
    "value",
    "",
  );
});
it("searches multi-choice without truncating inventory and retains freeform creation", async () => {
  const changed = vi.fn();
  render(
    <UIProviders>
      <MultiChoice
        aria-label="Tags"
        value={null}
        options={Array.from({ length: 100 }, (_, i) => ({
          value: `tag-${i}`,
          label: `Tag ${i}`,
        }))}
        onValueChange={changed}
        creatable
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Tags" }));
  expect(screen.getAllByRole("option").length).toBeLessThan(50);
  await user.type(screen.getByRole("combobox", { name: "搜索选项" }), "tag-99");
  await user.click(await screen.findByRole("option", { name: "Tag 99" }));
  expect(changed).toHaveBeenCalledWith(["tag-99"]);
  await user.clear(screen.getByRole("combobox", { name: "搜索选项" }));
  await user.type(
    screen.getByRole("combobox", { name: "搜索选项" }),
    "custom-tag",
  );
  await user.click(screen.getByRole("option", { name: "添加“custom-tag”" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(["custom-tag"]));
});

it("preserves repeated selected references and removes only the chosen occurrence", async () => {
  const errors = vi.spyOn(console, "error");
  const changed = vi.fn();
  function Choices() {
    const [value, setValue] = useState(["north", "south", "north"]);
    return (
      <UIProviders>
        <MultiChoice
          aria-label="Fixed members"
          value={value}
          options={[
            { value: "north", label: "North Gate" },
            { value: "south", label: "South Gate" },
          ]}
          onValueChange={(next) => {
            changed(next);
            setValue(next);
          }}
        />
      </UIProviders>
    );
  }
  render(<Choices />);
  expect(
    screen.getByRole("combobox", { name: "Fixed members" }).textContent,
  ).toContain("已选择 3 项");
  expect(
    screen.getAllByRole("button", { name: "移除 North Gate" }),
  ).toHaveLength(2);
  const user = userEvent.setup();
  await user.click(
    screen.getAllByRole("button", { name: "移除 North Gate" })[1],
  );
  expect(changed).toHaveBeenLastCalledWith(["north", "south"]);
  expect(
    screen.getAllByRole("button", { name: "移除 North Gate" }),
  ).toHaveLength(1);
  expect(
    screen.getAllByRole("button", { name: "移除 South Gate" }),
  ).toHaveLength(1);
  expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
});

it("closes an open choice when its task becomes unavailable without changing the draft", async () => {
  const changed = vi.fn();
  const openChanged = vi.fn();
  const blurred = vi.fn();
  const choices = (disabled: boolean) => (
    <UIProviders>
      <ChoiceSelect
        aria-label="上游连接器"
        value="first"
        options={[
          { value: "first", label: "当前出口" },
          { value: "second", label: "备用出口" },
        ]}
        disabled={disabled}
        clearable
        onValueChange={changed}
        onOpenChange={openChanged}
        onBlur={blurred}
      />
    </UIProviders>
  );
  const view = render(choices(false));
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "上游连接器" });
  await user.click(trigger);
  await user.type(screen.getByRole("combobox", { name: "搜索选项" }), "备用");
  view.rerender(choices(true));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("option")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(openChanged).toHaveBeenLastCalledWith(false);
  expect(blurred).toHaveBeenCalledTimes(1);
  view.rerender(choices(false));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await user.click(trigger);
  expect(screen.getByRole("combobox", { name: "搜索选项" })).toHaveProperty("value", "");
  await user.click(screen.getByRole("option", { name: "备用出口" }));
  expect(changed).toHaveBeenCalledExactlyOnceWith("second");
});

it("ends a multi-choice edit when disabled and retains the selected tags", async () => {
  const changed = vi.fn();
  const openChanged = vi.fn();
  const blurred = vi.fn();
  const choices = (disabled: boolean) => (
    <UIProviders>
      <MultiChoice
        aria-label="服务器标签"
        value={["current"]}
        options={[{ value: "current", label: "当前标签" }]}
        disabled={disabled}
        clearable
        creatable
        onValueChange={changed}
        onOpenChange={openChanged}
        onBlur={blurred}
      />
    </UIProviders>
  );
  const view = render(choices(false));
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "服务器标签" });
  await user.click(trigger);
  await user.type(screen.getByRole("combobox", { name: "搜索选项" }), "新标签");
  expect(screen.getByRole("option", { name: "添加“新标签”" })).toBeTruthy();
  view.rerender(choices(true));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("option")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(openChanged).toHaveBeenLastCalledWith(false);
  expect(blurred).toHaveBeenCalledTimes(1);
  expect(screen.getByText("当前标签")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "移除 当前标签" })).toBeNull();
  view.rerender(choices(false));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await user.click(trigger);
  expect(screen.getByRole("combobox", { name: "搜索选项" })).toHaveProperty("value", "");
  await user.type(screen.getByRole("combobox", { name: "搜索选项" }), "新标签");
  await user.click(screen.getByRole("option", { name: "添加“新标签”" }));
  expect(changed).toHaveBeenCalledExactlyOnceWith(["current", "新标签"]);
});

it("selects the searched server with Enter instead of clearing the existing server", async () => {
  const changed = vi.fn();
  render(
    <UIProviders>
      <ChoiceSelect
        aria-label="Server"
        value="synthetic-server-east-0001"
        clearable
        onValueChange={changed}
        options={[
          { value: "synthetic-server-east-0001", label: "Shared server East" },
          { value: "synthetic-server-west-0002", label: "Shared server West" },
        ]}
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Server" }));
  await user.type(screen.getByRole("combobox", { name: "搜索选项" }), "synthetic-server-west-0002");
  await user.keyboard("{Enter}");
  expect(changed).toHaveBeenCalledExactlyOnceWith("synthetic-server-west-0002");
});

it.each(["missing-server", "disabled-server"])("retains the current server when Enter has no enabled search result (%s)", async (query) => {
  const changed = vi.fn();
  render(
    <UIProviders>
      <ChoiceSelect
        aria-label="Server"
        value="current-server"
        clearable
        onValueChange={changed}
        options={[
          { value: "current-server", label: "Current server" },
          { value: "disabled-server", label: "Unavailable server", disabled: true },
        ]}
      />
    </UIProviders>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: "Server" });
  await user.click(trigger);
  const search = screen.getByRole("combobox", { name: "搜索选项" });
  await user.type(search, query);
  expect(screen.queryByRole("option", { name: "清除选择" })).toBeNull();
  if (query === "missing-server") {
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByText("没有匹配的选项")).toBeTruthy();
  } else {
    expect(screen.getByRole("option", { name: "Unavailable server" }).getAttribute("aria-disabled")).toBe("true");
  }
  await user.keyboard("{Enter}");
  expect(changed).not.toHaveBeenCalled();
  expect(trigger.textContent).toContain("Current server");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await user.clear(search);
  await user.click(screen.getByRole("option", { name: "清除选择" }));
  expect(changed).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
