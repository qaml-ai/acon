process.env.DESKTOP_BACKEND_MODULE_ENTRY ||=
  "desktop-container/backend/electron-service.ts";

await import("../../desktop/electron/main.mjs");
