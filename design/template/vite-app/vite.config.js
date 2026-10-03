import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    host: true,
    allowedHosts: ["store.deckfamilyfarm.com", "subscribe.deckfamilyfarm.com", "dropsites.deckfamilyfarm.com", "turkeys.deckfamilyfarm.com"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5177",
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 5176,
    host: true,
    allowedHosts: ["store.deckfamilyfarm.com", "subscribe.deckfamilyfarm.com", "dropsites.deckfamilyfarm.com", "turkeys.deckfamilyfarm.com"],
  },
});
