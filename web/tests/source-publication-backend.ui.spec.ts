import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { Preview, SourceCandidate } from "../src/types";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { sourceRowAction } from "./source-row-actions";
import { settledTask } from "./ui-settled-task";
import {
  sourcePublicationFixture,
  sourcePublicationInput,
  sourcePublicationNames as names,
  sourcePublicationOwner,
  type JourneySource,
} from "./source-publication-backend";

function responseFor(page: Page, path: string, method = "POST") {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path &&
      response.request().method() === method,
  );
}

async function expectUncovered(target: Locator) {
  await expect(target).toBeInViewport({ ratio: 1 });
  // Check the settled frame once. Polling until a covering toast expires would
  // conceal a broken transition rather than prove usable foreground copy.
  expect(
    await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return hit === element || (hit !== null && element.contains(hit));
    }),
    "Foreground consequence or action receives the center hit",
  ).toBe(true);
  expect(
    await target.evaluate((element) => {
      const target = element.getBoundingClientRect();
      return Array.from(document.querySelectorAll("[data-sonner-toast]")).some(
        (notice) => {
          const style = getComputedStyle(notice);
          const rect = notice.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0 &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left < target.right &&
            rect.right > target.left &&
            rect.top < target.bottom &&
            rect.bottom > target.top
          );
        },
      );
    }),
    "No visible notice rectangle overlaps the foreground consequence or action",
  ).toBe(false);
}

async function expectSourceNoticeRetired(page: Page) {
  for (const text of [
    "来源已添加",
    "来源已更新",
    "来源已保存，有更新可手动应用",
    "发现更新，可手动应用",
    `「${names.source}」已应用，已发布订阅未改变`,
  ]) {
    // Dismissed notices may finish their finite exit animation. Require their
    // retirement now, not absence after the normal display duration expires.
    expect(
      await page
        .locator('[data-sonner-toast]:not([data-removed="true"])')
        .filter({ hasText: text })
        .count(),
      "The foreground source task retires its preceding source notice",
    ).toBe(0);
  }
  // Retirement is asserted above before settling. Await only finite exit motion
  // of notices already dismissed by the product, never their display timeout.
  await page
    .locator('[data-sonner-toast][data-removed="true"]')
    .evaluateAll(async (notices) => {
      for (const notice of notices) getComputedStyle(notice).opacity;
      const exits = notices
        .flatMap((notice) => notice.getAnimations({ subtree: true }))
        .filter((animation) =>
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
        );
      await Promise.all(
        exits.map((animation) => animation.finished.catch(() => {})),
      );
    });
}

async function capture(
  page: Page,
  info: TestInfo,
  name: string,
  surface: Locator,
  protectedTargets: Locator[] = [],
) {
  await settledTask(surface);
  await expectSourceNoticeRetired(page);
  for (const target of protectedTargets) await expectUncovered(target);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "No horizontal page overflow",
  ).toBe(true);
  expect(
    await surface.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        element.scrollWidth <= element.clientWidth + 1
      );
    }),
    "Task surface fits the viewport without horizontal overflow",
  ).toBe(true);
  // Mask only sensitive descendants of the foreground task. Page-wide masks
  // paint even obscured background inputs over readable foreground copy.
  // Source input, rendered configuration, access links and QR remain masked.
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: false,
    mask: [
      surface.locator(
        'input, textarea, pre, code, canvas, svg[role="img"], svg[width="180"][height="180"], a[href*="/feed/"], [aria-label="订阅链接"]',
      ),
    ],
  });
}

