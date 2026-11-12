import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type {
  EffectivePolicy,
  PolicyChange,
  PolicyEditPrecondition,
} from "../src/access-policy-model";
import type { Service, UserRecord } from "../src/types";
import { entitlementEditFixture } from "../src/test-support/entitlement-edit-fixture";
import { serviceEditFixture } from "../src/test-support/service-edit-fixture";
import { settledTask } from "./ui-settled-task";

// Actual App and public controls, exclusively synthetic browser HTTP. These
// cases never contact a backend API or change an account's authorization.
// Persisted policy/CAS and enforcement remain separate backend test concerns.
test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
});

const GiB = 1024 ** 3;
const consentLabel = "我已核对本次授权变更";
const failure = "授权暂时无法更新。修改已保留，请返回编辑后重新预览。";
const service: Service = {
  id: "recovery-plan",
  name: "日常协作服务方案",
  quotaBytes: 100 * GiB,
  routeIds: ["office-route"],
  onlineIpLimit: 3,
  connectionLimit: 20,
  entryRateBps: 0,
  cycle: {
    mode: "monthly",
    day: 1,
    anchor: "2026-01-01T00:00:00Z",
    timezone: "UTC+8",
  },
};
const user: UserRecord = {
  id: "recovery-user",
  name: "林晓",
  enabled: true,
  quotaBytes: 100 * GiB,
  usedBytes: 12 * GiB,
};
const effective: EffectivePolicy = {
  userId: user.id,
  serviceId: service.id,
  service,
  groupIds: [],
  routeIds: [...service.routeIds],
  quotaBytes: service.quotaBytes,
  onlineIpLimit: 3,
  connectionLimit: 20,
  entryRateBps: 0,
  status: "active",
  provenance: {
    service: "individual",
    quotaBytes: `service:${service.id}`,
    routes: `service:${service.id}`,
    onlineIpLimit: `service:${service.id}`,
    connectionLimit: `service:${service.id}`,
    entryRateBps: `service:${service.id}`,
  },
  entitlement: {
    userId: user.id,
    serviceId: service.id,
    startsAt: "2026-01-01T00:00:00Z",
    paused: false,
    cycle: { ...service.cycle },
  },
};
type Kind = "service" | "user";
type PreviewRequest = {
  change: PolicyChange;
  precondition: PolicyEditPrecondition;
};
type ApplyRequest = { change: PolicyChange; revision: string };

