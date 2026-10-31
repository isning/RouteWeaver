// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceSelect, MultiChoice } from "./ui-patterns/choice-select";
import { UIProviders } from "./ui-patterns/providers";
afterEach(cleanup);
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
