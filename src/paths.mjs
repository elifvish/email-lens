import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_FILE = join(ROOT, "data", "caniemail.json");
export const PUBLIC_DIR = join(ROOT, "public");
