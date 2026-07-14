import syntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import markdownItAnchor from "markdown-it-anchor";
import markdownItTaskLists from "markdown-it-task-lists";

// ---------------------------------------------------------------------------
// Inline SVG icon set (no external requests). 24x24, currentColor strokes.
// ---------------------------------------------------------------------------
const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v9.5h5v-5h4v5h5V10" />',
  compression:
    '<rect x="4" y="4" width="16" height="4.5" rx="1.2"/><rect x="4" y="9.75" width="16" height="4.5" rx="1.2"/><rect x="4" y="15.5" width="16" height="4.5" rx="1.2"/><path d="M9 6.25h2M9 12h2M9 17.75h2"/>',
  architecture:
    '<path d="M12 3 4 7l8 4 8-4-8-4Z"/><path d="m4 12 8 4 8-4"/><path d="m4 17 8 4 8-4"/>',
  conversion:
    '<path d="M4 8h11"/><path d="m12 5 3 3-3 3"/><path d="M20 16H9"/><path d="m12 13-3 3 3 3"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  database:
    '<ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/><path d="M5 11.5v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/>',
  shield:
    '<path d="M12 3 5 6v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.4 3.9 5.6 4 9-.1 3.4-1.5 6.6-4 9-2.5-2.4-3.9-5.6-4-9 .1-3.4 1.5-6.6 4-9Z"/>',
};

const svgIcon = (name, cls = "") =>
  `<svg class="icon${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" ` +
  `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ""}</svg>`;

// ---------------------------------------------------------------------------
// URL helpers for breadcrumbs / related navigation.
// ---------------------------------------------------------------------------
const normalize = (u) => (u.endsWith("/") ? u : u + "/");
const parentUrl = (u) => {
  const parts = normalize(u).replace(/\/$/, "").split("/");
  parts.pop();
  const joined = parts.join("/");
  return joined === "" ? "/" : joined + "/";
};
const ancestorUrls = (u) => {
  const out = [];
  let cur = normalize(u);
  while (cur !== "/") {
    out.unshift(cur);
    cur = parentUrl(cur);
  }
  return out;
};
const titleFor = (url, collection) => {
  if (url === "/") return "Home";
  const hit = collection.find((i) => normalize(i.url) === normalize(url));
  return hit ? hit.data.title : url;
};

