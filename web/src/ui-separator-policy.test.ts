import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// This is an authoring rule, not a runtime text filter: user data is untouched.
const src = dirname(fileURLToPath(import.meta.url));
const generatedSeparator =
  /\u00b7|&(?:middot|centerdot);|&#0*183;|&#x0*b7;|\\(?:u0*00b7|u\{0*b7\}|x[bB]7)/i;
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.(?:tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [child]
      : [];
  });
}

it("uses layout instead of authored middle-dot separators in application UI", () => {
  const violations = [...sourceFiles(src), join(src, "../index.html")].flatMap(
    (path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          generatedSeparator.test(line)
            ? [`${relative(src, path)}:${index + 1}`]
            : [],
        ),
  );
  expect(violations).toEqual([]);
});
