import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      // Preserve the browser-facing Host so the backend can enforce same-origin mutations.
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: false },
      "/feed": { target: "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
  build: { sourcemap: false },
});
