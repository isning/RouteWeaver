import { writeFile } from "node:fs/promises";
import { test, expect, type Page, type TestInfo } from "@playwright/test";

// Actual App/CollectionsPage/StepsEditor, with a synthetic HTTP boundary only.
// Preview is fulfilled locally; no collection/source/publication write escapes.
test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});
const draftName = "多选标签草稿";
const fixtures: Record<string, unknown> = {
  "/auth/me": {
    user: { id: "tag-owner", name: "标签测试用户", role: "user" },
    csrfToken: "synthetic",
  },
  "/me/collections": [],
  "/me/sources": [],
  "/me/inbox": [],
};
type Entry = {
  method: string;
  target: string;
  outcome: "fixture" | "preview" | "blocked";
};
const knownValues = [
  "",
  draftName,
  "keep",
  "Office",
  "HK",
  "HK-West",
  "tag-a",
  "tag-b",
  "unfinished",
  "cancelled",
  "vless",
  "{name}",
  "name",
];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const known = (value: unknown) =>
  typeof value === "string" && knownValues.includes(value)
    ? value
    : value === undefined
      ? null
      : "unrecognized";
function sanitizedPreview(value: unknown) {
  if (value === undefined) return null;
  const body = record(value);
  return {
    idValid:
      typeof body.id === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(body.id),
    name: known(body.name),
    sourceCount: Array.isArray(body.sources) ? body.sources.length : null,
    steps: Array.isArray(body.steps)
      ? body.steps.map((value) => {
          const step = record(value),
            filter = record(step.filter);
          return {
            idValid:
              typeof step.id === "string" &&
              /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(step.id),
            kind: known(step.kind),
            enabled: typeof step.enabled === "boolean" ? step.enabled : null,
            template: known(step.template),
            sortBy: known(step.sortBy),
            filter: {
              namePattern: known(filter.namePattern),
              region: known(filter.region),
              protocol: known(filter.protocol),
              tags: Array.isArray(filter.tags) ? filter.tags.map(known) : null,
            },
          };
        })
      : null,
  };
}

// IDs come only from the two public preview requests, never private component state.
// Persist the comparison, not the generated identities themselves.
function identityContinuity(previews: unknown[]) {
  if (previews.length !== 2)
    return { compared: false, sameCollection: null, sameStep: null };
  const before = record(previews[0]),
    after = record(previews[1]);
  const beforeStep = record(
    Array.isArray(before.steps) ? before.steps[0] : undefined,
  );
  const afterStep = record(
    Array.isArray(after.steps) ? after.steps[0] : undefined,
  );
  return {
    compared: true,
    sameCollection: typeof before.id === "string" && before.id === after.id,
    sameStep:
      typeof beforeStep.id === "string" && beforeStep.id === afterStep.id,
  };
}
function payloadWithoutIDs(value: unknown) {
  const { id: _id, ...body } = record(value);
  return {
    ...body,
    steps: Array.isArray(body.steps)
      ? body.steps.map((value) => {
          const { id: _id, ...step } = record(value);
          return step;
        })
      : body.steps,
  };
}

