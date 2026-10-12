/** Load and refresh the bundled caniemail.com dataset (Node only). Importing this loads it. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dataInfo, useData } from "./compat.mjs";
import { DATA_FILE } from "./paths.mjs";

const SOURCE = "https://www.caniemail.com/api/data.json";

export function loadDataFile(file = DATA_FILE) {
  return useData(JSON.parse(readFileSync(file, "utf8")));
}
loadDataFile();

export async function updateData() {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`caniemail.com: HTTP ${res.status}`);
  const text = await res.text();
  const json = JSON.parse(text);
  if (!Array.isArray(json.data) || json.data.length < 100 || !json.nicenames) throw new Error("caniemail.com returned unexpected data; kept the current copy");
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, DATA_FILE);
  loadDataFile();
  return dataInfo();
}
