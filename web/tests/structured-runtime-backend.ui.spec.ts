import { test, expect } from "./isolated-control-plane-fixture";
import {
  inviteSyntheticAccount,
  requireLoopback,
} from "./account-security-backend";
import { emptyProfile } from "../src/model";

// Real backend, no mocked responses, DNS queries or native/TUN activation.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [1440, 390]) {
  test(`structured runtime editor → real saved preview → frozen output at ${width}`, async ({
    page,
    playwright,
    baseURL,
  }) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 1000 });
    const admin = await playwright.request.newContext({ baseURL });
    try {
      await inviteSyntheticAccount(admin, page.request);
      const session = await (await page.request.get("/api/auth/me")).json();
      const headers = { "X-CSRF-Token": session.csrfToken };
      const profile = emptyProfile();
      profile.name = "结构化运行旅程";
      profile.ir.name = profile.name;
      // Read the declared client-schema compatibility target, not the stock
      // server executable version. This test starts no native client process.
      const capabilitiesResponse = await page.request.get("/api/me/capabilities");
      expect(capabilitiesResponse.status()).toBe(200);
      const capabilities: { adapterId: string; versions: string[]; runtime: string[] }[] =
        await capabilitiesResponse.json();
      const clients = capabilities.filter((entry) => entry.adapterId === "sing-box");
      expect(clients).toHaveLength(1);
      expect(clients[0].versions).toHaveLength(1);
      expect(clients[0].runtime).toEqual(expect.arrayContaining(["dns", "sniff", "tun"]));
      profile.target = { adapterId: "sing-box", version: clients[0].versions[0] };
      profile.ir.runtime.dns = undefined;
      const created = await page.request.post("/api/me/profiles", {
        headers,
        data: profile,
      });
      expect(created.status(), await created.text()).toBe(200);
      await page.goto(`/#profiles?profile=${profile.id}`);
      await page.getByRole("button", { name: "继续配置", exact: true }).click();
      await page.getByRole("tab", { name: "分流规则", exact: true }).click();
      await page.getByRole("button", { name: "添加规则", exact: true }).click();
      await page
        .getByRole("textbox", { name: "规则匹配值", exact: true })
        .fill("structured.example");
      const destination = page.getByRole("combobox", {
        name: "规则 1 的流量去向",
        exact: true,
      });
      await destination.click();
      const destinationList = await destination.getAttribute("aria-controls");
      await page
        .locator(`[id="${destinationList}"]`)
        .locator('xpath=ancestor-or-self::*[@data-slot="popover-content"]')
        .locator("[role='option']")
        .getByText("直连", { exact: true })
        .click();
      await page.getByRole("tab", { name: "运行设置", exact: true }).click();
      await page.getByRole("switch", { name: "启用 DNS", exact: true }).click();
      await page
        .getByRole("textbox", { name: "DNS 服务器 1", exact: true })
        .fill("192.0.2.53");
      await page
        .getByRole("switch", { name: "启用流量嗅探", exact: true })
        .click();
      const tun = page.getByRole("switch", { name: "启用 TUN", exact: true });
      await tun.focus();
      await page.keyboard.press("Space");
      await expect(tun).toBeChecked();
      const save = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/profiles/${profile.id}`) &&
          r.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      expect((await save).status()).toBe(200);
      const result = await page.request.post(
        `/api/me/profiles/${profile.id}/preview`,
        { headers, data: {} },
      );
      expect(result.status(), await result.text()).toBe(200);
      expect((await result.json()).valid).toBe(true);
      const stored = await (
        await page.request.get(`/api/me/profiles/${profile.id}/reveal`)
      ).json();
      expect(stored.ir.runtime.dns.servers).toHaveLength(1);
      expect(stored.ir.runtime.dns.servers[0]).toMatchObject({
        type: "tls", address: "192.0.2.53", port: 853,
      });
      expect(stored.ir.runtime.dns.final).toBe(
        stored.ir.runtime.dns.servers[0].id,
      );
      expect(stored.ir.runtime).toMatchObject({
        sniff: true,
        tun: { enabled: true, addresses: ["172.19.0.1/30"], autoRoute: true },
      });
      expect(stored.ir.rules).toHaveLength(1);
      expect(stored.ir.rules[0]).toMatchObject({
        match: { op: "domain-suffix", value: "structured.example" },
        action: { kind: "direct" },
      });
      const published = await page.request.post("/api/me/outputs", {
        headers,
        data: { id: profile.id, name: profile.name, profileId: profile.id },
      });
      expect(published.status(), await published.text()).toBe(201);
      const output = await published.json();
      const feed = await page.request.get(output.feedPath);
      expect(feed.status()).toBe(200);
      const rendered = await feed.json();
      expect(rendered.dns).toEqual({
        final: stored.ir.runtime.dns.final,
        servers: [{
          tag: stored.ir.runtime.dns.servers[0].id,
          type: "tls", server: "192.0.2.53", server_port: 853,
        }],
      });
      expect(
        rendered.inbounds.some(
          (inbound: { type: string }) => inbound.type === "tun",
        ),
      ).toBe(true);
      expect(
        rendered.route.rules.some(
          (rule: { action: string }) => rule.action === "sniff",
        ),
      ).toBe(true);
      const frozen = await feed.text();
      await page.reload();
      expect(await (await page.request.get(output.feedPath)).text()).toBe(
        frozen,
      );
    } finally {
      await admin.dispose();
    }
  });
}
