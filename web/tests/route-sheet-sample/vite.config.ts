import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Test-only build. No entry is added to the shipped app or control plane.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) },
  },
  build: {
    sourcemap: false,
    rolldownOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});