export default function (eleventyConfig) {
  // ---- Passthrough copy ---------------------------------------------------
  eleventyConfig.addPassthroughCopy({ "assets/css": "assets/css" });
  eleventyConfig.addPassthroughCopy({ "assets/js": "assets/js" });
  eleventyConfig.addPassthroughCopy({ "assets/img": "assets/img" });
  eleventyConfig.addPassthroughCopy({ "assets/icons": "assets/icons" });
  eleventyConfig.addPassthroughCopy({ "src/sw.js": "sw.js" });
  eleventyConfig.addPassthroughCopy({ "src/10f650467017194745e8c81ecfa51d2f.txt": "10f650467017194745e8c81ecfa51d2f.txt" });

  // Vendored libraries (kept local — the site links to no external hosts).
  eleventyConfig.addPassthroughCopy({
    "node_modules/katex/dist/katex.min.css": "assets/katex/katex.min.css",
    "node_modules/katex/dist/katex.min.js": "assets/katex/katex.min.js",
    "node_modules/katex/dist/contrib/auto-render.min.js":
      "assets/katex/auto-render.min.js",
    "node_modules/katex/dist/fonts": "assets/katex/fonts",
    "node_modules/mermaid/dist/mermaid.min.js": "assets/mermaid/mermaid.min.js",
  });

  // ---- Watch targets ------------------------------------------------------
  eleventyConfig.addWatchTarget("assets/");

  // ---- Syntax highlighting (build-time Prism, light theme via CSS) --------
  eleventyConfig.addPlugin(syntaxHighlight);

  // ---- markdown-it customisation -----------------------------------------
  eleventyConfig.amendLibrary("md", (md) => {
    md.set({ html: true, linkify: false, typographer: true });

    md.use(markdownItAnchor, {
      level: [2, 3, 4],
      tabIndex: false,
      permalink: markdownItAnchor.permalink.linkInsideHeader({
        symbol: "#",
        class: "heading-anchor",
        placement: "after",
        ariaHidden: true,
        // aria-hidden anchors must not be focusable (WCAG aria-hidden-focus)
        renderAttrs: () => ({ tabindex: "-1" }),
      }),
      slugify: (s) =>
        s
          .trim()
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-"),
    });

    md.use(markdownItTaskLists, { enabled: true, label: true, lineNumber: false });

    // Wrap tables so they scroll horizontally on small screens.
    const defaultTableOpen =
      md.renderer.rules.table_open ||
      ((t, i, o, e, s) => s.renderToken(t, i, o));
    md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
      '<div class="table-wrap">' + defaultTableOpen(tokens, idx, options, env, self);
    const defaultTableClose =
      md.renderer.rules.table_close ||
      ((t, i, o, e, s) => s.renderToken(t, i, o));
    md.renderer.rules.table_close = (tokens, idx, options, env, self) =>
      defaultTableClose(tokens, idx, options, env, self) + "</div>";

    // Mermaid fences bypass Prism and render client-side.
    const defaultFence = md.renderer.rules.fence.bind(md.renderer);
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const info = token.info ? md.utils.unescapeAll(token.info).trim() : "";
      const lang = info.split(/\s+/g)[0];
      if (lang === "mermaid") {
        return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
      }
      return defaultFence(tokens, idx, options, env, self);
    };
  });

  // ---- Collections --------------------------------------------------------
  eleventyConfig.addCollection("contentPage", (api) =>
    api
      .getFilteredByTag("contentPage")
      .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  );

  // ---- Filters: navigation ------------------------------------------------
  eleventyConfig.addFilter("breadcrumbs", function (url, collection) {
    const crumbs = [{ title: "Home", url: "/" }];
    for (const a of ancestorUrls(url)) {
      crumbs.push({ title: titleFor(a, collection), url: a });
    }
    return crumbs;
  });

  eleventyConfig.addFilter("childrenOf", function (url, collection) {
    const target = normalize(url);
    return collection
      .filter((i) => parentUrl(i.url) === target)
      .map((i) => ({ title: i.data.title, url: i.url, summary: i.data.summary }));
  });

  eleventyConfig.addFilter("siblingsOf", function (url, collection) {
    const me = normalize(url);
    const parent = parentUrl(url);
    return collection
      .filter((i) => parentUrl(i.url) === parent && normalize(i.url) !== me)
      .map((i) => ({ title: i.data.title, url: i.url }));
  });

  // ---- Filters: misc ------------------------------------------------------
  eleventyConfig.addFilter("absoluteUrl", (path, base) => {
    try {
      return new URL(path, base).toString();
    } catch {
      return path;
    }
  });
  eleventyConfig.addFilter("isoDate", (d) => new Date(d).toISOString());
  eleventyConfig.addFilter("year", () => new Date().getFullYear());

  // ---- Shortcodes ---------------------------------------------------------
  eleventyConfig.addShortcode("icon", (name, cls = "") => svgIcon(name, cls));

  // ---- FAQ accordion transform (activates only when an FAQ heading exists)-
  eleventyConfig.addTransform("faqAccordions", function (content) {
    if (!(this.page.outputPath || "").endsWith(".html")) return content;
    if (!/<h2[^>]*>\s*(?:<a[^>]*>#<\/a>\s*)?(?:frequently asked questions|faq)\b/i.test(content))
      return content;

    return content.replace(
      /<h2[^>]*>(?:\s*<a[^>]*>#<\/a>)?\s*(?:frequently asked questions|faq)[^<]*(?:<a[^>]*>#<\/a>)?\s*<\/h2>([\s\S]*?)(?=<h2|$)/i,
      (whole, body) => {
        const items = [];
        const re = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3|$)/gi;
        let m;
        while ((m = re.exec(body)) !== null) {
          const q = m[1].replace(/<a[^>]*>#<\/a>/gi, "").trim();
          items.push(
            `<details class="faq-item"><summary>${q}</summary>` +
              `<div class="faq-answer">${m[2].trim()}</div></details>`
          );
        }
        if (!items.length) return whole;
        return (
          '<h2 class="faq-heading">Frequently Asked Questions</h2>' +
          `<div class="faq-accordion">${items.join("")}</div>`
        );
      }
    );
  });

  // ---- Config -------------------------------------------------------------
  eleventyConfig.setTemplateFormats(["njk", "md"]);

  return {
    templateFormats: ["njk", "md"],
    markdownTemplateEngine: false, // content is plain markdown, no templating
    htmlTemplateEngine: "njk",
    dir: {
      input: ".",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
  };
}
