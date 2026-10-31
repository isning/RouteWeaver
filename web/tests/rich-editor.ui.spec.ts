import { test, expect, type Page, type Locator } from "@playwright/test";
import { openWorkspace } from "./ui-session";
import { writeFile } from "node:fs/promises";
async function settle(root: Locator) {
  await expect(root).toBeVisible();
  await expect
    .poll(() =>
      root.evaluate((el) => {
        let p: Element | null = el;
        while (p) {
          if (p.getAnimations().some((a) => a.playState === "running"))
            return false;
          p = p.parentElement;
        }
        return !el
          .getAnimations({ subtree: true })
          .some((a) => a.playState === "running");
      }),
    )
    .toBe(true);
}
async function tabTo(page: Page, target: Locator) {
  const path = [];
  for (let i = 0; i < 100; i++) {
    if (await target.evaluate((e) => e === document.activeElement)) return path;
    await page.keyboard.press("Tab");
    path.push(
      await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        return {
          tag: e.tagName,
          name: e.getAttribute("aria-label") || e.textContent?.trim(),
          rect: e.getBoundingClientRect().toJSON(),
        };
      }),
    );
  }
  throw new Error("Tab traversal did not reach target");
}
const names = [
  "北区线路",
  "南区线路",
  "备用线路",
  "跨地区办公与旅行备用连接名称LongIdentity-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
];
async function fixture(page: Page) {
  await openWorkspace(page);
  const auth = await page.request.get("/api/auth/me");
  expect(auth.ok()).toBe(true);
  const headers = { "X-CSRF-Token": (await auth.json()).csrfToken };
  const created: string[] = [];
  const post = async (path: string, data: any) => {
    const r = await page.request.post("/api/me/" + path, { headers, data });
    expect(r.ok()).toBe(true);
    const v = await r.json();
    created.push(path + "/" + v.id);
    return v;
  };
  const suffix = Date.now().toString(36);
  const sources = [];
  for (let i = 0; i < names.length; i++)
    sources.push(
      await post("sources", {
        id: `rich-source-${suffix}-${i}`,
        name: names[i],
        kind: "text",
        enabled: true,
        content: `socks5://synthetic-${i}.example:1080#Editor ${i}`,
      }),
    );
  const steps = (prefix: string) => [
    {
      id: prefix + "rename",
      kind: "rename",
      enabled: false,
      template: prefix + " {name}",
    },
    { id: prefix + "dedupe", kind: "deduplicate", enabled: true },
    { id: prefix + "sort", kind: "sort", enabled: true, sortBy: "name" },
  ];
  const collection = await post("collections", {
    id: `rich-collection-${suffix}`,
    name: "有序处理编辑",
    sources: sources.map((s, i) => ({
      sourceId: s.id,
      steps: steps("source" + i),
    })),
    steps: steps("merged"),
  });
  await page.goto("/#collections");
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: collection.name, exact: true }),
    })
    .click();
  const drawer = page.getByRole("dialog", {
    name: collection.name,
    exact: true,
  });
  await settle(drawer);
  return {
    drawer,
    collection,
    headers,
    cleanup: async () => {
      for (const path of created.reverse()) {
        const r = await page.request.delete("/api/me/" + path, { headers });
        expect(r.ok()).toBe(true);
      }
    },
  };
}

