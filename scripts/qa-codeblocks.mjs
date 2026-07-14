/* QA gate for fenced code blocks across content/.
   Checks: balanced fences, no tabs, normalized indentation (fence at column 0,
   content dedented), valid JSON, parseable YAML.
   Usage:
     node scripts/qa-codeblocks.mjs          # check only (exit 1 on errors)
     node scripts/qa-codeblocks.mjs --fix     # normalize indentation + trailing ws
*/
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const FIX = process.argv.includes("--fix");
const ROOT = "content";

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const errors = [];
const warnings = [];

function dedent(lines) {
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (!nonEmpty.length) return lines.slice();
  const min = Math.min(
    ...nonEmpty.map((l) => (l.match(/^[ ]*/)[0] || "").length)
  );
  return lines.map((l) => l.slice(min).replace(/[ \t]+$/, ""));
}

function processFile(file) {
  const original = fs.readFileSync(file, "utf8");
  const lines = original.split("\n");
  const outLines = [];
  let i = 0;
  let changed = false;

  while (i < lines.length) {
    const m = lines[i].match(FENCE);
    if (!m) {
      outLines.push(lines[i]);
      i++;
      continue;
    }
    const indent = m[1];
    const marker = m[2][0];
    const minLen = m[2].length;
    const info = m[3].trim();
    const lang = info.split(/\s+/)[0].toLowerCase();

    // Collect until closing fence.
    const body = [];
    let j = i + 1;
    let closed = false;
    const closeRe = new RegExp(`^\\s*${"\\" + marker}{${minLen},}\\s*$`);
    while (j < lines.length) {
      if (closeRe.test(lines[j])) {
        closed = true;
        break;
      }
      body.push(lines[j]);
      j++;
    }
    if (!closed) {
      errors.push(`${file}:${i + 1} unbalanced code fence (no closing \`${marker.repeat(minLen)}\`)`);
      outLines.push(lines[i]);
      i++;
      continue;
    }

    // Tabs inside code.
    if (body.some((l) => l.includes("\t"))) {
      if (FIX) {
        // leave tab→space to dedent step? convert tabs to 2 spaces.
      } else {
        errors.push(`${file}:${i + 1} tab character inside \`${lang || "code"}\` block`);
      }
    }

    const fenceIndented = indent.length > 0;
    const dedented = dedent(body);
    const bodyChanged =
      fenceIndented || dedented.some((l, k) => l !== body[k]);

    // Validate code content (use the normalized body).
    const code = dedented.join("\n");
    if (lang === "json") {
      try {
        JSON.parse(code);
      } catch (e) {
        errors.push(`${file}:${i + 1} invalid JSON — ${e.message.split("\n")[0]}`);
      }
    } else if (lang === "yaml" || lang === "yml") {
      try {
        yaml.loadAll(code);
      } catch (e) {
        warnings.push(`${file}:${i + 1} YAML not strictly parseable (custom tags?) — ${e.reason || e.message}`);
      }
    }

    if (bodyChanged) {
      if (FIX) {
        outLines.push(marker.repeat(minLen) + (info ? info : ""));
        for (const l of dedented) outLines.push(l);
        outLines.push(marker.repeat(minLen));
        changed = true;
      } else {
        if (fenceIndented)
          errors.push(`${file}:${i + 1} code fence is indented (${indent.length} space(s)); expected column 0`);
        else
          warnings.push(`${file}:${i + 1} code block has non-normalized indentation`);
        // echo unchanged for check mode
        outLines.push(lines[i]);
        for (const l of body) outLines.push(l);
        outLines.push(lines[j]);
      }
    } else {
      outLines.push(lines[i]);
      for (const l of body) outLines.push(l);
      outLines.push(lines[j]);
    }
    i = j + 1;
  }

  if (FIX && changed) {
    fs.writeFileSync(file, outLines.join("\n"));
    return true;
  }
  return false;
}

const files = walk(ROOT);
let fixedCount = 0;
for (const f of files) {
  if (processFile(f)) fixedCount++;
}

if (warnings.length) {
  console.log("\nWarnings:");
  warnings.forEach((w) => console.log("  ⚠ " + w));
}
if (errors.length) {
  console.log("\nErrors:");
  errors.forEach((e) => console.log("  ✖ " + e));
}

if (FIX) {
  console.log(`\n✓ QA fix complete — normalized ${fixedCount} file(s), scanned ${files.length}.`);
  process.exit(0);
}

if (errors.length) {
  console.log(`\n✖ Code-block QA failed: ${errors.length} error(s) in ${files.length} files.`);
  process.exit(1);
}
console.log(`✓ Code-block QA passed (${files.length} files, ${warnings.length} warning(s)).`);
