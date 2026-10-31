import { test, expect, type Page } from "@playwright/test";
import { openWorkspace } from "./ui-session";
import { surfaceMotionState } from "./ui-surface-stability";

// Synthetic safe resolution DTOs exercise presentation, not native application.
test.use({ trace: "off", screenshot: "off" });
type Hop = {
  endpointId: string;
  name?: string;
  metadataState: "snapshot" | "unavailable";
};
const fra: Hop = {
  endpointId: "fra",
  name: "法兰克福",
  metadataState: "snapshot",
};
const old: Hop = {
  endpointId: "uk-a",
  name: "英国 A",
  metadataState: "snapshot",
};
const next: Hop = {
  endpointId: "uk-b",
  name: "英国 B",
  metadataState: "snapshot",
};
async function openRoute(
  page: Page,
  saved: Hop[],
  confirmed?: Hop[],
  options: {
    savedPort?: number;
    pending?: boolean;
    resolveError?: boolean;
  } = {},
) {
  await openWorkspace(page);
  const route = {
    id: "path-line",
    name: "英国线路",
    deploymentId: "path-deployment",
    endpointIds: saved.map((h) => h.endpointId),
    publicHost: "entry.invalid",
    publicPort: options.savedPort || 443,
    status: confirmed ? "effective" : "draft",
    diagnostics: [],
    pendingChanges: options.pending ?? true,
    savedPath: { hops: saved },
    effective: confirmed
      ? {
          publicHost: "entry.invalid",
          publicPort: 443,
          endpointIds: confirmed.map((h) => h.endpointId),
          fingerprint: "synthetic",
          path: { hops: confirmed },
        }
      : null,
  };
  const data: Record<string, unknown> = {
    "/published-routes": [route],
    "/published-routes/path-line/resolve": route,
    "/hosts": [],
    "/core-instances": [],
    "/managed-endpoints": [
      {
        id: "uk-a",
        name: "错误的新库存名称",
        instanceId: "missing",
        connection: { protocol: "vless", host: "ignored.invalid", port: 443 },
      },
    ],
    "/links": [],
    "/server-deployments": [
      {
        id: "path-deployment",
        name: "服务器路径",
        status: "draft",
        ir: { id: "path-deployment", programs: [] },
      },
    ],
  };
  await page.route("**/api/**", (intercept) => {
    const path = new URL(intercept.request().url()).pathname.replace(
      /^\/api/,
      "",
    );
    if (options.resolveError && path.endsWith("/resolve"))
      return intercept.fulfill({
        status: 503,
        json: { message: "暂时无法核对" },
      });
    if (Object.hasOwn(data, path))
      return intercept.fulfill({ json: data[path] });
    return intercept.continue();
  });
  await page.goto("/#published-routes");
  await page.getByRole("button", { name: "英国线路", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "英国线路", exact: true });
  await expect
    .poll(() => detail.evaluate(surfaceMotionState))
    .toMatchObject({ preparing: false, running: false, opacity: "1" });
  return detail;
}

test("shows confirmed old exit beside saved replacement using snapshot names, not inventory", async ({
  page,
}, info) => {
  const detail = await openRoute(page, [fra, next], [fra, old]);
  await expect(detail.getByLabel("已确认路径", { exact: true })).toHaveText(
    "已确认路径法兰克福 → 英国 A",
  );
  await expect(detail.getByLabel("已保存路径", { exact: true })).toHaveText(
    "已保存路径法兰克福 → 英国 B",
  );
  await expect(detail.getByText("错误的新库存名称")).toHaveCount(0);
  await expect(
    detail.getByText("对外地址：entry.invalid:443", { exact: true }),
  ).toHaveCount(1);
  await expect(
    detail.getByText(/已保存的对外地址|已确认的对外地址/),
  ).toHaveCount(0);
  await expect(
    detail.getByRole("link", { name: "检查并应用转发路径" }),
  ).toHaveAttribute("data-variant", "default");
  await expect(
    detail.getByRole("button", { name: "重新核对进度" }),
  ).toHaveAttribute("data-variant", "ghost");
  await expect(
    detail.getByRole("link", { name: "检查并应用转发路径" }),
  ).toHaveAttribute("href", /routes/);
  await page.screenshot({
    path: info.outputPath("saved-versus-confirmed-desktop.png"),
  });
});