test("source reorder is independent from disclosure for Enter and Space", async ({
  page,
}, info) => {
  const f = await fixture(page),
    out: any = {};
  try {
    const { drawer } = f;
    const disclosure = (name: string) =>
      drawer.getByRole("button", {
        name: new RegExp(`^[1-4]\\. ${name} 来源处理`),
      });
    await disclosure(names[0]).click();
    await disclosure(names[2]).click();
    await disclosure(names[1]).click();
    const down = drawer.getByRole("button", {
      name: "下移来源 2",
      exact: true,
    });
    out.tabPath = await tabTo(page, down);
    await page.keyboard.press("Enter");
    await expect(disclosure(names[1])).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure(names[1])).toContainText("3. 南区线路");
    await expect(
      drawer.getByRole("button", { name: "下移来源 3", exact: true }),
    ).toBeFocused();
    const sourceGroup = drawer.getByRole("group", {
      name: /^[1-4]\. 南区线路 来源处理/,
    });
    await expect(
      sourceGroup.getByRole("textbox", {
        name: "步骤 1 命名模板",
        exact: true,
      }),
    ).toHaveValue("source1 {name}");
    await expect(disclosure(names[0])).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure(names[2])).toHaveAttribute("aria-expanded", "true");
    await tabTo(page, disclosure(names[1]));
    await page.keyboard.press("Space");
    await expect(disclosure(names[1])).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.keyboard.press("Space");
    await expect(disclosure(names[1])).toHaveAttribute("aria-expanded", "true");
    await tabTo(
      page,
      drawer.getByRole("button", { name: "上移来源 3", exact: true }),
    );
    await page.keyboard.press("Space");
    await expect(disclosure(names[1])).toContainText("2. 南区线路");
    await expect(disclosure(names[1])).toHaveAttribute("aria-expanded", "true");
    await expect(
      drawer.getByRole("button", { name: "上移来源 2", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(disclosure(names[1])).toContainText("1. 南区线路");
    await expect(disclosure(names[1])).toHaveAttribute("aria-expanded", "true");
    const boundary = drawer.getByRole("button", {
      name: "上移来源 1",
      exact: true,
    });
    await expect(boundary).toHaveAttribute("aria-disabled", "true");
    await expect(boundary).toBeFocused();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await expect(disclosure(names[1])).toContainText("1. 南区线路");
    await page.keyboard.press("Space");
    await boundary.scrollIntoViewIfNeeded();
    const rect = await boundary.boundingBox();
    await page.mouse.click(
      rect!.x + rect!.width / 2,
      rect!.y + rect!.height / 2,
    );
    await expect(disclosure(names[1])).toContainText("1. 南区线路");
    await expect(disclosure(names[1])).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(
      drawer.getByRole("button", { name: "下移来源 1", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const last = drawer.getByRole("button", {
      name: "下移来源 4",
      exact: true,
    });
    await expect(last).toHaveAttribute("aria-disabled", "true");
    await expect(last).toBeFocused();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await page.keyboard.press("Space");
    await last.scrollIntoViewIfNeeded();
    const lastRect = await last.boundingBox();
    await page.mouse.click(
      lastRect!.x + lastRect!.width / 2,
      lastRect!.y + lastRect!.height / 2,
    );
    await expect(disclosure(names[1])).toContainText("4. 南区线路");
    await expect(disclosure(names[1])).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure(names[0])).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure(names[2])).toHaveAttribute("aria-expanded", "true");
    await expect(
      sourceGroup.getByRole("textbox", {
        name: "步骤 1 命名模板",
        exact: true,
      }),
    ).toHaveValue("source1 {name}");
    out.boundary = await describeControl(last);
    out.accessibility = await drawer.ariaSnapshot();
    const saved = await page.request.get("/api/me/collections");
    expect(saved.ok()).toBe(true);
    const stored = (await saved.json()).find(
      (x: any) => x.id === f.collection.id,
    );
    expect(stored.sources).toEqual(f.collection.sources);
    expect(stored.steps).toEqual(f.collection.steps);
  } finally {
    await writeFile(
      info.outputPath("keyboard.json"),
      JSON.stringify(out, null, 2),
    );
    await f.cleanup();
  }
});

test("both processing stages keep ordinary titles readable and offer genuine comfortable targets at 320px", async ({
  page,
}, info) => {
  const f = await fixture(page),
    out: any = {};
  try {
    const { drawer } = f;
    await drawer
      .getByRole("button", { name: /^2\. 南区线路 来源处理/ })
      .click();
    await page.setViewportSize({ width: 320, height: 568 });
    for (const stage of ["来源处理", "合并后处理"]) {
      const editor = drawer.locator(".steps-editor").filter({
        has: page.getByRole("heading", { name: stage, exact: true }),
      });
      const card = editor.locator(".processing-step").first();
      await card.scrollIntoViewIfNeeded();
      const title = card.locator("strong");
      const box = await title.boundingBox();
      expect(box).not.toBeNull();
      // A normal four-character title fits on one 22px line, not four vertical lines.
      expect(box!.height).toBeLessThanOrEqual(24);
      expect(box!.width).toBeGreaterThanOrEqual(56);
      const actions = await card.locator("button").evaluateAll((els) =>
        els.map((e) => ({
          name: e.getAttribute("aria-label"),
          rect: e.getBoundingClientRect().toJSON(),
        })),
      );
      for (const action of actions) {
        expect(action.rect.width).toBeGreaterThanOrEqual(44);
        expect(action.rect.height).toBeGreaterThanOrEqual(44);
      }
      out[stage] = { title: box, actions };
    }
  } finally {
    await writeFile(
      info.outputPath("geometry.json"),
      JSON.stringify(out, null, 2),
    );
    await f.cleanup();
  }
});

test("a processing-disabled step stays editable with readable active text", async ({
  page,
}, info) => {
  const f = await fixture(page),
    out: any = {};
  try {
    const { drawer } = f;
    await drawer
      .getByRole("button", { name: /^2\. 南区线路 来源处理/ })
      .click();
    const editor = drawer.getByRole("group", { name: "来源处理", exact: true });
    const input = editor.getByRole("textbox", {
      name: "步骤 1 命名模板",
      exact: true,
    });
    await input.fill("Prepared {name}");
    await expect(
      editor.getByRole("switch", { name: "启用步骤 1", exact: true }),
    ).not.toBeChecked();
    out.input = await input.evaluate((el) => {
      const rgb = (s: string) =>
        s
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
      const c = getComputedStyle(el),
        fg = rgb(c.color),
        bg = rgb(c.backgroundColor);
      let p: Element | null = el,
        opacity = 1;
      const ancestors = [];
      while (p) {
        const s = getComputedStyle(p);
        ancestors.push({
          tag: p.tagName,
          class: p.className,
          color: s.color,
          background: s.backgroundColor,
          opacity: s.opacity,
        });
        opacity *= Number(s.opacity);
        p = p.parentElement;
      }
      const effective = (color: number[]) =>
        color.map((x) => x * opacity + 255 * (1 - opacity));
      const light = (color: number[]) =>
        color
          .map((x) => x / 255)
          .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
          .reduce((n, x, i) => n + x * [0.2126, 0.7152, 0.0722][i], 0);
      const lights = [light(effective(fg)), light(effective(bg))].sort(
        (a, b) => a - b,
      );
      return {
        color: c.color,
        background: c.backgroundColor,
        opacity,
        ratio: (lights[1] + 0.05) / (lights[0] + 0.05),
        ancestors,
        disabled: (el as HTMLInputElement).disabled,
        readOnly: (el as HTMLInputElement).readOnly,
      };
    });
    expect(out.input.disabled).toBe(false);
    expect(out.input.readOnly).toBe(false);
    expect(out.input.ratio).toBeGreaterThanOrEqual(4.5);
  } finally {
    await writeFile(
      info.outputPath("contrast.json"),
      JSON.stringify(out, null, 2),
    );
    await f.cleanup();
  }
});

async function describeControl(control: Locator) {
  return control.evaluate((e) => {
    const r = e.getBoundingClientRect(),
      c = getComputedStyle(e),
      points = [
        [r.x + 3, r.y + 3],
        [r.right - 3, r.y + 3],
        [r.x + 3, r.bottom - 3],
        [r.right - 3, r.bottom - 3],
        [r.x + r.width / 2, r.y + r.height / 2],
      ];
    return {
      tag: e.tagName,
      name: e.getAttribute("aria-label"),
      role: e.getAttribute("role"),
      checked: e.getAttribute("aria-checked"),
      disabled: e.getAttribute("aria-disabled"),
      rect: r.toJSON(),
      color: c.color,
      background: c.backgroundColor,
      outline: c.outline,
      hitSamples: points.map(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return { x, y, inside: !!hit && (e === hit || e.contains(hit)) };
      }),
    };
  });
}
async function textStyle(control: Locator) {
  return control.evaluate((e) => {
    const c = getComputedStyle(e);
    let p: Element | null = e,
      opacity = 1;
    const ancestry = [];
    while (p) {
      const s = getComputedStyle(p);
      opacity *= Number(s.opacity);
      ancestry.push({
        tag: p.tagName,
        class: p.className,
        color: s.color,
        background: s.backgroundColor,
        opacity: s.opacity,
      });
      p = p.parentElement;
    }
    return {
      color: c.color,
      background: c.backgroundColor,
      font: c.font,
      fontSize: c.fontSize,
      opacity,
      rect: e.getBoundingClientRect().toJSON(),
      ancestry,
    };
  });
}
test("desktop and narrow pixels preserve identities, contained targets and editable off-state contrast", async ({
  page,
}, info) => {
  const f = await fixture(page),
    out: any = { viewports: {}, keyboard: {} };
  try {
    const { drawer } = f;
    const disclosure = drawer.getByRole("button", {
      name: /^2\. 南区线路 来源处理/,
    });
    await disclosure.click();
    for (const [width, height] of [
      [1366, 900],
      [390, 844],
      [320, 568],
    ]) {
      await page.setViewportSize({ width, height });
      await settle(drawer);
      out.viewports[width] = {};
      for (const stage of ["来源处理", "合并后处理"]) {
        const editor = drawer.getByRole("group", { name: stage, exact: true });
        const card = editor.locator(".processing-step").first();
        await card.scrollIntoViewIfNeeded();
        const controls = card.getByRole("button").or(card.getByRole("switch"));
        const measurements = [];
        for (const control of await controls.all()) {
          const measurement = await describeControl(control);
          measurements.push(measurement);
          expect(measurement.rect.width).toBeGreaterThanOrEqual(44);
          expect(measurement.rect.height).toBeGreaterThanOrEqual(44);
          expect(measurement.hitSamples.every((point) => point.inside)).toBe(
            true,
          );
          const bounds = await card.boundingBox();
          expect(measurement.rect.x).toBeGreaterThanOrEqual(bounds!.x + 14);
          expect(measurement.rect.right).toBeLessThanOrEqual(
            bounds!.x + bounds!.width - 14,
          );
        }
        const title = await textStyle(card.locator("strong"));
        expect(title.rect.height).toBeLessThanOrEqual(24);
        const label = await textStyle(card.locator("label"));
        const input = await textStyle(card.locator("input"));
        const helper = await textStyle(card.locator("small"));
        const state = await textStyle(
          card.getByText("已停用", { exact: true }),
        );
        expect(input.opacity).toBe(1);
        out.viewports[width][stage] = {
          controls: measurements,
          title,
          label,
          input,
          helper,
          state,
          card: await card.boundingBox(),
        };
        await page.screenshot({
          path: info.outputPath(
            `${stage === "来源处理" ? "source" : "merged"}-${width}.png`,
          ),
          animations: "disabled",
        });
      }
      const long = drawer.getByRole("button", {
        name: new RegExp(`^4\\. ${names[3]} 来源处理`),
      });
      await long.scrollIntoViewIfNeeded();
      await expect(long).toContainText(names[3]);
      out.viewports[width].longIdentity = await textStyle(long);
      await page.screenshot({
        path: info.outputPath(`identity-${width}.png`),
        animations: "disabled",
      });
      const overflow = await drawer.evaluate((e) => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        drawer: e.clientWidth,
        scrollWidth: e.scrollWidth,
      }));
      expect(overflow.document).toBeLessThanOrEqual(width);
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.drawer);
      out.viewports[width].overflow = overflow;
    }
    // The switch's empty-looking outer area is the button itself, not a fake wrapper.
    const editor = drawer.getByRole("group", {
      name: "合并后处理",
      exact: true,
    });
    const toggle = editor.getByRole("switch", {
      name: "启用步骤 1",
      exact: true,
    });
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click({ position: { x: 3, y: 3 } });
    await expect(toggle).toBeChecked();
    await toggle.click({ position: { x: 41, y: 41 } });
    await expect(toggle).not.toBeChecked();
    out.keyboard.toggleTabPath = await tabTo(page, toggle);
    await page.keyboard.press("Enter");
    await expect(toggle).toBeChecked();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    out.keyboard.focusedSwitch = await describeControl(toggle);
    await page.screenshot({
      path: info.outputPath("switch-focus-320.png"),
      animations: "disabled",
    });
    const input = editor.getByRole("textbox", {
      name: "步骤 1 命名模板",
      exact: true,
    });
    await input.fill("Prepared while stopped");
    await expect(toggle).not.toBeChecked();
    const saved = await page.request.get("/api/me/collections");
    expect(saved.ok()).toBe(true);
    const stored = (await saved.json()).find(
      (x: any) => x.id === f.collection.id,
    );
    expect(stored.sources).toEqual(f.collection.sources);
    expect(stored.steps).toEqual(f.collection.steps);
    out.noImplicitSave = true;
  } finally {
    await writeFile(
      info.outputPath("pixels-and-targets.json"),
      JSON.stringify(out, null, 2),
    );
    await f.cleanup();
  }
});

