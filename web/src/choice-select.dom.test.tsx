// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceSelect, MultiChoice } from "./ui-patterns/choice-select";
import { UIProviders } from "./ui-patterns/providers";
import { useState } from "react";
import { holdPopoverExit } from "./test-support/hold-popover-exit";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
