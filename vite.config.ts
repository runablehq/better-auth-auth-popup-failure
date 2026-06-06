import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const APP_PORT = Number(process.env.APP_PORT ?? "5173");
const API_PORT = Number(process.env.API_PORT ?? "5174");

export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
    port: APP_PORT,
    proxy: {
      "/api": `http://localhost:${API_PORT}`,
    },
  },
});