async function installFixture(page: Page, info: TestInfo, kind: Kind) {
  const base = info.project.use.baseURL;
  if (
    !base ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)
  )
    throw new Error("Synthetic policy recovery requires a loopback origin");
  const origin = new URL(base).origin;
  const plan = serviceEditFixture(service, "opened-service-recovery");
  const person = entitlementEditFixture(effective, {
    revision: "opened-user-recovery",
  });
  const context = kind === "service" ? plan.context() : person.context();
  const contextPath = `/api/access-policy/edit-context/${context.target.kind}/${context.target.id}`;
  const fixtures: Record<string, unknown> = {
    "/api/auth/me": {
      user: { id: "recovery-admin", name: "授权管理员", role: "admin" },
      csrfToken: "synthetic-policy-recovery",
    },
    "/api/state": {
      nodes: [],
      routes: [],
      users: [user],
      revisions: [],
      capabilities: [],
      deploymentAvailable: false,
    },
    "/api/services": [service],
    "/api/settings": {},
    "/api/published-routes": [
      { id: "office-route", name: "日常办公线路", status: "draft" },
    ],
    "/api/rates": [],
    "/api/user-groups": [],
    [contextPath]: context,
    ...(kind === "user"
      ? {
          [`/api/users/${user.id}/admission-status`]: {
            asOf: "2026-11-05T00:00:00Z",
            maxLeaseSeconds: 60,
            onlineIps: [],
            activeStreams: 0,
            entries: [],
          },
        }
      : {}),
  };
  const unexpected: string[] = [];
  const errors: string[] = [];
  const previews: PreviewRequest[] = [];
  const applies: ApplyRequest[] = [];
  const reads: string[] = [];
  let releaseContext!: () => void;
  const openingContext = new Promise<void>((resolve) => { releaseContext = resolve; });
  let releasePreview!: () => void;
  const firstPreview = new Promise<void>((resolve) => { releasePreview = resolve; });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const refuse = () => {
      unexpected.push(
        `${request.method()} ${url.origin}${url.pathname}${url.search}`,
      );
      return route.abort("blockedbyclient");
    };
    if (url.origin !== origin) return refuse();
    if (!/^\/api(?:\/|$)/.test(url.pathname))
      return request.method() === "GET" ? route.continue() : refuse();
    if (url.search) return refuse();
    if (request.method() === "GET" && Object.hasOwn(fixtures, url.pathname)) {
      reads.push(url.pathname);
      if (url.pathname === contextPath) await openingContext;
      return route.fulfill({ json: fixtures[url.pathname] });
    }
    if (
      request.method() === "POST" &&
      url.pathname === "/api/access-policy/preview"
    ) {
      const body = request.postDataJSON() as PreviewRequest;
      expect(Object.keys(body).sort()).toEqual(["change", "precondition"]);
      expect(body.precondition).toEqual(context.precondition);
      expect(Object.keys(body.change)).toEqual([
        kind === "service" ? "service" : "entitlement",
      ]);
      previews.push(structuredClone(body));
      if (previews.length === 1) await firstPreview;
      const revision = `synthetic-${kind}-review-${previews.length}`;
      if (kind === "service") {
        expect(body.change.service?.id).toBe(service.id);
        const proposed = body.change.service!;
        return route.fulfill({
          json: plan.preview(proposed, {
            revision,
            blockers: [],
            affected: [
              {
                userId: user.id,
                before: effective,
                after: {
                  ...effective,
                  service: proposed,
                  quotaBytes: proposed.quotaBytes,
                },
              },
            ],
          }),
        });
      }
      expect(body.change.entitlement?.userId).toBe(user.id);
      const proposed = body.change.entitlement!;
      return route.fulfill({
        json: person.preview(proposed, {
          revision,
          blockers: [],
          affected: [
            {
              userId: user.id,
              before: effective,
              after: {
                ...effective,
                entitlement: proposed,
                quotaBytes: proposed.quotaOverride ?? service.quotaBytes,
                provenance: {
                  ...effective.provenance,
                  quotaBytes: "individual",
                },
              },
            },
          ],
        }),
      });
    }
    if (
      request.method() === "POST" &&
      url.pathname === "/api/access-policy/apply"
    ) {
      const body = request.postDataJSON() as ApplyRequest;
      expect(previews.length).toBeGreaterThan(0);
      expect(body).toEqual({
        change: previews.at(-1)!.change,
        revision: `synthetic-${kind}-review-${previews.length}`,
      });
      applies.push(structuredClone(body));
      // Every apply is intercepted and fails without altering the read fixture.
      return route.fulfill({ status: 503, json: { error: failure } });
    }
    return refuse();
  });
  return { previews, applies, reads, unexpected, errors, releasePreview, releaseContext };
}

async function contained(surface: Locator, page: Page) {
  await settledTask(surface);
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}

