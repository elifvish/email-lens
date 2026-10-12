/**
 * The engine for the static, in-browser demo (GitHub Pages): same compatibility and lint
 * checks as the local app, with the caniemail dataset bundled in. No server features.
 */
import data from "../data/caniemail.json";
import { checkCompat, dataInfo, listClients, useData } from "./compat.mjs";
import { lint } from "./lint.mjs";

useData(data);

export function info() {
  return { static: true, data: dataInfo(), render: { available: false, engines: [] }, sources: [], sourceTypes: [], clients: listClients() };
}

export function analyze(html, text = null) {
  return { compat: checkCompat(html), lint: lint({ html, text }), bytes: new TextEncoder().encode(html).length };
}
