import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("node_modules/react/") ||
              id.includes("node_modules/react-dom/") ||
              id.includes("node_modules/react-router")
            )
              return "vendor-react";
            if (id.includes("node_modules/xlsx")) return "xlsx";
            if (
              id.includes("node_modules/lucide-react") ||
              id.includes("node_modules/radix-ui") ||
              id.includes("node_modules/@radix-ui/")
            )
              return "vendor-ui";
            if (id.includes("node_modules/zustand")) return "vendor-state";
            return "vendor";
          }
        },
      },
    },
  },
});
