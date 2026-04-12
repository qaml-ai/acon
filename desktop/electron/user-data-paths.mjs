import { homedir } from "node:os";
import { join } from "node:path";

export const DESKTOP_DEV_USER_DATA_DIR_NAME = "camelAI Container";

export function resolveDesktopDevUserDataDir() {
  return join(
    homedir(),
    "Library/Application Support",
    DESKTOP_DEV_USER_DATA_DIR_NAME,
  );
}
