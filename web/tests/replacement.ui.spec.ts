import { openWorkspace, navigateWorkspace } from "./ui-session";
import { createHash } from "node:crypto";
import {
  test,
  expect,
  type Page,
  type TestInfo,
  type Locator,
} from "@playwright/test";

type SavedProfile = {
  id: string;
  name: string;
  ir: { defaultAction: { kind: string } };
};
type PublishedOutput = {
  id: string;
  name: string;
  profileId: string;
  target: { adapterId: string; version: string };
  mode: string;
  status: string;
  revision?: string;
  publishedAt?: string;
  updatedAt?: string;
  routingSummary?: unknown;
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function readJSON<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), `Read ${path} succeeds`).toBe(true);
  return response.json() as Promise<T>;
}

/** Setup only: no editor/save/check/publish interaction under test is seeded. */
async function seedIndependentOutputs(
  page: Page,
  outputCount = 2,
  withRule = false,
) {
  const session = await readJSON<{ csrfToken: string }>(page, "/auth/me");
  const headers = { "X-CSRF-Token": session.csrfToken };
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const id = `journey-profile-${suffix}`;
  const profile = {
    id,
    name: `Journey configuration ${suffix}`,
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    sourceIds: [],
    ir: {
      schemaVersion: "1.0",
      id,
      name: `Journey configuration ${suffix}`,
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [],
      rules: withRule
        ? [
            {
              id: `rule-${suffix}`,
              match: { op: "domain-suffix", value: "before.example" },
              action: { kind: "reject" },
            },
          ]
        : [],
      resources: [],
      defaultAction: { kind: "direct" },
      runtime: { mixedPort: 7890 },
    },
  };
  const saved = await page.request.post("/api/me/profiles", {
    headers,
    data: profile,
  });
  expect(saved.ok(), "Synthetic configuration setup succeeds").toBe(true);
  const outputs: PublishedOutput[] = [];
  for (const [label, adapterId, version] of [
    ["Laptop", "mihomo", "1.19.32"],
    ["Phone", "sing-box", "1.14.3"],
  ].slice(0, outputCount)) {
    const result = await page.request.post("/api/me/outputs", {
      headers,
      data: {
        id: `journey-output-${label.toLowerCase()}-${suffix}`,
        name: `${label} ${suffix}`,
        profileId: profile.id,
        target: { adapterId, version },
        mode: "full",
      },
    });
    expect(result.ok(), `Synthetic ${label} publication setup succeeds`).toBe(
      true,
    );
    outputs.push(await result.json());
  }
  // API fixtures predate the UI task. Reload their initial read model rather than
  // carrying the empty query cache from login into a hash-only navigation.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "我的订阅", exact: true }),
  ).toBeVisible();
  return { profile, outputs };
}

/** Never put access paths, tokens, or delivery contents into reports/assertion diffs. */
async function frozenState(page: Page, id: string) {
  const outputs = await readJSON<PublishedOutput[]>(page, "/me/outputs");
  const output = outputs.find((item) => item.id === id);
  expect(Boolean(output), "Requested Output exists").toBe(true);
  const access = await readJSON<{ feedPath?: string }>(
    page,
    `/me/outputs/${id}/access`,
  );
  expect(
    Boolean(access.feedPath),
    "Output has local test delivery identity",
  ).toBe(true);
  const path = new URL(access.feedPath!, "http://127.0.0.1:4173").pathname;
  // Only the loopback origin is used, even if a response also supplies a display URL.
  const delivered = await page.request.get(path);
  expect(delivered.ok(), "Frozen local delivery succeeds").toBe(true);
  return {
    id: output!.id,
    profileId: output!.profileId,
    target: output!.target,
    mode: output!.mode,
    status: output!.status,
    revision: output!.revision,
    publishedAt: output!.publishedAt,
    updatedAt: output!.updatedAt,
    routingSummary: output!.routingSummary,
    accessFingerprint: digest(access.feedPath!),
    contentFingerprint: digest(await delivered.text()),
  };
}