async function capture(
  page: Page,
  info: TestInfo,
  phase: string,
  requests: Entry[],
  previews: unknown[],
) {
  const png = info.outputPath(`${phase}.png`),
    json = info.outputPath(`${phase}.json`);
  const deadline = Date.now() + 2500;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0)
      throw new Error("MultiChoice evidence capture exceeded 2.5 seconds");
    return ms;
  };
  // Original current viewport, no crops, masks, disabled animations, focus or scroll repair.
  await page.screenshot({ path: png, fullPage: false, timeout: remaining() });
  const observation = await page.locator("body").evaluate(
    (_body, allowed) => {
      const labels = [...document.querySelectorAll("label")];
      const field = (name: string, selector: string) =>
        labels
          .find((label) => label.textContent?.trim().startsWith(name))
          ?.querySelector(selector) ?? null;
      const exposed = (element: Element) =>
        !element.closest('[inert], [aria-hidden="true"]') &&
        getComputedStyle(element).display !== "none";
      const search =
        [...document.querySelectorAll("[cmdk-input]")].find(exposed) ?? null;
      const inspect = (element: Element | null) => {
        if (!element) return null;
        const box = element.getBoundingClientRect();
        let left = Math.max(0, box.left),
          top = Math.max(0, box.top),
          right = Math.min(innerWidth, box.right),
          bottom = Math.min(innerHeight, box.bottom);
        for (
          let parent = element.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent),
            r = parent.getBoundingClientRect();
          if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
            left = Math.max(left, r.left + parent.clientLeft);
            right = Math.min(
              right,
              r.left + parent.clientLeft + parent.clientWidth,
            );
          }
          if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
            top = Math.max(top, r.top + parent.clientTop);
            bottom = Math.min(
              bottom,
              r.top + parent.clientTop + parent.clientHeight,
            );
          }
        }
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return {
          focused: document.activeElement === element,
          box: {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
          },
          unclipped:
            exposed(element) &&
            box.width > 0 &&
            box.height > 0 &&
            left <= box.left + 1 &&
            top <= box.top + 1 &&
            right >= box.right - 1 &&
            bottom >= box.bottom - 1,
          unobscured: !!hit && element.contains(hit),
        };
      };
      const value = (element: Element | null) => {
        if (!(element instanceof HTMLInputElement)) return null;
        return allowed.includes(element.value) ? element.value : "unrecognized";
      };
      const tags = field("包含标签", '[role="combobox"]');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        horizontalOverflow:
          document.documentElement.scrollWidth > innerWidth + 1,
        targets: {
          search: inspect(search),
          tags: inspect(tags),
          region: inspect(field("地区", "input")),
          protocol: inspect(field("连接协议", '[role="combobox"]')),
          preview: inspect(
            document.querySelector('button[aria-label="预览处理结果"]'),
          ),
        },
        values: {
          name: value(field("集合名称", "input")),
          namePattern: value(field("名称正则", "input")),
          region: value(field("地区", "input")),
          query: value(search),
          tags: ["tag-a", "tag-b"].filter(
            (tag) =>
              !!document.querySelector(`button[aria-label="移除 ${tag}"]`),
          ),
          tagsExpanded: tags?.getAttribute("aria-expanded") ?? null,
          stepEnabled:
            document
              .querySelector('[role="switch"][aria-label="启用步骤 1"]')
              ?.getAttribute("aria-checked") ?? null,
        },
        options: [...document.querySelectorAll('[role="option"]')]
          .filter(exposed)
          .map(inspect),
      };
    },
    knownValues,
    { timeout: remaining() },
  );
  await writeFile(
    json,
    JSON.stringify(
      {
        scope:
          "Synthetic HTTP UI, no backend enforcement or saved-collection evidence",
        phase,
        observation,
        requests,
        previews: previews.map(sanitizedPreview),
        identityContinuity: identityContinuity(previews),
      },
      null,
      2,
    ),
  );
  // Both originals exist before attachments or any checkpoint assertion.
  await info.attach(phase, { path: png, contentType: "image/png" });
  await info.attach(`${phase}-observation`, {
    path: json,
    contentType: "application/json",
  });
  return observation;
}

// Read-only bounded waits for natural motion/teardown, never force animation presence.
async function settledPopup(page: Page, id: string) {
  await page.waitForFunction(
    (id) => {
      const content = document.getElementById(id);
      return (
        !!content &&
        getComputedStyle(content).opacity === "1" &&
        !content
          .getAnimations()
          .some((animation) => animation.playState === "running")
      );
    },
    id,
    { timeout: 2000 },
  );
}
async function closedPopup(page: Page, id: string) {
  await page
    .locator(`[id=${JSON.stringify(id)}]`)
    .waitFor({ state: "detached", timeout: 2000 });
}

