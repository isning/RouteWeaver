// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import { ChoiceSelect, MultiChoice } from "./ui-patterns/choice-select";
import { PageHeader } from "./components";
import { SourceSelectionIssues } from "./SourceSelectionIssues";
import type { Source } from "./types";

afterEach(cleanup);
async function styles(assert: () => void) {
  const style = document.createElement("style");
  style.textContent = (
    await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")
  ).build(
    [...document.body.querySelectorAll<HTMLElement>("[class]")].flatMap(
      (node) => [...node.classList],
    ),
  );
  document.head.append(style);
  try {
    assert();
  } finally {
    style.remove();
  }
}
it("choice triggers retain a real touch target and grow with enlarged text", async () => {
  render(
    <>
      <ChoiceSelect
        aria-label="默认流量行为"
        value="direct"
        options={[{ value: "direct", label: "直连" }]}
      />
      <MultiChoice
        aria-label="固定成员"
        value={["direct"]}
        options={[{ value: "direct", label: "直连" }]}
      />
    </>,
  );
  await styles(() => {
    for (const control of screen.getAllByRole("combobox")) {
      expect(getComputedStyle(control).height).toBe("auto");
      expect(getComputedStyle(control).minHeight).toBe(
        "calc(var(--spacing) * 11)",
      );
      expect(getComputedStyle(control).whiteSpace).toBe("normal");
    }
    const selected = screen.getByText("直连", {
      selector: "[data-slot=badge] span",
    });
    expect(getComputedStyle(selected).whiteSpace).toBe("normal");
    expect(getComputedStyle(selected).overflow).not.toBe("hidden");
  });
});
it("source repairs and page return use full task hit targets rather than compact vendor buttons", async () => {
  render(
    <>
      <PageHeader title="编辑配置" back={() => {}} />
      <SourceSelectionIssues
        sources={[
          {
            id: "source-one",
            name: "待修复来源",
            enabled: true,
            refreshStatus: "failed",
          } as Source,
        ]}
        onRepair={() => {}}
        onRemove={() => {}}
      />
    </>,
  );
  await styles(() => {
    for (const control of screen.getAllByRole("button")) {
      expect(getComputedStyle(control).height).toBe("auto");
      expect(getComputedStyle(control).minHeight).toBe(
        "calc(var(--spacing) * 11)",
      );
      expect(getComputedStyle(control).minWidth).toBe(
        "calc(var(--spacing) * 11)",
      );
    }
  });
});