test("step order and execution state stay with the acted-on step at both boundaries", async ({
  page,
}, info) => {
  const f = await fixture(page),
    out: any = {};
  try {
    const { drawer } = f;
    await drawer
      .getByRole("button", { name: /^2\. 南区线路 来源处理/ })
      .click();
    for (const stage of ["来源处理", "合并后处理"]) {
      const editor = drawer.getByRole("group", { name: stage, exact: true });
      const down = editor.getByRole("button", {
        name: "下移步骤 1",
        exact: true,
      });
      out[stage] = await tabTo(page, down);
      await page.keyboard.press("Enter");
      await expect(
        editor.getByRole("button", { name: "下移步骤 2", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Space");
      const boundary = editor.getByRole("button", {
        name: "下移步骤 3",
        exact: true,
      });
      await expect(boundary).toHaveAttribute("aria-disabled", "true");
      await expect(boundary).toBeFocused();
      await page.keyboard.down("Enter");
      await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
      await page.keyboard.press("Space");
      await boundary.scrollIntoViewIfNeeded();
      const rect = await boundary.boundingBox();
      await page.mouse.click(
        rect!.x + rect!.width / 2,
        rect!.y + rect!.height / 2,
      );
      await expect(
        editor.getByRole("textbox", { name: "步骤 3 命名模板", exact: true }),
      ).toHaveValue(stage === "来源处理" ? "source1 {name}" : "merged {name}");
      await expect(
        editor.getByRole("switch", { name: "启用步骤 3", exact: true }),
      ).not.toBeChecked();
      const up = editor.getByRole("button", {
        name: "上移步骤 3",
        exact: true,
      });
      await tabTo(page, up);
      await page.keyboard.press("Space");
      await expect(
        editor.getByRole("button", { name: "上移步骤 2", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      const first = editor.getByRole("button", {
        name: "上移步骤 1",
        exact: true,
      });
      await expect(first).toHaveAttribute("aria-disabled", "true");
      await expect(first).toBeFocused();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      await expect(
        editor.getByRole("textbox", { name: "步骤 1 命名模板", exact: true }),
      ).toHaveValue(stage === "来源处理" ? "source1 {name}" : "merged {name}");
    }
  } finally {
    await writeFile(
      info.outputPath("step-keyboard.json"),
      JSON.stringify(out, null, 2),
    );
    await f.cleanup();
  }
});

test("disabled boundary controls retain their disabled visual state under pointer hover", async ({
  page,
}, info) => {
  const f = await fixture(page),
    out: Record<string, unknown> = {};
  try {
    const { drawer } = f;
    await drawer
      .getByRole("button", { name: /^1\. 北区线路 来源处理/ })
      .click();
    for (const [name, target] of [
      [
        "source",
        drawer.getByRole("button", { name: "上移来源 1", exact: true }),
      ],
      [
        "step",
        drawer
          .getByRole("group", { name: "来源处理", exact: true })
          .getByRole("button", { name: "上移步骤 1", exact: true }),
      ],
    ] as const) {
      await target.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await settle(drawer);
      const colors = () =>
        target.evaluate((e) => {
          const c = getComputedStyle(e);
          return {
            color: c.color,
            background: c.backgroundColor,
            border: c.borderColor,
          };
        });
      const before = await colors();
      await target.hover();
      await settle(drawer);
      const after = await colors();
      out[name] = { before, after };
      await expect(target).toHaveAttribute("aria-disabled", "true");
      expect(after).toEqual(before);
    }
  } finally {
    await writeFile(
      info.outputPath("disabled-hover.json"),
      JSON.stringify(out, null, 2),
    );
    await f.cleanup();
  }
});