async function capture(
  page: Page,
  surface: Locator,
  info: TestInfo,
  name: string,
) {
  await contained(surface, page);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

async function openEditor(page: Page, kind: Kind, releaseContext: () => void) {
  await page.goto(kind === "service" ? "/#services" : "/#users");
  const actions = page.getByRole("group", {
    name: `${kind === "service" ? service.name : user.name} 的操作`,
    exact: true,
  });
  const opener = actions.getByRole("button", {
    name: kind === "service" ? "编辑" : `更多操作 ${user.name}`,
    exact: true,
  });
  const editor = page.getByRole("dialog", {
    name:
      kind === "service" ? `编辑 ${service.name}` : `${user.name} 的服务授权`,
    exact: true,
  });
  try {
    await opener.click();
    if (kind === "user")
      await page.getByRole("menuitem", { name: "授权与续期", exact: true }).click();
    // Establish the actual loading surface and its focus before allowing the
    // loaded editor to replace it. Fast fixtures must not skip this boundary.
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("正在加载", { exact: true })).toBeVisible();
    await expect.poll(() => editor.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  } finally { releaseContext(); }
  await settledTask(editor);
  // The context response, not the loading Sheet, owns the editable controls.
  await expect(
    editor.getByRole("button", { name: "预览影响", exact: true }),
  ).toBeVisible();
  return { editor, opener };
}

for (const width of [1440, 390]) {
  for (const kind of ["service", "user"] as const) {
    test(`${kind} policy editing preserves its draft through failed apply and recovery at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const fixture = await installFixture(page, info, kind);
      const { editor, opener } = await openEditor(page, kind, fixture.releaseContext);
      const editedName = "日常协作扩展方案";
      const quotaLabel =
        kind === "service"
          ? "周期额度（GiB，0 为不限额）"
          : "个人周期额度（GiB）";
      if (kind === "service") {
        await editor
          .getByRole("textbox", { name: "服务方案名称", exact: true })
          .fill(editedName);
      } else {
        await editor
          .getByRole("button", { name: "个人额度与限制", exact: true })
          .click();
        await editor
          .getByRole("checkbox", {
            name: "覆盖个人周期额度（GiB）",
            exact: true,
          })
          .check();
      }
      const quota = editor.getByRole("spinbutton", {
        name: quotaLabel,
        exact: true,
      });
      await quota.fill("150");
      await expect(quota).toHaveValue("150");
      await expect(quota).toBeFocused();
      await expect(quota).toBeInViewport({ ratio: 1 });
      await capture(page, editor, info, `${kind}-${width}-editing`);

      const preview = editor.getByRole("button", {
        name: "预览影响",
        exact: true,
      });
      try {
        await preview.click();
        await expect.poll(() => fixture.previews.length).toBe(1);
        await expect(preview).toHaveAttribute("aria-busy", "true");
        await expect(preview).toHaveAttribute("aria-disabled", "true");
        // Native disabled would drop Chromium focus before review captures its
        // return owner. Keep focus without permitting another activation.
        await expect(preview).not.toHaveAttribute("disabled");
        await expect(preview).toBeFocused();
        await page.keyboard.press("Enter");
        await page.keyboard.press("Space");
        expect(fixture.previews).toHaveLength(1);
        await expect(preview).toBeFocused();
      } finally {
        // Release the test-owned response even if a pending-state assertion fails.
        fixture.releasePreview();
      }
      const review = page.getByRole("dialog", {
        name: "确认授权变更",
        exact: true,
      });
      await contained(review, page);
      if (kind === "user") await review.getByRole("button", { name: "查看个人设置变更", exact: true }).click();
      const resource = review.getByRole("table", {
        name: kind === "service" ? "方案变更" : "个人授权变更",
        exact: true,
      });
      await expect(resource.getByRole("rowheader")).toHaveText(
        kind === "service" ? ["方案名称", "周期额度"] : ["个人周期额度"],
      );
      const quotaRow = resource.getByRole("row").filter({
        has: page.getByRole("rowheader", {
          name: kind === "service" ? "周期额度" : "个人周期额度",
          exact: true,
        }),
      });
      await expect(quotaRow.getByRole("cell").nth(0)).toHaveText(
        kind === "service" ? "100 GiB" : "继承",
      );
      await expect(quotaRow.getByRole("cell").nth(1)).toHaveText("150 GiB");
      await expect(
        review.getByText("涉及 1 位用户。", { exact: true }),
      ).toBeVisible();
      const impact = review.getByRole("table", {
        name: user.name,
        exact: true,
      });
      await expect(
        impact.getByRole("columnheader", { name: "变更前", exact: true }),
      ).toBeVisible();
      await expect(
        impact.getByRole("columnheader", { name: "变更后", exact: true }),
      ).toBeVisible();
      const impactQuota = impact.getByRole("row").filter({
        has: page.getByRole("rowheader", { name: "周期额度", exact: true }),
      });
      await expect(impactQuota.getByRole("cell").nth(0)).toContainText(
        "100 GiB",
      );
      await expect(impactQuota.getByRole("cell").nth(1)).toContainText(
        "150 GiB",
      );
      for (const table of [resource, impact])
        expect(
          await table.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.left >= -1 &&
              rect.right <= innerWidth + 1 &&
              element.scrollWidth <= element.clientWidth + 1
            );
          }),
        ).toBe(true);
      await expect(
        review.getByText("受管入口配置需单独应用。", { exact: true }),
      ).toBeVisible();
      const apply = review.getByRole("button", {
        name: "更新授权",
        exact: true,
      });
      const consent = review.getByRole("checkbox", {
        name: consentLabel,
        exact: true,
      });
      await expect(apply).toBeDisabled();
      await expect(consent).not.toBeChecked();

      // Capture actual comparison content, not merely an open dialog. Start
      // with the account table fully in view, including its before/after labels.
      await impact.scrollIntoViewIfNeeded();
      await expect(impact).toBeInViewport({ ratio: 1 });
      await expect(impactQuota).toBeInViewport({ ratio: 1 });
      const resourceAlsoFits = await resource.evaluate((element) => {
        const body = element.closest("[data-task-overlay-body]");
        if (!body) return false;
        const rect = element.getBoundingClientRect();
        const clip = body.getBoundingClientRect();
        return (
          rect.top >= Math.max(0, clip.top) &&
          rect.bottom <= Math.min(innerHeight, clip.bottom)
        );
      });
      if (width === 1440 || resourceAlsoFits) {
        await expect(resource).toBeInViewport({ ratio: 1 });
        await expect(quotaRow).toBeInViewport({ ratio: 1 });
        await capture(page, review, info, `${kind}-${width}-impact-comparison`);
      } else {
        // A narrow screen may need two positions to show both comparisons.
        // Add only this one extra shot when the tables do not fit together.
        await resource.scrollIntoViewIfNeeded();
        await expect(resource).toBeInViewport({ ratio: 1 });
        await expect(quotaRow).toBeInViewport({ ratio: 1 });
        await capture(page, review, info, `${kind}-${width}-impact-comparison`);
        await impact.scrollIntoViewIfNeeded();
        await expect(impact).toBeInViewport({ ratio: 1 });
        await expect(impactQuota).toBeInViewport({ ratio: 1 });
        await capture(page, review, info, `${kind}-${width}-account-impact`);
      }

      await consent.check();
      await expect(apply).toBeEnabled();
      await apply.click();
      const summary = review.getByRole("group", {
        name: "操作未完成",
        exact: true,
      });
      await expect(summary).toHaveAccessibleDescription(failure);
      await expect(summary).toBeFocused();
      await expect(summary).toBeInViewport({ ratio: 1 });
      await expect(summary.getByRole("alert")).toContainText(failure);
      await expect(page.getByText(failure, { exact: true })).toHaveCount(1);
      await expect(consent).toBeChecked();
      await expect(apply).toBeEnabled();
      await expect(apply).not.toHaveAttribute("aria-busy", "true");
      await expect(
        page.getByText("平台授权已更新", { exact: true }),
      ).toHaveCount(0);
      await capture(page, review, info, `${kind}-${width}-failed-apply`);

      await review
        .getByRole("button", { name: "返回编辑", exact: true })
        .click();
      await expect(review).toHaveCount(0);
      await settledTask(editor);
      await expect(preview).toBeFocused();
      await expect(quota).toHaveValue("150");
      if (kind === "service")
        await expect(
          editor.getByRole("textbox", { name: "服务方案名称", exact: true }),
        ).toHaveValue(editedName);
      else
        await expect(
          editor.getByRole("checkbox", {
            name: "覆盖个人周期额度（GiB）",
            exact: true,
          }),
        ).toBeChecked();
      await expect(editor.getByRole("alert")).toContainText(failure);
      await expect(page.getByText(failure, { exact: true })).toHaveCount(1);
      // Continuing the retained draft clears the failure without stealing focus.
      await quota.fill("175");
      await expect(quota).toHaveValue("175");
      await expect(quota).toBeFocused();
      await expect(quota).toBeInViewport({ ratio: 1 });
      await expect(page.getByText(failure, { exact: true })).toHaveCount(0);
      await capture(page, editor, info, `${kind}-${width}-recovered-editor`);

      await preview.click();
      await settledTask(review);
      await expect(consent).not.toBeChecked();
      await expect(apply).toBeDisabled();
      await expect(quotaRow.getByRole("cell").nth(1)).toHaveText("175 GiB");
      expect(fixture.previews).toHaveLength(2);
      expect(fixture.applies).toHaveLength(1);
      const first = fixture.previews[0].change,
        second = fixture.previews[1].change;
      if (kind === "service") {
        expect(first.service).toEqual({
          ...service,
          name: editedName,
          quotaBytes: 150 * GiB,
        });
        expect(second.service).toEqual({
          ...service,
          name: editedName,
          quotaBytes: 175 * GiB,
        });
      } else {
        expect(first.entitlement).toEqual({
          ...effective.entitlement,
          quotaOverride: 150 * GiB,
          routeIdsOverride: null,
          onlineIpLimitOverride: null,
          connectionLimitOverride: null,
          entryRateBpsOverride: null,
        });
        expect(second.entitlement).toEqual({
          ...first.entitlement,
          quotaOverride: 175 * GiB,
        });
      }
      await page.keyboard.press("Escape");
      await expect(review).toHaveCount(0);
      await expect(preview).toBeFocused();
      await expect(quota).toHaveValue("175");

      // Cancel remains a local draft decision, never an implicit apply/retry.
      const cancel = editor.getByRole("button", { name: "取消", exact: true });
      await cancel.click();
      const discard = page.getByRole("alertdialog", {
        name: "放弃尚未保存的授权修改？",
        exact: true,
      });
      await discard
        .getByRole("button", { name: "继续编辑", exact: true })
        .click();
      await expect(discard).toHaveCount(0);
      await expect(cancel).toBeFocused();
      await expect(quota).toHaveValue("175");
      await cancel.click();
      await discard
        .getByRole("button", { name: "放弃修改", exact: true })
        .click();
      await expect(editor).toHaveCount(0);
      try {
        await expect(opener).toBeFocused();
      } catch (error) {
        await info.attach("final-focus-owner", {
          contentType: "application/json",
          body: JSON.stringify(await page.evaluate(() => {
            const active = document.activeElement;
            return { tag: active?.tagName, role: active?.getAttribute("role"), label: active?.getAttribute("aria-label"), text: active?.textContent?.slice(0, 160), dialog: active?.closest('[role="dialog"],[role="alertdialog"]')?.getAttribute("aria-labelledby") };
          })),
        });
        throw error;
      }
      await expect(
        page.getByText("平台授权已更新", { exact: true }),
      ).toHaveCount(0);
      expect(fixture.applies).toHaveLength(1);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
      await info.attach("synthetic-policy-request-ledger", {
        contentType: "application/json",
        body: JSON.stringify(
          {
            ...fixture,
            scope:
              "Browser-intercepted fixtures only; no backend authorization changes or successful apply.",
          },
          null,
          2,
        ),
      });
    });
  }
}
