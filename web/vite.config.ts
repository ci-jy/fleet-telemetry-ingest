import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 25173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${process.env.PORT ?? 23000}` },
  },
});
