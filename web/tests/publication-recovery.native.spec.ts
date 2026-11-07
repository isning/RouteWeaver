import { createServer } from "node:net";
import { test, expect } from "./isolated-control-plane-fixture";
import { demoPassword, requireLoopback } from "./account-security-backend";
import { seedNativePublication } from "./browser-native-fixture";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import { nativeBridge } from "./browser-native-bridge";

test.use({ trace: "off", screenshot: "off", video: "off" });

for (const width of [1440, 390]) {
  test(`failed native publication recovers only after explicit newer publication and observation at ${width}px`, async ({
    page,
    playwright,
    baseURL,
  }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    requireLoopback(baseURL);
    const admin = await playwright.request.newContext({ baseURL });
    const owner = await playwright.request.newContext({ baseURL });
    const blocker = createServer();
    let bridge: Awaited<ReturnType<typeof nativeBridge>> | undefined;
    const releaseOwnedListener = async () => {
      if (blocker.listening) {
        await new Promise<void>((resolve, reject) =>
          blocker.close((error) => (error ? reject(error) : resolve())),
        );
      }
    };
    try {
      // This test owns the conflicting socket from allocation until correction.
      // It never looks up or stops any unrelated listener/process.
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", resolve);
      });
      const port = (blocker.address() as { port: number }).port;
      const { host, instance, draft, enrollment } = await seedNativePublication(
        admin,
        owner,
        port,
      );
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
      const readState = async () => {
        const response = await admin.get(
          `/api/agent/instances/${instance.id}/state`,
        );
        expect(response.status()).toBe(200);
        return response.json();
      };
      const publish = async (first: boolean) => {
        await page.goto(`/#routes?deployment=${draft.id}`);
        const detail = page.getByRole("dialog", {
          name: draft.name,
          exact: true,
        });
        await expect(detail).toBeVisible();
        const checked = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname ===
              `/api/server-deployments/${draft.id}/validate` &&
            r.request().method() === "POST",
        );
        await detail
          .getByRole("button", {
            name: first ? "重新检查" : /^(再次检查并应用|查看修改并应用)$/,
            exact: true,
          })
          .click();
        const validation = await checked;
        expect(validation.status()).toBe(200);
        expect((await validation.json()).valid).toBe(true);
        const review = page.getByRole("dialog", {
          name: "应用转发路径修改",
          exact: true,
        });
        await expect(review).toBeVisible();
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
        return receipt;
      };
      const status = page.getByRole("dialog", {
        name: `${host.name}的${instance.name}`,
        exact: true,
      });
      const openStatus = async () => {
        await page.goto("/#servers");
        await page.getByRole("tab", { name: /^核心实例 / }).click();
        await page
          .getByRole("row")
          .filter({ hasText: instance.name })
          .getByRole("button", { name: "查看状态", exact: true })
          .click();
        await expect(status).toBeVisible();
      };
      const refresh = async () => {
        const response = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname ===
            `/api/agent/instances/${instance.id}/state`,
        );
        await status
          .getByRole("button", { name: "刷新实例状态", exact: true })
          .click();
        expect((await response).status()).toBe(200);
      };
      const noSuccess = async () => {
        await expect(
          status.getByText("已确认生效", { exact: true }),
        ).toHaveCount(0);
      };
      const advice = status.getByLabel("实例处理建议", { exact: true });
      const screenshot = async (stage: string) => {
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          )
          .toBe(true);
        await info.attach(`native-recovery-${stage}-${width}.png`, {
          body: await page.screenshot({
            fullPage: true,
            animations: "disabled",
            mask: [page.locator("pre, code, input")],
          }),
          contentType: "image/png",
        });
      };
      const firstReceipt = await publish(true);
      const queued = await readState();
      expect(queued.phase).toBe("queued");
      expect(firstReceipt.instances[0].instanceId).toBe(instance.id);
      expect(queued.desired.revisionId).toBe(
        firstReceipt.instances[0].revisionId,
      );
      expect(queued.desired.generation).toBe(
        firstReceipt.instances[0].generation,
      );
      expect(queued.desired.operationId).toBe(
        firstReceipt.instances[0].operationId,
      );
      await openStatus();
      await noSuccess();
      const failure = await bridge.command("apply-port-conflict");
      expect(blocker.listening).toBe(true);
      expect(failure.startupFailure.phase).toBe("unknown");
      expect(failure.startupFailure.code).toBe("activation_outcome_unknown");
      expect(failure.startupFailure.recoveryRequired).toBe(true);
      expect(failure.startupFailure.nativeChecked).toBe(true);
      expect(failure.startupFailure.observed).toBeUndefined();
      expect(failure.startupFailure.desired).toEqual(queued.desired);
      expect(failure.state.phase).toBe("apply_failed");
      expect(failure.state.code).toBe("recovered_not_applied");
      expect(failure.state.nativeChecked).toBe(true);
      expect(failure.state.recoveryRequired).toBe(false);
      expect(failure.state.observed).toBeUndefined();
      expect(failure.state.desired).toEqual(queued.desired);
      expect((await readState()).phase).toBe("queued");
      await refresh();
      await noSuccess();
      await expect(advice).toHaveCount(0);
      await bridge.command("report");
      const reportedFailure = await readState();
      expect(reportedFailure.phase).toBe("apply_failed");
      expect(reportedFailure.state.phase).toBe("apply_failed");
      expect(reportedFailure.state.nativeChecked).toBe(true);
      expect(reportedFailure.state.recoveryRequired).toBe(false);
      expect(reportedFailure.state.code).toBe("recovered_not_applied");
      expect(reportedFailure.state.desired).toEqual(queued.desired);
      expect(reportedFailure.state.observed).toBeUndefined();
      await refresh();
      await noSuccess();
      await expect(
        advice.getByText("本次配置未应用", { exact: true }),
      ).toBeVisible();
      await screenshot("failed");

      await releaseOwnedListener();
      expect(blocker.listening).toBe(false);
      // Fixing the port conflict alone does not retry or claim success.
      expect(await readState()).toEqual(reportedFailure);
      const correctionReceipt = await publish(false);
      const correction = await readState();
      expect(correction.phase).toBe("pending-new-generation");
      expect(correctionReceipt.instances[0].instanceId).toBe(instance.id);
      expect(correction.desired.revisionId).toBe(
        correctionReceipt.instances[0].revisionId,
      );
      expect(BigInt(correction.desired.generation)).toBeGreaterThan(
        BigInt(queued.desired.generation),
      );
      expect(correction.desired.operationId).not.toBe(
        queued.desired.operationId,
      );
      expect(correction.desired.operationId).toBe(
        correctionReceipt.instances[0].operationId,
      );
      expect(correction.desired.generation).toBe(
        correctionReceipt.instances[0].generation,
      );
      await openStatus();
      await noSuccess();
      await expect(
        status.getByText("等待最新配置", { exact: true }),
      ).toBeVisible();
      await expect(
        advice.getByText("上次尝试需要处理", { exact: true }),
      ).toBeVisible();
      await expect(advice.getByText(/不代表这次应用失败/)).toBeVisible();
      await screenshot("historical-while-queued");
      const applied = await bridge.command("apply");
      expect(applied.state.phase).toBe("observed_conformant");
      expect(applied.state.nativeChecked).toBe(true);
      expect(applied.state.recoveryRequired).toBe(false);
      expect(applied.state.observed.known).toBe(true);
      expect(applied.state.observed.quiescent).toBe(true);
      expect(applied.state.observed.evidence).toBe("owned_process_liveness");
      for (const [key, value] of Object.entries(correction.desired))
        expect(applied.state.observed[key], key).toEqual(value);
      expect((await readState()).phase).toBe("pending-new-generation");
      await refresh();
      await noSuccess();
      await expect(
        advice.getByText("上次尝试需要处理", { exact: true }),
      ).toBeVisible();
      await bridge.command("report");
      const recovered = await readState();
      expect(recovered.phase).toBe("observed_conformant");
      expect(recovered.state.code).toBeUndefined();
      expect(recovered.state.recoveryRequired).toBe(false);
      for (const [key, value] of Object.entries(correction.desired))
        expect(recovered.state.observed[key], key).toEqual(value);
      await refresh();
      await expect(
        status.getByText("已确认生效", { exact: true }),
      ).toBeVisible();
      await expect(advice).toHaveCount(0);
      await screenshot("recovered");
      await info.attach("native-recovery-identity.json", {
        body: JSON.stringify({
          binarySHA256: bridge.ready.binarySHA256,
          firstReceipt,
          failedDesired: queued.desired,
          initialCode: failure.startupFailure.code,
          confirmedFailureCode: reportedFailure.state.code,
          correctionReceipt,
          correctedDesired: correction.desired,
          observedIdentity: recovered.state.observed,
        }),
        contentType: "application/json",
      });
    } finally {
      try {
        await bridge?.close();
      } finally {
        await releaseOwnedListener();
        await admin.dispose();
        await owner.dispose();
      }
    }
  });
}
