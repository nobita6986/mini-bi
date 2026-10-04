/**
 * P1.6-I04C3-R3A - Module hooks cho harness SSR.
 *
 * - `.css` (CSS module) -> module tong hop tra ve chinh ten class, khop voi class tho trong
 *   file .module.css duoc nhung vao trang.
 * - `@/*` -> thu muc build (<R3A_SSR_ROOT>), noi tsc da emit `lib/**` va `components/**`.
 * - Import khong co duoi (tsc giu nguyen vi repo dung moduleResolution "bundler") -> them `.js`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CSS_SCHEME = "r3a-css:";

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (existsSync(fileURLToPath(candidate))) return candidate;
    } catch { /* not a file URL */ }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".css")) {
    return { url: CSS_SCHEME + specifier, format: "module", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const root = process.env.R3A_SSR_ROOT;
    if (!root) throw new Error("R3A_SSR_ROOT is not set");
    const base = pathToFileURL(path.join(root, specifier.slice(2)));
    if (path.extname(specifier) !== "") return nextResolve(base.href, context);
    const resolved = firstExisting([base.href + ".js", base.href + "/index.js", base.href]);
    return nextResolve(resolved ?? base.href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) &&
      path.extname(specifier) === "") {
    const base = new URL(specifier, context.parentURL);
    const resolved = firstExisting([base.href + ".js", base.href + "/index.js", base.href]);
    return nextResolve(resolved ?? base.href, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(CSS_SCHEME)) {
    return {
      format: "module",
      shortCircuit: true,
      source: [
        "const handler = { get: (target, key) => (typeof key === 'string' ? key : undefined) };",
        "export default new Proxy({}, handler);",
      ].join("\n"),
    };
  }
  return nextLoad(url, context);
}
