import { app } from "electron";

if (!process.env.DESKTOP_BACKEND_MODULE_ENTRY && !app.isPackaged) {
  process.env.DESKTOP_BACKEND_MODULE_ENTRY =
    "desktop-container/backend/electron-service.ts";
}

await import("../../desktop/electron/main.mjs");
