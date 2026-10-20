import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// `npm run dev` serves the client with live reload and hands /ws to a running backend.
export default defineConfig({
  plugins: [solid()],
  server: { port: 5173, proxy: { "/ws": { target: "ws://127.0.0.1:6739", ws: true } } },
  build: { target: "es2022" },
});
