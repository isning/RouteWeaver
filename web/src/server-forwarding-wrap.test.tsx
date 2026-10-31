// @vitest-environment jsdom
import { expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { compile } from "tailwindcss";
import { Table, TableBody, TableCell, TableRow } from "./components/ui/table";
import { ServerForwarding } from "./ServerForwarding";
import type { Infrastructure, ServerProgram } from "./types";

it("overrides TableCell nowrap so a compact destination wraps within its column", async () => {
  const destination = "lon.demo.invalid:443";
  const program = {
    instance: {
      id: "core",
      hostId: "host",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    },
    listener: {
      id: "entry",
      name: "FRA",
      instanceId: "core",
      connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
    },
    connectors: [
      {
        id: "exit",
        connection: { protocol: "socks", host: "lon.demo.invalid", port: 443 },
      },
    ],
    defaultAction: { kind: "forward", ref: "exit" },
  } as ServerProgram;
  const inventory = {
    hosts: [{ id: "host", name: "FRA", address: "fra.demo.invalid" }],
    instances: [program.instance],
    endpoints: [program.listener],
    links: [],
    deployments: [],
  } as Infrastructure;
  const stylesheet = document.createElement("style");
  // Compile the installed Tailwind utilities, rather than asserting class names
  // or inventing CSS that happens to make this example pass.
  stylesheet.textContent = (await compile("@tailwind utilities;")).build([
    "whitespace-nowrap",
    "whitespace-normal",
    "[overflow-wrap:anywhere]",
  ]);
  document.head.append(stylesheet);
  try {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>
              <ServerForwarding
                compact
                programs={[program]}
                inventory={inventory}
              />
            </TableCell>
            <TableCell>2 个</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const cell = container.querySelector("td")!;
    const summary = container.querySelector(".server-forwarding")!;
    const destinationText = summary.querySelector("dd")!;
    // Read matched declarations from the real compiler's CSSOM. jsdom can
    // return an initial 'normal' value instead of resolving inherited nowrap,
    // so getComputedStyle alone would falsely accept the original defect.
    const specified = (element: Element, property: string) => {
      let value = "";
      for (const rule of [...stylesheet.sheet!.cssRules]) {
        if (
          "selectorText" in rule &&
          element.matches((rule as CSSStyleRule).selectorText)
        ) {
          value =
            (rule as CSSStyleRule).style.getPropertyValue(property) || value;
        }
      }
      return value;
    };
    expect(specified(cell, "white-space")).toBe("nowrap");
    expect(specified(summary, "white-space")).toBe("normal");
    expect(specified(summary, "overflow-wrap")).toBe("anywhere");
    let element: Element | null = destinationText;
    let effectiveWhiteSpace = "";
    while (element && !effectiveWhiteSpace) {
      effectiveWhiteSpace = specified(element, "white-space");
      element = element.parentElement;
    }
    expect(effectiveWhiteSpace).toBe("normal");
    expect(destinationText.textContent).toBe(`转发至 ${destination}`);
  } finally {
    cleanup();
    stylesheet.remove();
  }
});