for (const width of [1440, 390]) {
  test(`processing tags survive rapid Escape/reopen and newer focus at ${width}x560`, async ({
    page,
    baseURL,
  }, info) => {
    const requests: Entry[] = [],
      previews: unknown[] = [];
    let failed = false,
      originalError: unknown,
      evidenceError: unknown;
    let pageErrors = 0;
    page.on("pageerror", () => pageErrors++);
    const checkpoint = async (
      phase: string,
      target: "search" | "tags" | "region" | "protocol" | "preview",
    ) => {
      const state = await capture(page, info, phase, requests, previews);
      expect(state.viewport).toEqual({ width, height: 560 });
      expect(state.horizontalOverflow).toBe(false);
      expect(state.targets[target]).toMatchObject({
        focused: true,
        unclipped: true,
        unobscured: true,
      });
      return state;
    };
    try {
      if (
        !baseURL ||
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
      )
        throw new Error("MultiChoice journey requires loopback");
      const origin = new URL(baseURL).origin;
      page.setDefaultTimeout(5000);
      await page.setViewportSize({ width, height: 560 });
      await page.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          method = request.method();
        const sameOrigin = url.origin === origin;
        const staticAsset =
          url.pathname === "/" ||
          [
            "/assets/",
            "/src/",
            "/node_modules/",
            "/@vite/",
            "/@react-refresh",
          ].some((prefix) => url.pathname.startsWith(prefix)) ||
          ["/favicon.ico", "/vite.svg"].includes(url.pathname);
        if (sameOrigin && method === "GET" && staticAsset)
          return route.continue();
        const key = url.pathname.slice(4);
        if (
          sameOrigin &&
          !url.search &&
          url.pathname.startsWith("/api/") &&
          method === "GET" &&
          Object.hasOwn(fixtures, key)
        ) {
          requests.push({ method, target: key, outcome: "fixture" });
          return route.fulfill({ json: fixtures[key] });
        }
        if (
          sameOrigin &&
          !url.search &&
          method === "POST" &&
          url.pathname === "/api/me/collections/preview"
        ) {
          requests.push({
            method,
            target: "/me/collections/preview",
            outcome: "preview",
          });
          try {
            previews.push(request.postDataJSON());
          } catch {
            previews.push(null);
          }
          return route.fulfill({
            json: { valid: true, endpoints: [], stages: [] },
          });
        }
        requests.push({ method, target: "unexpected", outcome: "blocked" });
        return route.abort("blockedbyclient");
      });
      await page.goto("/#collections");
      await page
        .getByRole("button", { name: "新建集合", exact: true })
        .first()
        .click();
      const editor = page.getByRole("dialog", {
        name: "新建集合",
        exact: true,
      });
      const name = editor.getByRole("textbox", {
        name: "集合名称",
        exact: true,
      });
      await name.fill(draftName);
      const stage = editor.getByRole("group", {
        name: "合并后处理",
        exact: true,
      });
      await stage
        .getByRole("combobox", { name: "添加处理步骤", exact: true })
        .click();
      await page.getByRole("option", { name: "保留匹配", exact: true }).click();
      // Stopped processing is still editable and must remain stopped throughout.
      await stage
        .getByRole("switch", { name: "启用步骤 1", exact: true })
        .click();
      await stage
        .getByRole("textbox", { name: "名称正则", exact: true })
        .fill("Office");
      const region = stage.getByRole("textbox", { name: "地区", exact: true });
      await region.fill("HK");
      // Observe authored IDs through the ordinary public draft preview before
      // tag editing. This does not save the collection or replace its draft.
      const initialResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/me/collections/preview",
      );
      await editor
        .getByRole("button", { name: "预览处理结果", exact: true })
        .click();
      await initialResponse;
      await capture(page, info, "initial-draft-preview", requests, previews);
      expect(previews).toHaveLength(1);
      expect(sanitizedPreview(previews[0])).toMatchObject({
        idValid: true,
        steps: [{ idValid: true }],
      });
      expect(payloadWithoutIDs(previews[0])).toEqual({
        name: draftName,
        sources: [],
        steps: [
          {
            kind: "keep",
            enabled: false,
            template: "{name}",
            sortBy: "name",
            filter: { namePattern: "Office", region: "HK" },
          },
        ],
      });
      const tags = stage.getByRole("combobox", { name: /包含标签/ });
      await tags.click();
      const tagsPopup = (await tags.getAttribute("aria-controls"))!;
      await page.keyboard.type("tag-a");
      await settledPopup(page, tagsPopup);
      const first = await checkpoint("first-tag-option", "search");
      expect(first.values.query).toBe("tag-a");
      expect(first.options).toHaveLength(1);
      expect(first.options[0]).toMatchObject({
        unclipped: true,
        unobscured: true,
      });
      await page.keyboard.press("Enter");
      await page.keyboard.type("unfinished");
      await page.keyboard.press("Escape");
      // No exit wait, search click, forced focus, or assertion between dismissal and reopening.
      await tags.click();
      await settledPopup(page, tagsPopup);
      const reopened = await checkpoint("same-trigger-reopened", "search");
      expect(reopened.values).toMatchObject({
        name: draftName,
        namePattern: "Office",
        region: "HK",
        tags: ["tag-a"],
        tagsExpanded: "true",
        stepEnabled: "false",
        query: "",
      });
      await page.keyboard.type("tag-b");
      await page.keyboard.press("Enter");
      const second = await checkpoint("second-tag-created", "search");
      expect(second.values.tags).toEqual(["tag-a", "tag-b"]);
      await page.keyboard.press("Escape");
      await closedPopup(page, tagsPopup);
      const returned = await checkpoint("returned-to-tag-trigger", "tags");
      expect(returned.values.tagsExpanded).toBe("false");

      await tags.click();
      await page.keyboard.type("cancelled");
      await page.keyboard.press("Escape");
      await region.click();
      await page.keyboard.press("End");
      await page.keyboard.type("-West");
      await closedPopup(page, tagsPopup);
      const newerField = await checkpoint("newer-region-owner", "region");
      expect(newerField.values).toMatchObject({
        region: "HK-West",
        tags: ["tag-a", "tag-b"],
        tagsExpanded: "false",
      });

      await tags.click();
      await page.keyboard.press("Escape");
      const protocol = stage.getByRole("combobox", { name: /连接协议/ });
      await protocol.click();
      const protocolPopup = (await protocol.getAttribute("aria-controls"))!;
      await page.keyboard.type("vless");
      await closedPopup(page, tagsPopup);
      await settledPopup(page, protocolPopup);
      const newerPicker = await checkpoint("newer-protocol-owner", "search");
      expect(newerPicker.values.query).toBe("vless");
      expect(newerPicker.values.tags).toEqual(["tag-a", "tag-b"]);
      await page.keyboard.press("Enter");
      await closedPopup(page, protocolPopup);
      await checkpoint("protocol-selected", "protocol");
      await expect(protocol).toHaveText("vless");

      const response = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/me/collections/preview",
      );
      await editor
        .getByRole("button", { name: "预览处理结果", exact: true })
        .click();
      await response;
      await capture(page, info, "preview-draft", requests, previews);
      expect(previews).toHaveLength(2);
      expect(identityContinuity(previews)).toEqual({
        compared: true,
        sameCollection: true,
        sameStep: true,
      });
      expect(payloadWithoutIDs(previews[1])).toEqual({
        name: draftName,
        sources: [],
        steps: [
          {
            kind: "keep",
            enabled: false,
            template: "{name}",
            sortBy: "name",
            filter: {
              namePattern: "Office",
              region: "HK-West",
              tags: ["tag-a", "tag-b"],
              protocol: "vless",
            },
          },
        ],
      });
      await expect(name).toHaveValue(draftName);
      await expect(
        stage.getByRole("button", { name: "移除 tag-a", exact: true }),
      ).toHaveCount(1);
      await expect(
        stage.getByRole("button", { name: "移除 tag-b", exact: true }),
      ).toHaveCount(1);
      expect(pageErrors).toBe(0);
    } catch (error) {
      failed = true;
      originalError = error;
    } finally {
      try {
        await capture(
          page,
          info,
          failed ? "failure-original" : "final-state",
          requests,
          previews,
        );
      } catch (error) {
        evidenceError = error;
      }
      // Gate requests after final capture, then persist even a late failure.
      // A task/network failure remains primary if evidence collection also fails.
      try {
        expect(requests.filter((entry) => entry.outcome === "blocked")).toEqual(
          [],
        );
        expect(requests.filter((entry) => entry.method !== "GET")).toEqual([
          {
            method: "POST",
            target: "/me/collections/preview",
            outcome: "preview",
          },
          {
            method: "POST",
            target: "/me/collections/preview",
            outcome: "preview",
          },
        ]);
        expect(pageErrors).toBe(0);
      } catch (error) {
        if (!failed) {
          failed = true;
          originalError = error;
        }
      }
      // Independent, sanitized ledger survives missing pages, screenshot failures,
      // assertion failures and attachment failures. Never serialize raw errors/URLs/headers.
      const path = info.outputPath("request-ledger.json");
      let saved = false;
      try {
        await writeFile(
          path,
          JSON.stringify(
            {
              scope:
                "Synthetic HTTP only; no collection saved, source imported or subscription published",
              viewport: { width, height: 560 },
              task: failed ? "failed" : "completed",
              finalCapture: evidenceError ? "failed-or-timed-out" : "saved",
              pageErrors,
              requests,
              previews: previews.map(sanitizedPreview),
              identityContinuity: identityContinuity(previews),
            },
            null,
            2,
          ),
        );
        saved = true;
      } catch (error) {
        evidenceError ??= error;
      }
      if (saved)
        try {
          await info.attach("request-ledger", {
            path,
            contentType: "application/json",
          });
        } catch (error) {
          evidenceError ??= error;
        }
    }
    if (failed) throw originalError;
    if (evidenceError) throw evidenceError;
  });
}
