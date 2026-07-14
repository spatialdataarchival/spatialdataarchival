// Content-hash first-party CSS/JS so cache-busting query strings change
// whenever a source file changes. Fixes stale styling after deploys with the
// service worker in play. 10-char sha1 slice per file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// First-party assets keyed by a stable name used in templates.
// `imports` lists @import partials whose contents fold into the parent hash.
const FILES = {
  stylesCss: { path: "assets/css/styles.css", imports: [] },
  prismLightCss: { path: "assets/css/prism-light.css", imports: [] },
  appJs: { path: "assets/js/app.js", imports: [] },
};

const hashOf = (relPaths) => {
  const hash = createHash("sha1");
  for (const rel of relPaths) {
    hash.update(readFileSync(join(root, rel)));
  }
  return hash.digest("hex").slice(0, 10);
};

const out = {};
for (const [key, { path, imports }] of Object.entries(FILES)) {
  out[key] = hashOf([path, ...imports]);
}

export default out;