async function changeDefault(page: Page, label: "拒绝连接" | "直连") {
  const behavior = page.getByLabel("默认流量行为", { exact: true });
  await behavior.click();
  // The shadcn combobox trigger is a button; type into its search field.
  const search = page.getByRole("combobox", { name: "搜索选项", exact: true });
  await search.fill(label);
  await expect(
    page.getByRole("option", { name: label, exact: true }),
  ).toHaveCount(1);
  await search.press("Enter");
}

async function startConfiguration(page: Page) {
  await page.getByRole("button", { name: /^(设置订阅|新建分流配置)$/ }).click();
}

async function editSelectedOutputConfiguration(page: Page, name: string) {
  const detail = page.getByRole("dialog", {
    name: `订阅详情 · ${name}`,
    exact: true,
  });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "更多操作", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "编辑关联分流配置", exact: true })
    .click();
}

async function report(
  testInfo: TestInfo,
  journey: string,
  evidence: Record<string, unknown>,
) {
  await testInfo.attach("journey-result", {
    body: JSON.stringify(
      {
        journey,
        evidence,
        scope:
          "Real loopback control-plane UI/API; no live proxy traffic or runtime application.",
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
}

// Access dialogs contain bearer links. Capture only explicitly safe states in
// these tasks; do not allow a failing access assertion to create a credential image.
test.use({ screenshot: "off" });

test("rotating one link immediately exposes its exact replacement and offline read recovery never repeats the write", async ({
  page,
  context,
}, testInfo) => {
  await openWorkspace(page);
  const { profile, outputs } = await seedIndependentOutputs(page);
  const [selected, sibling] = outputs;
  const before = await frozenState(page, selected.id);
  const siblingBefore = await frozenState(page, sibling.id);
  const oldAccess = await readJSON<{ feedPath: string }>(
    page,
    `/me/outputs/${selected.id}/access`,
  );
  const oldPath = new URL(oldAccess.feedPath, "http://127.0.0.1:4173").pathname;
  await page.goto(`/#subscriptions?profile=${profile.id}`);
  const row = page.getByRole("group", {
    name: `客户端订阅 ${selected.name}`,
    exact: true,
  });
  const writes: string[] = [];
  const observe = (request: import("@playwright/test").Request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith("/api/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    )
      writes.push(`${request.method()} ${path}`);
  };
  page.on("request", observe);
  await row
    .getByRole("button", { name: `管理 ${selected.name}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "更换订阅链接", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: `更换「${selected.name}」的订阅链接？`,
    exact: true,
  });
  await expect(confirm).toContainText(
    "旧链接将停止获取更新，需要在客户端替换链接",
  );
  await page.screenshot({
    path: testInfo.outputPath("rotation-consequence-before-confirm.png"),
    animations: "disabled",
  });
  await confirm.getByRole("button", { name: "更换链接", exact: true }).click();
  const access = page.getByRole("dialog", {
    name: `获取「${selected.name}」`,
    exact: true,
  });
  await expect(access).toBeVisible();
  const link = access.getByLabel("订阅链接", { exact: true });
  await expect(link).toBeVisible();
  const replacement = new URL(await link.inputValue()).pathname;
  const notice = await access.innerText();
  await page.keyboard.press("Escape");
  await expect(access).not.toBeVisible();
  expect(notice).toContain("新链接已生成");
  expect(notice).toContain("旧链接已失效，请将新链接重新添加到客户端");
  expect((await page.request.get(oldPath)).status()).toBe(404);
  expect((await page.request.get(replacement)).status()).toBe(200);
  const rotated = await frozenState(page, selected.id);
  expect(rotated.accessFingerprint).not.toBe(before.accessFingerprint);
  expect(rotated.contentFingerprint).toBe(before.contentFingerprint);
  expect(await frozenState(page, sibling.id)).toEqual(siblingBefore);
  expect(writes).toEqual([`POST /api/me/outputs/${selected.id}/rotate`]);
  const writesAfterRotation = writes.length;
  // Browser network emulation is an explicit controlled outage. The rotation
  // above was real; no API response or successful interaction is intercepted.
  await row.getByRole("button", { name: "获取订阅", exact: true }).click();
  await expect(access).toBeVisible();
  await expect(link).toBeVisible();
  expect(digest(new URL(await link.inputValue()).pathname)).toBe(
    rotated.accessFingerprint,
  );
  await context.setOffline(true);
  try {
    // Offline session protection conceals private controls. Do not interact
    // with hidden workspace UI or expect a nested access dialog to stay exposed.
    const recovery = page.getByRole("region", {
      name: "恢复登录",
      exact: true,
    });
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText("暂时无法确认登录状态");
    await expect(row).not.toBeVisible();
    await expect(access).not.toBeVisible();
    await expect(link).not.toBeVisible();
    await expect(
      access.getByRole("button", { name: "复制链接", exact: true }),
    ).not.toBeVisible();
    await expect(
      access.getByRole("link", { name: "下载配置与规则文件", exact: true }),
    ).not.toBeVisible();
    expect(writes.slice(writesAfterRotation)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("access-controlled-offline-state.png"),
      animations: "disabled",
    });
    const confirmedSession = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/me") &&
        response.request().method() === "GET",
    );
    await context.setOffline(false);
    expect((await confirmedSession).ok()).toBe(true);
    await expect(recovery).not.toBeVisible();
    await expect(row).toBeVisible();
    expect(
      writes.slice(writesAfterRotation),
      "Reconnection does not replay rotation",
    ).toEqual([]);
    await expect(access).toBeVisible();
    await expect(link).toBeVisible();
    const recoveredFingerprint = digest(
      new URL(await link.inputValue()).pathname,
    );
    await page.keyboard.press("Escape");
    await expect(access).not.toBeVisible();
    expect(recoveredFingerprint).toBe(rotated.accessFingerprint);
  } finally {
    await context.setOffline(false);
  }
  expect(
    writes.slice(writesAfterRotation),
    "Read recovery sends no mutation",
  ).toEqual([]);
  await page.getByText("订阅素材", { exact: true }).click();
  await navigateWorkspace(page, "订阅来源");
  await expect(
    page.getByRole("heading", { name: "订阅来源", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(row).toBeVisible();
  await expect(access).not.toBeVisible();
  page.off("request", observe);
  expect(await frozenState(page, sibling.id)).toEqual(siblingBefore);
  await report(testInfo, "rotation completion and controlled offline access", {
    rotationWrites: 1,
    immediateExactOutputAccess: true,
    oldAccessInvalid: true,
    sameFrozenContent: true,
    siblingUnchanged: true,
    controlledBrowserOffline: true,
    readRecoveryOnly: true,
    leavingDoesNotReopenAccess: true,
  });
});

test("normal private-rule bundle update immediately offers a real configuration-and-rules download", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const { profile, outputs } = await seedIndependentOutputs(page, 1);
  const siblingBefore = await frozenState(page, outputs[0].id);
  const session = await readJSON<{ csrfToken: string }>(page, "/auth/me");
  const headers = { "X-CSRF-Token": session.csrfToken };
  const resourceId = `private-rules-${profile.id}`;
  const privateRules = "payload:\n  - '+.synthetic-private.example'\n";
  const imported = await page.request.post("/api/me/resources/import", {
    headers,
    data: {
      resource: {
        id: resourceId,
        name: "Synthetic private rules",
        format: "mihomo-yaml",
        behavior: "domain",
        updatePolicy: "pinned",
      },
      contentBase64: Buffer.from(privateRules).toString("base64"),
    },
  });
  expect(imported.ok(), "Inline synthetic rule-file setup succeeds").toBe(true);
  const resource = await imported.json();
  const configured = {
    ...profile,
    ir: {
      ...profile.ir,
      resources: [{ id: resourceId }],
      rules: [
        {
          id: `file-rule-${profile.id}`,
          match: { op: "resource", value: resourceId },
          action: { kind: "reject" },
        },
      ],
    },
  };
  expect(
    (
      await page.request.put(`/api/me/profiles/${profile.id}`, {
        headers,
        data: configured,
      })
    ).ok(),
  ).toBe(true);
  const created = await page.request.post("/api/me/outputs", {
    headers,
    data: {
      id: `bundle-${profile.id}`,
      name: `Private bundle ${Date.now().toString(36)}`,
      profileId: profile.id,
      target: profile.target,
      mode: "full",
    },
  });
  expect(created.ok(), "Existing bundle Output setup succeeds").toBe(true);
  const output = await created.json();
  expect(output.delivery).toBe("bundle");
  const before = await readJSON<{ downloadPath: string }>(
    page,
    `/me/outputs/${output.id}/access`,
  );
  const beforeBytes = await (
    await page.request.get(before.downloadPath)
  ).body();
  await page.goto(`/#subscriptions?profile=${profile.id}`);
  await page.reload();
  await page
    .getByRole("article", { name: `分流配置 ${profile.name}`, exact: true })
    .getByRole("button", { name: "编辑配置", exact: true })
    .click();
  await changeDefault(page, "拒绝连接");
  await page.getByRole("button", { name: "保存并检查", exact: true }).click();
  const choose = page.getByRole("dialog", {
    name: "选择客户端订阅",
    exact: true,
  });
  await choose
    .getByRole("radio", { name: new RegExp(`更新「${output.name}」`) })
    .check();
  await choose
    .getByRole("button", { name: "检查所选订阅", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: `检查订阅更新「${output.name}」`,
    exact: true,
  });
  await expect(
    review.getByText("兼容检查通过。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("bundle-normal-update-review.png"),
    animations: "disabled",
  });
  await review
    .getByRole("button", { name: `确认更新「${output.name}」`, exact: true })
    .click();
  const access = page.getByRole("dialog", {
    name: `获取「${output.name}」`,
    exact: true,
  });
  await expect(access).toBeVisible();
  await expect(
    access.getByLabel("订阅链接", { exact: true }),
  ).not.toBeVisible();
  const downloadLink = access.getByRole("link", {
    name: "下载配置与规则文件",
    exact: true,
  });
  await expect(downloadLink).toBeVisible();
  const replacementNotice = await access
    .getByText("访问凭据已更换", { exact: true })
    .count();
  const downloadEvent = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadEvent;
  const localFile = testInfo.outputPath("synthetic-private-bundle.zip");
  await download.saveAs(localFile);
  await page.keyboard.press("Escape");
  await expect(access).not.toBeVisible();
  expect(
    replacementNotice,
    "Normal bundle update does not claim a credential rotation",
  ).toBe(0);
  expect(await download.failure()).toBeNull();
  const after = await readJSON<{ downloadPath: string }>(
    page,
    `/me/outputs/${output.id}/access`,
  );
  const delivered = await page.request.get(after.downloadPath);
  expect(delivered.ok()).toBe(true);
  const bytes = await delivered.body();
  const hash = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const { readFile } = await import("node:fs/promises");
  expect(hash(await readFile(localFile))).toBe(hash(bytes));
  expect(hash(bytes)).not.toBe(hash(beforeBytes));
  const { execFileSync } = await import("node:child_process");
  const entries = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))",
      ],
      { input: bytes, encoding: "utf8" },
    ),
  );
  expect(entries[resource.path]).toBe(privateRules);
  const rendered = JSON.parse(entries["mihomo.json"]);
  expect(rendered.rules).toContain("MATCH,REJECT");
  expect(entries["mihomo.json"]).toContain(resource.path);
  expect(await frozenState(page, outputs[0].id)).toEqual(siblingBefore);
  const latest = await readJSON<PublishedOutput[]>(page, "/me/outputs");
  expect(
    latest
      .filter((item) => item.profileId === profile.id)
      .map((item) => item.id)
      .sort(),
  ).toEqual([outputs[0].id, output.id].sort());
  await report(testInfo, "private bundle update and download", {
    fixture: "inline synthetic private rules; no remote resource fetch",
    immediateExactOutputAccess: true,
    normalUpdateNotRotation: true,
    downloadedArchiveMatchesFrozenBackend: true,
    configurationReferencesBundledRuleFile: true,
    explicitDefaultActionUsed: "reject",
    siblingUnchanged: true,
    newOutputCreated: false,
  });
});
