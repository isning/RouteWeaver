import { writeFile } from "node:fs/promises";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Worked expectations for processingPublicationFixture, not values copied from
// the preview response: two equal connections, source port 2080/region DE,
// deduplication retains London and merges provenance, final port 3080.
const stages = [
  { key: "raw", label: "原始输入 处理旅程来源", names: ["London", "Duplicate"], port: 1080, region: "" },
  { key: "source", label: "处理旅程来源 第 1 步：字段覆盖", names: ["London", "Duplicate"], port: 2080, region: "DE", changed: 2, removed: 0 },
  { key: "source-result", label: "来源结果 处理旅程来源", names: ["London", "Duplicate"], port: 2080, region: "DE" },
  { key: "merged", label: "有序合并", names: ["London", "Duplicate"], port: 2080, region: "DE" },
  { key: "deduplicate", label: "合并后 第 1 步：去除重复连接", names: ["London"], port: 2080, region: "DE", changed: 1, removed: 1 },
  { key: "aggregate", label: "合并后 第 2 步：字段覆盖", names: ["London"], port: 3080, region: "DE", changed: 1, removed: 0 },
];
type Stage = typeof stages[number];
const final: Stage = { key: "final", label: "最终结果", names: ["London"], port: 3080, region: "DE" };

async function resultPanel(sheet: Locator, stage: Stage) {
  const rail = sheet.getByRole("tablist", { name: "处理阶段", exact: true });
  const tab = rail.getByRole("tab", { name: stage.label, exact: true });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toBeFocused();
  const panel = sheet.getByRole("tabpanel", { name: stage.label, exact: true });
  await expect(sheet.getByRole("tabpanel")).toHaveCount(1);
  await expect(panel.getByRole("heading", { name: stage.label, exact: true })).toBeVisible();
  const rows = panel.getByRole("row");
  await expect(rows).toHaveCount(stage.names.length + 1);
  for (const [index, name] of stage.names.entries()) {
    await expect(rows.nth(index + 1).getByRole("cell")).toHaveText([
      name, `proxy.example.test:${stage.port}`, stage.region, "socks",
    ]);
  }
  if (stage.key !== "final") {
    await expect(panel.getByText(`${stage.names.length} 个节点`, { exact: true })).toBeVisible();
  }
  if (stage.changed !== undefined) {
    for (const fact of ["相对此步骤输入", "新增 0 个", `移除 ${stage.removed} 个`, `修改 ${stage.changed} 个`]) {
      await expect(panel.getByText(fact, { exact: true })).toBeVisible();
    }
  } else {
    // Raw/source-result/merged/final are snapshots, not additions measured
    // against an empty input or stale deltas carried over from another tab.
    await expect(panel.getByText(/相对此步骤输入|新增 \d+ 个|移除 \d+ 个|修改 \d+ 个/)).toHaveCount(0);
  }
  return { panel, tab };
}

async function captureStage(page: Page, sheet: Locator, stage: Stage, width: number, info: TestInfo) {
  const { panel, tab } = await resultPanel(sheet, stage);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  // Bring the actual preview into view without changing its layout, styles or
  // motion. Screenshots remain original viewport pixels, including the editor.
  await sheet.locator(".preview-result").scrollIntoViewIfNeeded();
  await settledTask(sheet);
  const geometry = await panel.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const heading = element.querySelector("h4")!.getBoundingClientRect();
    const table = element.querySelector("table")!.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      panel: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom },
      heading: { x: heading.x, y: heading.y, right: heading.right, bottom: heading.bottom },
      table: { x: table.x, y: table.y, right: table.right, bottom: table.bottom },
    };
  });
  const name = `processing-preview-${stage.key}-${width}`;
  const path = info.outputPath(`${name}.png`);
  // The fixture uses credential-free synthetic SOCKS endpoints. No access link,
  // generated feed, connection editor or authentication screen is captured.
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
  expect(geometry.documentWidth).toBeLessThanOrEqual(width + 1);
  expect(geometry.panel.x).toBeGreaterThanOrEqual(-1);
  expect(geometry.panel.right).toBeLessThanOrEqual(width + 1);
  await expect(tab).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole("heading", { name: stage.label, exact: true })).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole("cell", { name: `proxy.example.test:${stage.port}`, exact: true }).first()).toBeInViewport({ ratio: 1 });
  return {
    stage: await panel.getByRole("heading").innerText(),
    rows: await panel.getByRole("row").allTextContents(),
    text: await panel.innerText(),
    comparison: stage.changed === undefined ? "snapshot" : "step-input",
    geometry,
  };
}

export async function reviewProcessingStages(page: Page, sheet: Locator, info: TestInfo) {
  const rail = sheet.getByRole("tablist", { name: "处理阶段", exact: true });
  await expect(rail.getByRole("tab")).toHaveCount(7);
  const finalTab = rail.getByRole("tab", { name: "最终结果", exact: true });
  await expect(finalTab).toHaveAttribute("aria-selected", "true");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await finalTab.click();
    const observed = [await captureStage(page, sheet, final, width, info)];
    for (const stage of stages) {
      // Native keyboard traversal must reveal each selected tab in the
      // horizontal rail. No DOM click/evaluate activation or response mock.
      await page.keyboard.press("ArrowRight");
      observed.push(await captureStage(page, sheet, stage, width, info));
    }
    await page.keyboard.press("Home");
    await resultPanel(sheet, final);
    await page.keyboard.press("End");
    await resultPanel(sheet, stages[stages.length - 1]);
    // Pointer re-selection checks that snapshots do not retain step deltas.
    await rail.getByRole("tab", { name: "有序合并", exact: true }).click();
    await resultPanel(sheet, stages[3]);
    await finalTab.click();
    await resultPanel(sheet, final);
    const name = `processing-preview-evidence-${width}`;
    const path = info.outputPath(`${name}.json`);
    await writeFile(path, JSON.stringify({
      viewport: page.viewportSize(),
      observed,
      interaction: "Native ArrowRight, Home, End and pointer re-selection",
      scope: "Real isolated HTTP preview and rendered result table; synthetic fixture; no client loading or live deployment proof",
    }, null, 2));
    await info.attach(name, { path, contentType: "application/json" });
  }
  // The established save/reopen/publication journey continues once, unchanged.
  await page.setViewportSize({ width: 1440, height: 1000 });
}
