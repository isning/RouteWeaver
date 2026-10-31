import { test, expect, type Page } from "@playwright/test";
import { openWorkspace, navigateWorkspace } from "./ui-session";
async function editor(page: Page) {
  await openWorkspace(page);
  await navigateWorkspace(page, "连接端点");
  await page
    .getByRole("button", { name: "添加端点", exact: true })
    .first()
    .click();
  return page.getByRole("dialog", { name: "添加端点", exact: true });
}

test("retains hidden advanced fields while keeping long endpoint actions visible at desktop and mobile sizes", async ({
  page,
}) => {
  const dialog = await editor(page);
  const metadata = dialog.getByRole("button", {
    name: "核心与标签",
    exact: true,
  });
  const core = dialog.getByLabel("核心实例 ID", { exact: true });
  await expect(metadata).toHaveAttribute("aria-expanded", "false");
  await expect(core).toHaveCount(1);
  await expect(core).toBeHidden();
  await metadata.click();
  await expect(core).toBeVisible();
  await core.fill("retained-core");
  await metadata.click();
  await expect(core).toBeHidden();
  await metadata.click();
  await expect(core).toHaveValue("retained-core");
  await metadata.click();
  await dialog.getByLabel("协议", { exact: true }).click();
  await page.getByRole("option", { name: "VLESS", exact: true }).click();
  await dialog.getByRole("radio", { name: "TLS", exact: true }).click();
  await dialog.getByLabel("传输方式", { exact: true }).click();
  await page.getByRole("option", { name: "WebSocket", exact: true }).click();
  await dialog
    .getByRole("button", { name: "自定义请求头", exact: true })
    .click();
  await dialog.getByRole("button", { name: "添加请求头", exact: true }).click();
  const headers = dialog.getByRole("button", {
    name: "添加请求头",
    exact: true,
  });
  const headerContent = headers.locator(
    'xpath=ancestor::*[@data-slot="accordion-content"]',
  );
  for (const [index, name] of ["X-Client", "X-Region", "X-Trace"].entries()) {
    if (index > 0) await headers.click();
    await dialog
      .getByLabel("请求头名称", { exact: true })
      .nth(index)
      .fill(name);
    await dialog
      .getByLabel("请求头值", { exact: true })
      .nth(index)
      .fill(`retained-${index}`);
  }
  const expectNaturalHeaderHeight = async () => {
    await expect
      .poll(() =>
        headerContent.evaluate((outer) => {
          const inner = outer.firstElementChild as HTMLElement;
          return (
            inner.scrollHeight <= inner.clientHeight + 1 &&
            outer.scrollHeight <= outer.clientHeight + 1
          );
        }),
      )
      .toBe(true);
  };
  await expectNaturalHeaderHeight();
  await dialog
    .getByRole("button", { name: "自定义请求头", exact: true })
    .click();
  await expect(
    dialog.getByLabel("请求头名称", { exact: true }).first(),
  ).toBeHidden();
  await dialog
    .getByRole("button", { name: "自定义请求头", exact: true })
    .click();
  await expect(
    dialog.getByLabel("请求头值", { exact: true }).nth(2),
  ).toHaveValue("retained-2");
  await dialog
    .getByRole("button", { name: "移除请求头 2", exact: true })
    .click();
  await expect(dialog.getByLabel("请求头名称", { exact: true })).toHaveCount(2);
  await expect(
    dialog.getByLabel("请求头名称", { exact: true }).nth(1),
  ).toHaveValue("X-Trace");
  await expect(
    dialog.getByLabel("请求头名称", { exact: true }).nth(1),
  ).toBeFocused();
  await expectNaturalHeaderHeight();
  for (const viewport of [
    { width: 1170, height: 749 },
    { width: 390, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNaturalHeaderHeight();
    const save = dialog.getByRole("button", { name: "保存", exact: true });
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    const body = dialog.locator("[data-task-overlay-body]");
    await expect(save).toBeInViewport({ ratio: 1 });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () =>
        save.evaluate(
          (button: HTMLButtonElement) =>
            !!button.form && !button.closest("[data-task-overlay-body]"),
        ),
      )
      .toBe(true);
    await body.hover();
    await page.mouse.wheel(0, 1200);
    await expect(save).toBeInViewport({ ratio: 1 });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    // Focusing/expanding a bottom disclosure must scroll only the body, never
    // the clipped outer dialog (otherwise the title/close leave the viewport).
    await metadata.click();
    await expect(core).toBeVisible();
    await core.focus();
    await expect(
      dialog.getByRole("heading", { name: "添加端点", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(dialog).toHaveJSProperty("scrollTop", 0);
    await expect(save).toBeInViewport({ ratio: 1 });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    await metadata.click();
    await expect(page.locator("body")).toHaveJSProperty(
      "scrollWidth",
      viewport.width,
    );
  }
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true })
    .getByRole("button", { name: "放弃修改", exact: true })
    .click();
  await expect(dialog).toBeHidden();
});

test("native Enter submits the associated pinned footer once and retains the draft after rejected save", async ({
  page,
}) => {
  let count = 0;
  let release!: () => void;
  await page.route("**/api/nodes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    count++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "synthetic endpoint save rejected" }),
    });
  });
  const dialog = await editor(page);
  await dialog
    .getByLabel("端点名称", { exact: true })
    .fill("native-submit-fixture");
  await dialog.getByLabel("连接地址", { exact: true }).fill("endpoint.test");
  const submit = dialog.getByRole("button", { name: "保存", exact: true });
  await expect
    .poll(() =>
      submit.evaluate(
        (button: HTMLButtonElement) => button.form?.contains(button) === false,
      ),
    )
    .toBe(true);
  await dialog.getByLabel("连接地址", { exact: true }).press("Enter");
  await expect.poll(() => count).toBe(1);
  await expect(submit).toHaveAttribute("aria-busy", "true");
  await expect(submit).toBeFocused();
  await submit.press("Enter");
  expect(count).toBe(1);
  release();
  await expect(
    dialog.getByText("synthetic endpoint save rejected"),
  ).toBeVisible();
  await expect(dialog.getByLabel("端点名称", { exact: true })).toHaveValue(
    "native-submit-fixture",
  );
  await expect(submit).not.toHaveAttribute("aria-busy", "true");
});

test("semantic token conversion agrees with real Chromium sRGB pixels", async ({
  page,
}) => {
  await openWorkspace(page);
  const samples = await page.evaluate(() =>
    ["--muted-foreground", "--destructive"].map((name) => {
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      const values = color
        .match(/oklch\(([^)]+)\)/)?.[1]
        .split(/\s+/)
        .map(Number);
      if (!values) throw new Error(`Missing token ${name}`);
      const [L, C, h] = values,
        a = C * Math.cos((h * Math.PI) / 180),
        b = C * Math.sin((h * Math.PI) / 180),
        l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
        m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
        s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
      const linear = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ];
      const expected = linear.map((v) =>
        Math.round(
          (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255,
        ),
      );
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return {
        name,
        expected,
        actual: Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3),
        inGamut: linear.every((v) => v >= 0 && v <= 1),
      };
    }),
  );
  for (const sample of samples) {
    expect(sample.inGamut, sample.name).toBe(true);
    sample.actual.forEach((value, index) =>
      expect(
        Math.abs(value - sample.expected[index]),
        sample.name,
      ).toBeLessThanOrEqual(1),
    );
  }
});