test("unchanged endpoint order keeps one sequence without claiming all configuration is applied", async ({
  page,
}) => {
  const detail = await openRoute(
    page,
    [fra, { ...old, name: "草稿中新名称" }],
    [fra, old],
  );
  await expect(detail.getByLabel("已确认路径", { exact: true })).toHaveText(
    "已确认路径法兰克福 → 英国 A（已保存路径端点相同）",
  );
  await expect(detail.getByLabel("已保存路径", { exact: true })).toHaveCount(0);
  await expect(
    detail.getByText("上次配置已确认，修改尚待应用", { exact: true }),
  ).toBeVisible();
});

test("missing effective result never invents a confirmed path", async ({
  page,
}) => {
  const detail = await openRoute(page, [fra, next]);
  await expect(detail.getByLabel("已保存路径", { exact: true })).toHaveText(
    "已保存路径法兰克福 → 英国 B",
  );
  await expect(detail.getByLabel("已确认路径", { exact: true })).toHaveCount(0);
  await expect(
    detail.getByText("草稿已保存，尚未确认应用", { exact: true }),
  ).toBeVisible();
});

test("same names retain distinct identities and unavailable metadata uses only its ID at 390px", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const unknown: Hop = {
    endpointId: "fra-unavailable",
    name: "不得采用的名称",
    metadataState: "unavailable",
  };
  const detail = await openRoute(
    page,
    [unknown, { ...next, name: "英国" }],
    [unknown, { ...old, name: "英国" }],
  );
  await expect(detail.getByLabel("已确认路径", { exact: true })).toHaveText(
    "已确认路径fra-unavailable → 英国（uk-a）",
  );
  await expect(detail.getByLabel("已保存路径", { exact: true })).toHaveText(
    "已保存路径fra-unavailable → 英国（uk-b）",
  );
  await expect(detail.getByText("不得采用的名称")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("same-names-unavailable-390.png"),
  });
});

test("changed hop order is a path change even with the same endpoint set", async ({
  page,
}) => {
  const detail = await openRoute(page, [old, fra], [fra, old]);
  await expect(detail.getByLabel("已确认路径", { exact: true })).toHaveText(
    "已确认路径法兰克福 → 英国 A",
  );
  await expect(detail.getByLabel("已保存路径", { exact: true })).toHaveText(
    "已保存路径英国 A → 法兰克福",
  );
});

test("different public port shows both addresses without conflating them", async ({
  page,
}) => {
  const detail = await openRoute(page, [fra, next], [fra, old], {
    savedPort: 8443,
  });
  await expect(
    detail.getByText("已保存的对外地址：entry.invalid:8443", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("已确认的对外地址：entry.invalid:443", { exact: true }),
  ).toBeVisible();
});

test("resolved nonpending route keeps ordinary check navigation, not a pending primary", async ({
  page,
}) => {
  const detail = await openRoute(page, [fra, old], [fra, old], {
    pending: false,
  });
  await expect(
    detail.getByRole("link", { name: "检查并应用转发路径" }),
  ).not.toHaveAttribute("data-variant", "default");
});

test("resolution error does not promote stale paths or a pending primary action", async ({
  page,
}) => {
  const detail = await openRoute(page, [fra, next], [fra, old], {
    resolveError: true,
  });
  await expect(
    detail.getByText("运行配置：未知，无法取得最新确认结果。", { exact: true }),
  ).toBeVisible();
  await expect(detail.getByLabel("已确认路径", { exact: true })).toHaveCount(0);
  await expect(
    detail.getByRole("link", { name: "检查并应用转发路径" }),
  ).not.toHaveAttribute("data-variant", "default");
});
