import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { boneyardPlugin } from "boneyard-js/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    boneyardPlugin({
      routes: ["/", "/archive", "/admin", "/pools/dgddigital/cookies_only", "/tools/splitter", "/file/smoke"],
      wait: 1200,
    }),
  ],
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
      "/ws": {
        target: "http://localhost:3000",
        ws: true,
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
            if (id.includes("node_modules/boneyard-js")) return "vendor-boneyard";
            if (id.includes("node_modules/xlsx")) return "xlsx";
            if (id.includes("node_modules/lucide-react") || id.includes("node_modules/radix-ui"))
              return "vendor-ui";
            if (id.includes("node_modules/zustand")) return "vendor-state";
            return "vendor";
          }
        },
      },
    },
  },
});
