import { mergeConfig, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import base from "../vite.config.ts";

const mode = process.env.ROUTEWEAVER_RESOURCE_LAYOUT;
if (mode !== "baseline" && mode !== "proposal")
  throw new Error("Choose an explicit diagnostic-only resource layout");

const proposal = fileURLToPath(
  new URL("./resource-layout-proposal.tsx", import.meta.url),
);
const selectLayout: Plugin = {
  name: "diagnostic-only-resource-layout",
  enforce: "pre",
  resolveId(source, importer) {
    if (
      mode === "proposal" &&
      source === "./Resources" &&
      importer?.split("?")[0].replaceAll("\\", "/").endsWith("/src/Sources.tsx")
    )
      return proposal;
  },
};

const config = mergeConfig(base, { plugins: [selectLayout] });
// This comparison has no backend. A missed fixture must never fall through to
// the production development proxy, even if another local service exists.
config.server = { ...config.server, proxy: {} };
export default config;
