import fs from "node:fs";

const stripMarkdown = (s) =>
  s
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // inline code
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // bold / italic
    .replace(/\s+/g, " ")
    .trim();

const readSource = (inputPath) => {
  try {
    return fs.readFileSync(inputPath, "utf8");
  } catch {
    return "";
  }
};

const firstParagraph = (raw, titleLine) => {
  let body = raw;
  if (titleLine) {
    const i = raw.indexOf(titleLine);
    if (i !== -1) body = raw.slice(i + titleLine.length);
  }
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t) continue;
    if (/^(#|`{3}|[-*]\s|\||\d+\.\s|>)/.test(t)) continue;
    return stripMarkdown(t);
  }
  return "";
};

const truncate = (s, n) =>
  s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";

// Shorten a title so that "seoTitle · Spatial Data Archival" stays ≤ 65 chars
// in raw HTML (where & → &amp; adds 4 extra chars each).
// Suffix " · Spatial Data Archival" = 24 chars; allow up to 1 entity → 37.
const SEO_TITLE_MAX = 37;
const makeSeoTitle = (title) => {
  if (title.length <= SEO_TITLE_MAX) return title;
  // First try stripping everything after a colon or em-dash
  const shortened = title.split(/:\s+|—\s+/)[0].trim();
  if (shortened.length <= SEO_TITLE_MAX && shortened.length >= 15)
    return shortened;
  return truncate(title, SEO_TITLE_MAX);
};

export default {
  layout: "layouts/page.njk",
  tags: ["contentPage"],
  eleventyComputed: {
    // Strip the leading /content segment so URLs match the in-content links.
    permalink: (data) => {
      const stem = data.page.filePathStem
        .replace(/^\/content/, "")
        .replace(/\/index$/, "");
      return `${stem || ""}/index.html`;
    },
    title: (data) => {
      const raw = readSource(data.page.inputPath);
      const m = raw.match(/^#\s+(.+?)\s*$/m);
      return m ? m[1].trim() : data.page.fileSlug;
    },
    seoTitle: (data) => {
      const raw = readSource(data.page.inputPath);
      const m = raw.match(/^#\s+(.+?)\s*$/m);
      const fullTitle = m ? m[1].trim() : data.page.fileSlug;
      return makeSeoTitle(fullTitle);
    },
    summary: (data) => {
      const raw = readSource(data.page.inputPath);
      const m = raw.match(/^#\s+.+$/m);
      return truncate(firstParagraph(raw, m ? m[0] : ""), 180);
    },
    metaDescription: (data) => {
      const raw = readSource(data.page.inputPath);
      const m = raw.match(/^#\s+.+$/m);
      return truncate(firstParagraph(raw, m ? m[0] : ""), 155);
    },
  },
};
