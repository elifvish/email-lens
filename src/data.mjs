/** Refresh the bundled caniemail.com dataset. */
import { renameSync, writeFileSync } from "node:fs";
import { dataInfo, loadData } from "./compat.mjs";
import { DATA_FILE } from "./paths.mjs";

const SOURCE = "https://www.caniemail.com/api/data.json";

export async function updateData() {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`caniemail.com: HTTP ${res.status}`);
  const text = await res.text();
  const json = JSON.parse(text);
  if (!Array.isArray(json.data) || json.data.length < 100 || !json.nicenames) throw new Error("caniemail.com returned unexpected data; kept the current copy");
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, DATA_FILE);
  loadData();
  return dataInfo();
}
