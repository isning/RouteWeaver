import { expect, test, type Request, type Route } from "@playwright/test";
import { openWorkspace, navigateWorkspace } from "./ui-session";

test.use({ trace: "off", screenshot: "off", video: "off" });

// Fault-contract evidence, not a real deletion: Output has no DELETE API.
// Only the browser's latest GET /outputs catalog omits our selected owned ID.
// Authentication, editor reveal, all other reads and fixture storage stay real.
test("fault contract: a missing preferred Output does not become first creation without an explicit choice", async ({
  page,
}, info) => {
  const startedAt = Date.now();
  page.setDefaultTimeout(5000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspace(page);
  const read = async (path: string) => {
    const response = await page.request.get(`/api${path}`);
    expect(response.ok(), `Real read ${path} succeeds`).toBe(true);
    return response.json();
  };
  const headers = { "X-CSRF-Token": (await read("/auth/me")).csrfToken };
  const suffix = Date.now().toString(36);
  const profileID = `preferred-output-${suffix}`;
  const profileName = `Preferred output routing ${suffix}`;
  const ownedOutputs: string[] = [];
  const ownedProfiles: string[] = [];
  let injectedCatalogs = 0;
  const browserWrites: { method: string; path: string }[] = [];
  const watchWrite = (request: Request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
      browserWrites.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
  };
  let catalogFault: ((route: Route) => Promise<void>) | undefined;
  const normalized = (rows: { id: string }[]) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));
  try {
    const profile = {
      id: profileID,
      name: profileName,
      sourceIds: [],
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
      ir: {
        schemaVersion: "1.0",
        id: profileID,
        name: profileName,
        ownerId: "",
        revision: "1",
        endpoints: [],
        groups: [],
        rules: [],
        resources: [],
        defaultAction: { kind: "direct" },
        runtime: { mixedPort: 7890 },
      },
    };
    const saved = await page.request.post("/api/me/profiles", {
      headers,
      data: profile,
    });
    expect(saved.ok(), "Own synthetic Profile setup succeeds").toBe(true);
    ownedProfiles.push(profileID);
    const controlProfileID = `${profileID}-control`;
    const controlProfile = {
      ...profile,
      id: controlProfileID,
      name: `Independent routing ${suffix}`,
      ir: {
        ...profile.ir,
        id: controlProfileID,
        name: `Independent routing ${suffix}`,
      },
    };
    const savedControl = await page.request.post("/api/me/profiles", {
      headers,
      data: controlProfile,
    });
    expect(
      savedControl.ok(),
      "Independent control Profile setup succeeds",
    ).toBe(true);
    ownedProfiles.push(controlProfileID);
    const outputs: { id: string; name: string }[] = [];
    for (const [index, label] of [
      "Original laptop",
      "Independent control",
    ].entries()) {
      const id = `preferred-client-${suffix}-${index}`;
      const created = await page.request.post("/api/me/outputs", {
        headers,
        data: {
          id,
          name: `${label} ${suffix}`,
          profileId: index === 0 ? profileID : controlProfileID,
          target: profile.target,
          mode: "full",
        },
      });
      expect(created.ok(), "Own synthetic Output setup succeeds").toBe(true);
      ownedOutputs.push(id);
      outputs.push(await created.json());
    }
    const [preferred, control] = outputs;
    const beforeOutputs = normalized(await read("/me/outputs"));
    const beforeProfile = await read(`/me/profiles/${profileID}`);
    const beforeProfiles = normalized(await read("/me/profiles"));
    page.on("request", watchWrite);
    await page.reload();
    await page
      .getByRole("textbox", { name: "搜索配置或客户端订阅", exact: true })
      .fill(profileName);
    const card = page.getByRole("article", {
      name: `分流配置 ${profileName}`,
      exact: true,
    });
    await expect(card).toHaveCount(1);
    await card
      .getByRole("button", { name: `查看订阅 ${preferred.name}`, exact: true })
      .click();
    const detail = page.getByRole("dialog", {
      name: `${preferred.name} 的订阅详情`,
      exact: true,
    });
    await detail.getByRole("button", { name: "更多操作", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "编辑关联分流配置", exact: true })
      .click();
    await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
      profileName,
    );

    catalogFault = async (route) => {
      if (
        route.request().method() !== "GET" ||
        new URL(route.request().url()).pathname !== "/api/me/outputs"
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(
        response.ok(),
        "Fault injection wraps a successful real catalog read",
      ).toBe(true);
      const rows: { id: string; profileId: string }[] = await response.json();
      expect(rows.filter((row) => row.id === preferred.id)).toHaveLength(1);
      expect(rows.filter((row) => row.id === control.id)).toHaveLength(1);
      expect(rows.find((row) => row.id === control.id)?.profileId).toBe(
        controlProfileID,
      );
      expect(
        rows.filter((row) => row.profileId === profileID).map((row) => row.id),
      ).toEqual([preferred.id]);
      const withoutPreferred = rows.filter((row) => row.id !== preferred.id);
      expect(withoutPreferred).toHaveLength(rows.length - 1);
      expect(
        withoutPreferred.filter((row) => row.profileId === profileID),
      ).toEqual([]);
      injectedCatalogs++;
      await route.fulfill({ response, json: withoutPreferred });
    };
    await page.route("**/api/me/outputs", catalogFault);
    await page.getByRole("button", { name: "检查发布", exact: true }).click();
    const chooser = page.getByRole("dialog", {
      name: "选择客户端订阅",
      exact: true,
    });
    await expect(
      chooser
        .getByRole("alert")
        .getByText(`「${preferred.name}」已不在此配置的订阅列表中`, {
          exact: true,
        }),
    ).toBeVisible();
    await expect(chooser).toContainText(
      "请重新选择发布目标。未自动新增或切换到其他订阅。",
    );
    expect(injectedCatalogs).toBeGreaterThan(0);
    await expect(
      chooser.getByRole("radio", {
        name: new RegExp(`^更新「${preferred.name}」`),
      }),
    ).toHaveCount(0);
    await expect(chooser.getByRole("radio", { name: /^更新「/ })).toHaveCount(
      0,
    );
    const create = chooser.getByRole("radio", {
      name: "创建新的客户端订阅",
      exact: true,
    });
    await expect(create).toBeVisible();
    await expect(create).not.toBeChecked();
    await expect(chooser.getByRole("radio", { checked: true })).toHaveCount(0);
    const check = chooser.getByRole("button", {
      name: "检查所选订阅",
      exact: true,
    });
    await expect(check).toBeDisabled();
    await expect(
      page.getByRole("dialog", { name: "新增客户端订阅", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: /^检查订阅更新「/ }),
    ).toHaveCount(0);
    expect(browserWrites).toEqual([]);
    expect(normalized(await read("/me/outputs"))).toEqual(beforeOutputs);
    expect(await read(`/me/profiles/${profileID}`)).toEqual(beforeProfile);
    expect(normalized(await read("/me/profiles"))).toEqual(beforeProfiles);

    // With zero links in this Profile, only an explicit new-target choice may
    // enable the next step. Choosing it still does not open or publish a link.
    await create.click();
    await expect(create).toBeChecked();
    await expect(
      page.getByRole("dialog", { name: "新增客户端订阅", exact: true }),
    ).toHaveCount(0);
    await expect(check).toBeEnabled();
    expect(browserWrites).toEqual([]);
    await chooser
      .getByRole("button", { name: "返回编辑", exact: true })
      .click();
    await expect(chooser).not.toBeVisible();
    await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
      profileName,
    );
    expect(normalized(await read("/me/outputs"))).toEqual(beforeOutputs);
    expect(await read(`/me/profiles/${profileID}`)).toEqual(beforeProfile);
    expect(normalized(await read("/me/profiles"))).toEqual(beforeProfiles);
    expect(browserWrites).toEqual([]);
    // Optional user-facing milestone only, after all task assertions. Restore
    // the real catalog before capturing normal UI; no extra fixture or mutation.
    // The existing total/action deadlines are unchanged, and cleanup wins over
    // this optional image if little time remains.
    let normalDesktopCapture = "omitted-insufficient-time";
    if (info.timeout - (Date.now() - startedAt) >= 25_000) {
      await page.unroute("**/api/me/outputs", catalogFault);
      catalogFault = undefined;
      try {
        await navigateWorkspace(page, "我的订阅");
        await page.reload({ timeout: 5000 });
        await expect(
          page
            .locator(
              '[data-session-workspace][aria-busy="false"]:not([hidden]):not([inert])',
            )
            .getByRole("heading", { name: "我的订阅", exact: true }),
        ).toBeVisible();
        await expect(card).toBeVisible();
        await page.screenshot({
          path: info.outputPath(
            "subscriptions-actual-local-synthetic-desktop.png",
          ),
          fullPage: true,
          timeout: 5000,
        });
        normalDesktopCapture =
          "actual-local-built-product-synthetic-fixtures-not-a-mockup";
      } catch {
        // Optional capture is not part of the fault-contract result. A missing
        // image is explicitly reported, never counted as successful evidence.
        normalDesktopCapture = "unavailable-use-existing-QA-image";
      }
    }
    await info.attach("preferred-output-fault-contract", {
      body: JSON.stringify({
        evidenceKind:
          "explicit browser catalog-response fault over real account and backend",
        injectedCatalogs,
        hiddenOwnedOutputCount: 1,
        sameProfileRemainingOutputCount: 0,
        independentControlOutputRetained: true,
        namedMissingPreferred: true,
        noAutomaticAlternativeOrCreation: true,
        checkDisabledUntilExplicitChoice: true,
        browserMutationCount: browserWrites.length,
        entireOutputCatalogUnchanged: true,
        savedProfileUnchanged: true,
        publicationDuringJourney: false,
        normalDesktopCapture,
      }),
      contentType: "application/json",
    });
  } finally {
    page.off("request", watchWrite);
    if (catalogFault) await page.unroute("**/api/me/outputs", catalogFault);
    // No Output deletion endpoint exists. Revoke only owned synthetic access;
    // ephemeral demo teardown removes the retained revocation records.
    for (const id of ownedOutputs) {
      const revoked = await page.request.post(`/api/me/outputs/${id}/revoke`, {
        headers,
        data: {},
      });
      expect(revoked.ok(), "Revoke only owned synthetic Output").toBe(true);
    }
    for (const id of ownedProfiles) {
      const removed = await page.request.delete(`/api/me/profiles/${id}`, {
        headers,
      });
      expect(removed.ok(), "Delete only owned synthetic Profile").toBe(true);
    }
  }
});