// Browser -> built UI -> isolated normal CLI with per-test database/key and a
// genuinely invited tenant. No API response mocks, live source fetch or traffic.
test.use({ trace: "off", screenshot: "off", video: "off", hasTouch: true });
for (const width of [1440, 390])
  test(`real source credential apply → current continuation → selected publication at ${width}`, async ({
    page,
    playwright,
    baseURL,
  }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const admin = await playwright.request.newContext({ baseURL });
    try {
      const headers = await sourcePublicationOwner(admin, page.request);
      const publications: string[] = [];
      const applications: Array<{
        candidateId: string;
        sourceRevision: string;
      }> = [];
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        const path = new URL(request.url()).pathname;
        if (/\/outputs\/[^/]+\/publish$/.test(path)) publications.push(path);
        if (/\/sources\/[^/]+\/apply$/.test(path))
          applications.push(request.postDataJSON());
      });
      await page.goto("/#sources");
      await page
        .locator(".page-heading")
        .getByRole("button", { name: "添加来源", exact: true })
        .click();
      const importing = page.getByRole("dialog", {
        name: "添加订阅来源",
        exact: true,
      });
      await expect(importing).toBeVisible();
      await importing.getByLabel("来源名称").fill(names.source);
      await importing
        .getByRole("combobox", { name: "更新应用方式", exact: true })
        .click();
      await page.getByRole("option", { name: "手动应用", exact: true }).click();
      await importing
        .getByLabel("节点链接或配置内容")
        .fill(sourcePublicationInput("before"));
      const imported = responseFor(page, "/api/me/sources");
      await importing
        .getByRole("button", { name: "导入来源", exact: true })
        .click();
      const importResponse = await imported;
      expect(importResponse.status()).toBe(200);
      const original = (await importResponse.json()) as JourneySource;
      expect(original.applyMode).toBe("manual");
      expect(original.candidate).toBeUndefined();
      await expect(importing).toHaveCount(0);
      const f = await sourcePublicationFixture(page.request, headers, original);
      await (await sourceRowAction(page, "编辑", names.source)).click();
      const content = page.getByLabel("节点链接或配置内容");
      await expect(content).toBeEditable();
      await content.fill(sourcePublicationInput("after"));
      const edited = responseFor(page, `/api/me/sources/${original.id}`, "PUT");
      await page.getByRole("button", { name: "保存修改", exact: true }).click();
      const editResponse = await edited;
      expect(editResponse.status()).toBe(200);
      const pending = (await editResponse.json()) as JourneySource;
      expect(pending.snapshot.snapshotId).toBe(original.snapshot.snapshotId);
      expect(pending.candidate?.diff).toMatchObject({
        beforeCount: 1,
        afterCount: 1,
        added: [],
        removed: [],
        renamed: [],
        connectionChanged: [
          { id: original.snapshot.endpoints[0].id, fields: ["password"] },
        ],
      });
      expect(pending.candidate!.affected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "profile",
            id: f.id,
            name: names.originalProfile,
          }),
          ...f.outputs.map((output) =>
            expect.objectContaining({ kind: "subscription", id: output.id }),
          ),
        ]),
      );
      expect(
        pending.candidate!.affected.some((item) => item.id === f.lateId),
      ).toBe(false);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.locator("[data-sonner-toast]").filter({
          hasText: "来源已保存，有更新可手动应用",
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "查看变化", exact: true }).click();
      const changes = page.getByRole("dialog", {
        name: "查看变化",
        exact: true,
      });
      await expect(
        changes.getByRole("heading", { name: "连接变更 1", exact: true }),
      ).toBeVisible();
      await expect(
        changes.getByText("登录密码", { exact: true }),
      ).toBeVisible();
      await expect(changes).not.toContainText("synthetic-source-");
      await settledTask(changes);
      await expectSourceNoticeRetired(page);
      await f.publicationsUnchanged();
      await capture(page, info, `source-credential-pending-${width}`, changes, [
        changes.getByRole("button", { name: "忽略本次更新", exact: true }),
        changes.getByRole("button", { name: "应用更新", exact: true }),
      ]);
      await page.keyboard.press("Escape");
      await expect(changes).toHaveCount(0);
      expect(applications).toHaveLength(0);
      expect((await f.readSource()).candidate?.id).toBe(pending.candidate!.id);
      await f.publicationsUnchanged();

      // Real public-API competing edits AFTER candidate generation. The browser
      // still holds the earlier candidate and must use the committed response.
      await f.advanceDependencies();
      const stillPending = await f.readSource();
      expect(stillPending.revision).toBe(pending.revision);
      expect(stillPending.candidate).toEqual(pending.candidate);
      await page.getByRole("button", { name: "查看变化", exact: true }).click();
      const accepted = responseFor(
        page,
        `/api/me/sources/${original.id}/apply`,
      );
      await changes
        .getByRole("button", { name: "应用更新", exact: true })
        .click();
      const applyResponse = await accepted;
      expect(applyResponse.status()).toBe(200);
      const applied = (await applyResponse.json()) as JourneySource & {
        application: {
          candidateId: string;
          sourceRevision: string;
          affected: SourceCandidate["affected"];
        };
      };
      expect(applications).toEqual([
        {
          candidateId: pending.candidate!.id,
          sourceRevision: pending.revision,
        },
      ]);
      expect(applied.id).toBe(original.id);
      expect(applied.revision).not.toBe(pending.revision);
      expect(applied.application).toMatchObject({
        candidateId: pending.candidate!.id,
        sourceRevision: applied.revision,
      });
      expect(applied.application.affected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "collection",
            id: f.id,
            name: names.collection,
          }),
          expect.objectContaining({
            kind: "profile",
            id: f.id,
            name: names.currentProfile,
          }),
          expect.objectContaining({
            kind: "profile",
            id: f.lateId,
            name: names.lateProfile,
          }),
          ...f.outputs.map((output) =>
            expect.objectContaining({
              kind: "subscription",
              id: output.id,
              name: output.name,
            }),
          ),
        ]),
      );
      expect(
        applied.application.affected.some(
          (item) => item.name === names.originalProfile,
        ),
      ).toBe(false);
      expect(applied.snapshot.endpoints.map((item) => item.id)).toEqual(
        original.snapshot.endpoints.map((item) => item.id),
      );
      expect(applied.snapshot.snapshotId).not.toBe(
        original.snapshot.snapshotId,
      );
      await expect(changes).toHaveCount(0);
      await f.recipesUnchanged();
      await f.publicationsUnchanged();
      expect(publications).toEqual([]);
      const persisted = await f.readSource();
      expect(persisted).not.toHaveProperty("application");
      expect(persisted.candidate).toBeUndefined();
      expect(persisted.applyHistory?.[0]).toMatchObject({
        mode: "manual",
        connectionChanged: 1,
        added: 0,
        removed: 0,
      });

      await page
        .getByRole("button", {
          name: `查看上次应用结果 ${names.source}`,
          exact: true,
        })
        .click();
      const receipt = page.getByRole("dialog", {
        name: "上次应用详情",
        exact: true,
      });
      await expect(receipt).toContainText("来源已更新，已发布订阅未改变。");
      for (const [id, name] of [
        [f.id, names.currentProfile],
        [f.lateId, names.lateProfile],
      ]) {
        await expect(
          receipt.getByRole("link", { name: `查看配置 ${name}`, exact: true }),
        ).toHaveAttribute("href", `#subscriptions?profile=${id}`);
      }
      await expect(
        receipt.getByRole("link", { name: /^查看配置 / }),
      ).toHaveCount(2);
      await expect(
        receipt.getByRole("link", { name: /^查看订阅 / }),
      ).toHaveCount(2);
      await expect(receipt).not.toContainText(names.originalProfile);
      await expect(receipt).not.toContainText("synthetic-source-");
      const chosenLink = receipt.getByRole("link", {
        name: `查看订阅 ${names.chosen}`,
        exact: true,
      });
      await expect(chosenLink).toHaveAttribute(
        "href",
        `#subscriptions?output=${f.outputs[0].id}`,
      );
      await chosenLink.scrollIntoViewIfNeeded();
      await expect(chosenLink).toBeInViewport();
      await settledTask(receipt);
      await expectSourceNoticeRetired(page);
      await expectUncovered(
        receipt.getByText("来源已更新，已发布订阅未改变。", { exact: true }),
      );
      await expectUncovered(chosenLink);
      await expectUncovered(
        receipt.getByRole("button", { name: "完成", exact: true }),
      );
      await capture(
        page,
        info,
        `source-applied-current-targets-${width}`,
        receipt,
        [
          receipt.getByText("来源已更新，已发布订阅未改变。", { exact: true }),
          chosenLink,
          receipt.getByRole("button", { name: "完成", exact: true }),
        ],
      );
      await chosenLink.click();
      await expect(page).toHaveURL(
        new RegExp(`#subscriptions\\?output=${f.outputs[0].id}$`),
      );
      const detail = page.getByRole("dialog", {
        name: `${names.chosen} 的订阅详情`,
        exact: true,
      });
      await expect(detail).toBeVisible();
      await expect(detail).toContainText(names.currentProfile);
      const review = page.getByRole("dialog", {
        name: `检查订阅更新「${names.chosen}」`,
        exact: true,
      });
      const inspect = async () => {
        const response = responseFor(page, `/api/me/profiles/${f.id}/preview`);
        await detail
          .getByRole("button", { name: "检查更新", exact: true })
          .click();
        const result = await response;
        expect(result.status()).toBe(200);
        expect(result.request().postDataJSON()).toMatchObject({
          outputId: f.outputs[0].id,
        });
        const preview = (await result.json()) as Preview;
        expect(preview).toMatchObject({
          valid: true,
          outputId: f.outputs[0].id,
          previewScope: "output-update",
          publicationEffect: { version: 1, link: "preserve" },
        });
        expect(preview.semanticChanges).toMatchObject({
          version: 1,
          renderedConfigurationChanged: true,
          groups: { state: "available", changedCount: 0 },
          nodes: {
            state: "available",
            changedCount: 1,
            rows: [
              {
                id: original.snapshot.endpoints[0].id,
                kind: "modified",
                nameChanged: false,
                settingsChanged: true,
                changedCategories: ["authentication"],
              },
            ],
          },
        });
        expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/);
        await expect(
          review.getByRole("button", {
            name: `确认更新「${names.chosen}」`,
            exact: true,
          }),
        ).toBeEnabled();
        await expect(review).toContainText("沿用当前链接，其他订阅保留原状。");
        await expect(
          review.getByText("连接设置已更改：认证。", { exact: true }),
        ).toBeVisible();
        await expect(review).not.toContainText("synthetic-source-");
        return preview;
      };
      await inspect();
      await f.publicationsUnchanged();
      await review.getByRole("button", { name: "取消", exact: true }).click();
      await expect(review).toHaveCount(0);
      await expect(detail).toBeVisible();
      expect(publications).toEqual([]);
      await f.publicationsUnchanged();
      const fresh = await inspect();
      const confirm = review.getByRole("button", {
        name: `确认更新「${names.chosen}」`,
        exact: true,
      });
      await confirm.scrollIntoViewIfNeeded();
      await expect(confirm).toBeInViewport();
      await settledTask(review);
      await expectSourceNoticeRetired(page);
      await expectUncovered(
        review.getByText("沿用当前链接，其他订阅保留原状。", { exact: true }),
      );
      await expectUncovered(
        review.getByRole("button", { name: "取消", exact: true }),
      );
      await expectUncovered(confirm);
      await capture(
        page,
        info,
        `source-selected-publication-review-${width}`,
        review,
        [
          review.getByText("沿用当前链接，其他订阅保留原状。", { exact: true }),
          review.getByRole("button", { name: "取消", exact: true }),
          confirm,
        ],
      );
      const published = responseFor(
        page,
        `/api/me/outputs/${f.outputs[0].id}/publish`,
      );
      if (width === 390) await confirm.tap();
      else {
        await confirm.focus();
        await page.keyboard.press("Enter");
      }
      const publication = await published;
      expect(publication.status()).toBe(200);
      expect(publication.request().postDataJSON()).toEqual({
        previewDigest: fresh.previewDigest,
      });
      await expect(review).toHaveCount(0);
      expect(publications).toEqual([
        `/api/me/outputs/${f.outputs[0].id}/publish`,
      ]);
      const chosen = await f.outputState(f.outputs[0].id);
      const sibling = await f.outputState(f.outputs[1].id);
      expect(chosen.credential).toEqual({ before: false, after: true });
      expect(chosen.contentDigest).not.toBe(f.before[0].contentDigest);
      expect(chosen.revision).not.toBe(f.before[0].revision);
      // The owner CAS token covers the publication too, so it advances even
      // though the user's actual bearer link remains the same.
      expect(chosen.accessRevision).not.toBe(f.before[0].accessRevision);
      expect({
        ...chosen,
        credential: f.before[0].credential,
        contentDigest: f.before[0].contentDigest,
        revision: f.before[0].revision,
        accessRevision: f.before[0].accessRevision,
      }).toEqual(f.before[0]);
      expect(sibling).toEqual(f.before[1]);
      await f.recipesUnchanged();
      expect(await f.readSource()).toEqual(persisted);
      await page.reload();
      await expect(detail).toBeVisible();
      await expect(
        detail.getByText("与已保存草稿一致", { exact: true }),
      ).toBeVisible();
      await capture(
        page,
        info,
        `source-selected-publication-complete-${width}`,
        detail,
      );
      expect(await f.outputState(f.outputs[1].id)).toEqual(f.before[1]);
      await writeFile(
        info.outputPath(`source-publication-proof-${width}.json`),
        JSON.stringify(
          {
            viewport: width,
            scope:
              "isolated normal CLI, invited tenant, synthetic text source, real public HTTP and browser writes",
            source: {
              credentialOnly: true,
              stableEndpointIdentity: true,
              manualApplications: applications.length,
              receiptUsesCurrentDependencies: true,
              receiptNotPersisted: true,
            },
            interruptions: {
              sourceReviewDismissedWithoutApplying: true,
              outputReviewCancelledWithoutPublishing: true,
            },
            foreground: {
              sourceNoticeRetiredOnTaskTransition: true,
              appliedConsequenceAndActionsUncovered: true,
              publicationConsequenceAndConfirmUncovered: true,
              sensitiveMasksScopedToActiveTask: true,
            },
            publication: {
              explicitWrites: publications.length,
              chosenCredentialChanged: chosen.credential.after,
              chosenAccessPreserved:
                chosen.accessDigest === f.before[0].accessDigest,
              siblingContentAccessRevisionPreserved: true,
              recipesPreserved: true,
            },
            notExercised: [
              "external source transport",
              "live proxy traffic",
              "native core parsing",
              "deployment",
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      await admin.dispose();
    }
  });
