import { test, expect } from "./isolated-control-plane-fixture";
import { demoPassword, requireLoopback } from "./account-security-backend";
import { seedNativePublication } from "./browser-native-fixture";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import { nativeBridge } from "./browser-native-bridge";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("same browser publication is observed by the owned native instance and stopped", async ({
  page,
  playwright,
  baseURL,
}, info) => {
  test.setTimeout(90000);
  requireLoopback(baseURL);
  const admin = await playwright.request.newContext({ baseURL }),
    owner = await playwright.request.newContext({ baseURL });
  let bridge: Awaited<ReturnType<typeof nativeBridge>> | undefined;
  try {
    const { host, instance, draft, enrollment, call } =
      await seedNativePublication(admin, owner);
    bridge = await nativeBridge({
      url: baseURL!,
      token: enrollment.token,
      scope: enrollment.scope,
    });
    await page.goto("/");
    await page.getByLabel("账号", { exact: true }).fill("routeweaver");
    await page.getByLabel("密码", { exact: true }).fill(demoPassword);
    await page
      .getByRole("button", { name: "进入工作空间", exact: true })
      .click();
    await waitForConfirmedWorkspace(page);
    await page.goto(`/#routes?deployment=${draft.id}`);
    const detail = page.getByRole("dialog", { name: draft.name, exact: true });
    await expect(detail).toBeVisible();
    // The fixture saves the managed draft before attaching principals. The saved
    // diagnostic is intentionally stale until this explicit, real UI recheck.
    await expect(
      detail.getByText("草稿需要调整", { exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByText(
        "MANAGED_PRINCIPALS_REQUIRED: authenticated VLESS principals required",
        { exact: true },
      ),
    ).toBeVisible();
    const checked = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          `/api/server-deployments/${draft.id}/validate` &&
        r.request().method() === "POST",
    );
    await detail.getByRole("button", { name: "重新检查", exact: true }).click();
    const validation = await checked;
    expect(validation.status()).toBe(200);
    expect((await validation.json()).valid).toBe(true);
    const review = page.getByRole("dialog", {
      name: "应用转发路径修改",
      exact: true,
    });
    await review
      .getByRole("checkbox", {
        name: "确认允许此转发路径提供访问",
        exact: true,
      })
      .check();
    await review
      .getByRole("checkbox", {
        name: "已确认目标实例可执行当前额度策略",
        exact: true,
      })
      .check();
    const published = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          `/api/server-deployments/${draft.id}/publish` &&
        r.request().method() === "POST",
    );
    await review
      .getByRole("button", { name: "确认并应用", exact: true })
      .click();
    const response = await published;
    expect(response.status()).toBe(200);
    const receipt = await response.json();
    expect(receipt.status).toBe("publication-accepted");
    expect(receipt.instances).toHaveLength(1);
    const readState = async () => {
      const r = await admin.get(`/api/agent/instances/${instance.id}/state`);
      expect(r.status()).toBe(200);
      return r.json();
    };
    const queued = await readState();
    expect(queued.phase).toBe("queued");
    const accepted = receipt.instances[0];
    expect(accepted.instanceId).toBe(instance.id);
    expect(String(queued.desired.generation)).toBe(accepted.generation);
    expect(queued.desired.operationId).toBe(accepted.operationId);
    expect(queued.desired.revisionId).toBe(accepted.revisionId);
    await page.goto("/#servers");
    await page.getByRole("tab", { name: /^核心实例 / }).click();
    await page
      .getByRole("row")
      .filter({ hasText: instance.name })
      .getByRole("button", { name: "查看状态", exact: true })
      .click();
    const status = page.getByRole("dialog", {
      name: `${host.name} · ${instance.name}`,
      exact: true,
    });
    await expect(
      status.getByText("等待实例接收", { exact: true }),
    ).toBeVisible();
    const refresh = async () => {
      const r = page.waitForResponse(
        (v) =>
          new URL(v.url()).pathname ===
          `/api/agent/instances/${instance.id}/state`,
      );
      await status
        .getByRole("button", { name: "刷新实例状态", exact: true })
        .click();
      expect((await r).status()).toBe(200);
    };
    const applied = await bridge.command("apply");
    // Identity fields are embedded in Observation; compare every immutable field.
    for (const [key, value] of Object.entries(queued.desired))
      expect(applied.state.observed[key], key).toEqual(value);
    expect(applied.state.phase).toBe("observed_conformant");
    expect(applied.state.nativeChecked).toBe(true);
    expect((await readState()).phase).toBe("queued");
    await refresh();
    await expect(status.getByText("已确认生效", { exact: true })).toHaveCount(
      0,
    );
    await bridge.command("mismatch");
    expect((await readState()).phase).toBe("queued");
    await bridge.command("report");
    await refresh();
    await expect(status.getByText("已确认生效", { exact: true })).toBeVisible();
    const observed = await readState();
    for (const [key, value] of Object.entries(queued.desired))
      expect(observed.state.observed[key], key).toEqual(value);
    await status
      .getByRole("button", { name: "实例技术详情", exact: true })
      .click();
    const technical = status
      .locator("pre")
      .filter({ hasText: accepted.operationId });
    await expect(technical).toBeVisible();
    const stopInput = {
      action: "stop",
      deploymentId: draft.id,
      targetIds: [instance.id],
    };
    const preview = await call("admin/fleet-batches/preview", stopInput);
    const batch = await call(
      "admin/fleet-batches",
      {
        ...stopInput,
        expectedFingerprint: preview.fingerprint,
        leaseSeconds: 300,
      },
      201,
    );
    await call(`admin/fleet-batches/${batch.id}/execute`, {
      stage: 0,
      requestId: "browser-native-stop",
    });
    const stopQueued = await readState();
    expect(
      BigInt(stopQueued.desired.generation) > BigInt(queued.desired.generation),
    ).toBe(true);
    const stoppedLocal = await bridge.command("apply");
    expect(stoppedLocal.state.desired).toEqual(stopQueued.desired);
    expect(stoppedLocal.state.observed).toBeUndefined();
    expect(stoppedLocal.state.recoveryRequired).toBe(false);
    await bridge.command("report");
    const stopped = await readState();
    expect(stopped.phase).not.toBe("observed_conformant");
    expect(stopped.state.code).toBe("policy_restricted");
    expect(stopped.state.desired).toEqual(stopQueued.desired);
    expect(stopped.state.observed).toBeUndefined();
    expect(stopped.state.recoveryRequired).toBe(false);
    await bridge.command("stale");
    expect(await readState()).toEqual(stopped);
    await refresh();
    await expect(status.getByText("已确认生效", { exact: true })).toHaveCount(
      0,
    );
    await expect(status.getByText("访问已受限", { exact: true })).toBeVisible();
    await info.attach("browser-native-identity.json", {
      body: JSON.stringify({
        binarySHA256: bridge.ready.binarySHA256,
        receipt,
        desired: queued.desired,
        observedIdentity: observed.state.observed,
        stoppedPhase: stopped.phase,
        stoppedCode: stopped.state.code,
      }),
      contentType: "application/json",
    });
  } finally {
    try {
      await bridge?.close();
    } finally {
      await admin.dispose();
      await owner.dispose();
    }
  }
});
