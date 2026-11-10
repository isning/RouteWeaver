import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(new URL("../src/shadcn.css", import.meta.url), "utf8");
type RGB = [number, number, number];
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const encode = (v: number) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
const decode = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
function token(name: string, dark = false): RGB {
  const section = css.slice(css.indexOf(dark ? ".dark {" : ":root {"));
  const value = section.match(
    new RegExp(`--${name}:\\s*oklch\\(([^)]+)\\)`),
  )?.[1];
  if (!value) throw new Error(`Missing semantic token ${name}`);
  const [L, C, h] = value.split(/\s+/).map(Number),
    a = C * Math.cos((h * Math.PI) / 180),
    b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((v) => encode(clamp(v))) as RGB;
}
const composite = (foreground: RGB, background: RGB, alpha: number) =>
  foreground.map((v, i) => v * alpha + background[i] * (1 - alpha)) as RGB;
const luminance = (rgb: RGB) =>
  rgb.reduce((sum, v, i) => sum + decode(v) * [0.2126, 0.7152, 0.0722][i], 0);
function contrast(a: RGB, b: RGB) {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}

// These meaningful-text contexts formerly had separate CSS declarations. They
// now share official semantic utilities; test the actual shared palette on all
// rendered neutral surfaces, rather than retaining fictitious AntD selectors.
it.each([
  ".muted",
  ".table-scroll-hint",
  ".breadcrumb",
  ".countdown",
  ".key-value > span:first-child",
  ".metric-label",
  ".metric-note",
  ".route-option p",
  ".route-option .ant-tag",
  ".subtle-callout h3",
  ".subtle-callout p",
  ".table-subtitle",
  ".inline-note",
  ".collection-card p",
  ".step-index",
  ".rule-action",
  ".setting-toggle p",
  ".access-client p",
  ".access-note",
  ".hop-position",
  ".login-form > p",
  ".login-form .ant-form-item-label label",
  ".login-links .ant-btn",
  ".login-advanced",
  ".app-loading",
  ".advanced-nav",
  '.standalone-label input[type="file"]',
  ".security-enabled p",
  ".inbox-copy > span",
  ".inbox-item small",

  ".server-address",
  ".profile-card p",
  ".profile-meta",
  ".host-summary p",
  ".server-card-footer",
  ".page-heading p",
  ".section-heading p",
  ".empty-state p",
  ".source-choice small",
  ".back-button",
  ".workspace-label",
  ".account-button small",
  ".step-fields > label > small",
  ".pipeline-merge",
  ".inline-empty",
  ".react-flow__node small",
  ".route-detail-hop small",
  ".forwarding-summary p",
])("keeps meaningful small text %s readable on light surfaces", () => {
  for (const surface of ["background", "card", "muted", "sidebar", "popover"])
    expect(
      contrast(token("muted-foreground"), token(surface)),
    ).toBeGreaterThanOrEqual(4.5);
});
it("keeps library secondary, placeholder and description text readable", () => {
  for (const dark of [false, true])
    for (const surface of ["background", "card", "muted"])
      expect(
        contrast(token("muted-foreground", dark), token(surface, dark)),
      ).toBeGreaterThanOrEqual(4.5);
});
it.each(["Warning", "Success", "Error", "Info"])(
  "keeps %s status labels readable on their actual surfaces",
  (status) => {
    const text = token(
      status === "Error" ? "destructive" : "secondary-foreground",
    );
    const background =
      status === "Error"
        ? composite(token("destructive"), token("card"), 0.1)
        : token("secondary");
    expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
  },
);
it("keeps table headings readable", () =>
  expect(
    contrast(token("foreground"), token("background")),
  ).toBeGreaterThanOrEqual(4.5));
it.each(["green", "orange"])(
  "keeps former %s status intent readable with official neutral badges",
  () =>
    expect(
      contrast(token("secondary-foreground"), token("secondary")),
    ).toBeGreaterThanOrEqual(4.5),
);
it("keeps the app footer legible on its page background", () => {
  expect(
    contrast(token("muted-foreground"), token("background")),
  ).toBeGreaterThanOrEqual(4.5);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  expect(app).toMatch(/<footer[^>]+className="[^"]*text-xs/);
});
it("keeps destructive descriptions readable at the actual official 90% text opacity", () =>
  expect(
    contrast(
      composite(token("destructive"), token("card"), 0.9),
      token("card"),
    ),
  ).toBeGreaterThanOrEqual(4.5));
it("uses in-gamut accessible light tokens so contrast does not rely on browser gamut clipping", () => {
  expect(token("muted-foreground").every((v) => v > 0 && v < 1)).toBe(true);
  expect(token("destructive").every((v) => v > 0 && v < 1)).toBe(true);
});

// Public semantic-token seam: the shared neutral focus halo is painted at 50%
// opacity. This guards its contrast on these light surfaces, not all controls,
// error overrides, dark mode, focus area, or whole-app WCAG conformance.
it.each(["background", "card", "muted", "sidebar", "popover"])(
  "keeps the light neutral half-opacity focus halo distinguishable on %s",
  (surface) => {
    const background = token(surface);
    expect(contrast(composite(token("ring"), background, 0.5), background))
      .toBeGreaterThanOrEqual(3);
  },
);

// Ordinary dark controls retain the shared 50% halo. Target 3:1 against
// these adjacent neutral surfaces, including the brighter muted surface.
// This is a bounded palette guard, not a focus-area or compliance verdict.
it.each(["background", "card", "muted", "popover"])(
  "keeps the dark neutral half-opacity focus halo distinguishable on %s",
  (surface) => {
    const background = token(surface, true);
    expect(contrast(composite(token("ring", true), background, 0.5), background))
      .toBeGreaterThanOrEqual(3);
  },
);
