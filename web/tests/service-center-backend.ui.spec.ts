import { type Locator, type Page } from "@playwright/test";
import jsQR from "jsqr";
import { test, expect } from "./isolated-control-plane-fixture";
import { initialPassword, requireLoopback } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";
import {
  routeName,
  selectedName,
  serviceName,
  serviceCenterFixture,
} from "./service-center-backend";

// Credentials and feed URLs stay in memory: no persisted trace, screenshot or video.
test.use({ trace: "off", screenshot: "off", video: "off" });
async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let i = 0; i < 80; i++) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Required service-center action is not reachable by Tab");
}
async function activate(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}
// Observe delivery bytes, not clipboard calls or the SVG's input props. The
// scratch textarea belongs to this test and stays inside the modal focus trap.
async function expectDeliveryBytes(
  page: Page,
  access: Locator,
  expectedURL: string,
) {
  await expect
    .poll(
      async () =>
        (await access
          .getByRole("textbox", { name: "订阅链接", exact: true })
          .inputValue()) === expectedURL,
    )
    .toBe(true);
  await access.evaluate((dialog) => {
    const paste = document.createElement("textarea");
    paste.dataset.deliveryPaste = "true";
    paste.setAttribute("aria-label", "Synthetic delivery clipboard probe");
    dialog.append(paste);
  });
  const paste = access.locator("textarea[data-delivery-paste]");
  try {
    // A fresh non-URL sentinel prevents an unchanged clipboard from satisfying
    // a later reopen of the same URL. All copy/paste input is trusted keyboard.
    await paste.fill("synthetic clipboard sentinel");
    await paste.press("ControlOrMeta+a");
    await paste.press("ControlOrMeta+c");
    await paste.fill("");
    await paste.press("ControlOrMeta+v");
    expect(
      (await paste.inputValue()) === "synthetic clipboard sentinel",
      "Trusted copy/paste must establish a fresh clipboard sentinel",
    ).toBe(true);
    await activate(
      page,
      access.getByRole("button", {
        name: "复制订阅链接",
        exact: true,
      }),
    );
    await expect
      .poll(
        async () => {
          await paste.fill("");
          await paste.press("ControlOrMeta+v");
          return Buffer.from(await paste.inputValue(), "utf8").equals(
            Buffer.from(expectedURL, "utf8"),
          );
        },
        {
          message:
            "Trusted paste contains the currently authorized feed URL bytes",
        },
      )
      .toBe(true);
  } finally {
    await paste.evaluate((element) => element.remove());
  }

  // Screenshot the actual rendered code plus its white quiet zone, in memory
  // only. Browser PNG decoding is not a replacement QR renderer/decoder.
  const qr = access.locator(".qr-container");
  await expect(qr).toBeVisible();
  const png = await qr.screenshot();
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable for rendered QR pixels");
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      rgba: Array.from(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
      ),
    };
  }, png.toString("base64"));
  const decoded = jsQR(
    new Uint8ClampedArray(pixels.rgba),
    pixels.width,
    pixels.height,
  );
  // Keep bearer URLs out of assertion diagnostics and persisted attachments.
  expect(decoded !== null, "Rendered QR must decode").toBe(true);
  expect(
    Buffer.from(decoded!.binaryData).equals(Buffer.from(expectedURL, "utf8")),
    "Rendered QR contains the currently authorized feed URL bytes",
  ).toBe(true);
}
async function fits(page: Page, dialog?: Locator) {
  // Visibility starts before the finite entrance transition has settled.
  // Measure the final task surface without changing the viewport bounds.
  if (dialog) await settledTask(dialog);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  if (dialog) {
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width + 1,
    );
  }
}
for (const width of [1440, 390]) {
  test(`E09 invited service center keyboard delivery and selected-link rotation at ${width}px`, async ({
    page,
    request,
    playwright,
    baseURL,
  }) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    const owner = await playwright.request.newContext({ baseURL });
    const other = await playwright.request.newContext({ baseURL });
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      const f = await serviceCenterFixture(request, owner, other, anonymous);
      await page.goto("/#subscriptions");
      await page.getByLabel("账号", { exact: true }).fill(f.account.username);
      await page.getByLabel("密码", { exact: true }).fill(initialPassword);
      const loggedIn = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/auth/login") &&
          r.request().method() === "POST",
      );
      await activate(
        page,
        page.getByRole("button", { name: "进入工作空间", exact: true }),
      );
      expect((await loggedIn).status()).toBe(200);
      const row = page.getByRole("group", {
        name: `客户端订阅 ${selectedName}`,
        exact: true,
      });
      await expect(row).toBeVisible();
      const mutations: { path: string; method: string }[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path.startsWith("/api/") &&
          !["GET", "HEAD"].includes(request.method())
        )
          mutations.push({ path, method: request.method() });
      });
      expect(
        (await (await page.request.get("/api/auth/me")).json()).user.role,
      ).toBe("user");
      await expect(page.getByText(serviceName, { exact: true })).toBeVisible();
      await expect(
        page.getByText("100 MiB", { exact: true }).first(),
      ).toBeVisible();
      await activate(
        page,
        page.getByRole("button", { name: "用量与周期明细", exact: true }),
      );
      await expect(page.getByText("UTC+8", { exact: true })).toBeVisible();
      await expect(page.getByText(/（还有 .+）/)).toBeVisible();
      await expect(
        page.getByText("本周期实际流量", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("服务到期", { exact: true })).toBeVisible();
      await activate(
        page,
        page.getByRole("button", { name: "平台提供的线路 · 1", exact: true }),
      );
      await expect(
        page.getByRole("heading", { name: routeName, exact: true }),
      ).toBeVisible();
      await fits(page);
      const getSubscription = row.getByRole("button", {
        name: "获取订阅",
        exact: true,
      });
      await activate(page, getSubscription);
      const access = page.getByRole("dialog", {
        name: `获取「${selectedName}」`,
        exact: true,
      });
      await expect(access).toBeVisible();
      await fits(page, access);
      const link = access.getByRole("textbox", {
        name: "订阅链接",
        exact: true,
      });
      const oldURL = await link.inputValue();
      expect(new URL(oldURL).origin).toBe(new URL(baseURL!).origin);
      expect(new URL(oldURL).pathname === f.outputs[0].feedPath).toBe(true);
      await expectDeliveryBytes(
        page,
        access,
        new URL(f.outputs[0].feedPath, baseURL!).href,
      );
      const downloaded = page.waitForEvent("download");
      await activate(
        page,
        access.getByRole("link", { name: "下载配置", exact: true }),
      );
      const download = await downloaded;
      expect(await download.failure()).toBeNull();
      const stream = await download.createReadStream();
      expect(stream).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(f.ownBefore)).toBe(true);
      await download.delete();
      await page.keyboard.press("Escape");
      await expect(access).toBeHidden();
      await expect(getSubscription).toBeFocused();

      const menu = row.getByRole("button", {
        name: `管理 ${selectedName}`,
        exact: true,
      });
      const openRotation = async () => {
        await activate(page, menu);
        await expect(
          page.getByRole("menuitem", {
            name: "查看已发布内容",
            exact: true,
          }),
        ).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(
          page.getByRole("menuitem", {
            name: "编辑关联分流配置",
            exact: true,
          }),
        ).toBeFocused();
        await page.keyboard.press("ArrowDown");
        const item = page.getByRole("menuitem", {
          name: "更换订阅链接",
          exact: true,
        });
        // Radix defers roving focus. Observe each keyboard destination rather
        // than queueing more ArrowDown events before the previous one lands.
        await expect(item).toBeFocused();
        await page.keyboard.press("Enter");
      };
      await openRotation();
      const confirmation = page.getByRole("alertdialog", {
        name: `更换「${selectedName}」的订阅链接？`,
        exact: true,
      });
      await expect(
        confirmation.getByText(
          "旧链接将停止获取更新，需要在客户端替换链接。已经下载的配置无法收回。",
          { exact: true },
        ),
      ).toBeVisible();
      await fits(page, confirmation);
      await page.keyboard.press("Escape");
      await expect(confirmation).toBeHidden();
      await expect(menu).toBeFocused();
      expect((await f.feed(f.outputs[0].feedPath)).equals(f.ownBefore)).toBe(
        true,
      );
      await f.unchangedOthers();
      expect(mutations).toEqual([]);

      await openRotation();
      const rotated = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/outputs/${f.outputs[0].id}/rotate`) &&
          r.request().method() === "POST",
      );
      await activate(
        page,
        confirmation.getByRole("button", { name: "更换链接", exact: true }),
      );
      const result = await rotated;
      expect(result.status()).toBe(200);
      const nextPath = (await result.json()).feedPath;
      await expect(confirmation).toBeHidden();
      await f.verifyRotation(nextPath);
      // Rotation opens the replacement access task itself; do not try to
      // activate an inert background action while that task owns focus.
      await expect(access).toBeVisible();
      await expect
        .poll(
          async () => new URL(await link.inputValue()).pathname === nextPath,
        )
        .toBe(true);
      await fits(page, access);
      await expectDeliveryBytes(page, access, new URL(nextPath, baseURL!).href);
      await page.keyboard.press("Escape");
      await expect(access).toBeHidden();
      await activate(page, getSubscription);
      await expect(access).toBeVisible();
      await expect
        .poll(
          async () => new URL(await link.inputValue()).pathname === nextPath,
        )
        .toBe(true);
      await expectDeliveryBytes(page, access, new URL(nextPath, baseURL!).href);
      await page.keyboard.press("Escape");
      await expect(getSubscription).toBeFocused();
      expect(mutations).toEqual([
        { path: `/api/me/outputs/${f.outputs[0].id}/rotate`, method: "POST" },
      ]);
    } finally {
      await Promise.all([
        owner.dispose(),
        other.dispose(),
        anonymous.dispose(),
      ]);
    }
  });
}
