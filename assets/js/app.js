/* Spatial Data Archival — progressive enhancement (no external requests). */
(function () {
  "use strict";

  const ready = (fn) =>
    document.readyState !== "loading"
      ? fn()
      : document.addEventListener("DOMContentLoaded", fn);

  const COPY_SVG =
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const CHECK_SVG =
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m5 12 5 5L20 7"/></svg>';

  /* ---- Mobile navigation -------------------------------------------- */
  function initNav() {
    const toggle = document.querySelector(".nav-toggle");
    const nav = document.querySelector(".primary-nav");
    if (!toggle || !nav) return;
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    nav.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      })
    );
  }

  /* ---- Copy-to-clipboard buttons ------------------------------------ */
  function initCopyButtons() {
    document.querySelectorAll('.prose pre[class*="language-"]').forEach((pre) => {
      const code = pre.querySelector("code");
      if (!code) return;
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.setAttribute("aria-label", "Copy code to clipboard");
      btn.innerHTML = COPY_SVG + "<span>Copy</span>";
      wrap.appendChild(btn);

      btn.addEventListener("click", async () => {
        const text = code.innerText;
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
          } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
          }
          btn.classList.add("copied");
          btn.innerHTML = CHECK_SVG + "<span>Copied</span>";
          setTimeout(() => {
            btn.classList.remove("copied");
            btn.innerHTML = COPY_SVG + "<span>Copy</span>";
          }, 1800);
        } catch (e) {
          btn.innerHTML = COPY_SVG + "<span>Press Ctrl+C</span>";
        }
      });
    });
  }

  /* ---- Task-list checkbox persistence ------------------------------- */
  function initTaskLists() {
    const boxes = document.querySelectorAll(".prose li.task-list-item input[type=checkbox]");
    if (!boxes.length) return;
    const base = "tl:" + location.pathname + ":";
    boxes.forEach((box, i) => {
      box.disabled = false;
      let saved = null;
      try {
        saved = localStorage.getItem(base + i);
      } catch (e) {}
      if (saved !== null) box.checked = saved === "1";
      box.addEventListener("change", () => {
        try {
          localStorage.setItem(base + i, box.checked ? "1" : "0");
        } catch (e) {}
      });
    });
  }

  /* ---- KaTeX (assets loaded on content pages only) ------------------ */
  function initKatex() {
    if (typeof window.renderMathInElement !== "function") return;
    const root = document.querySelector(".prose");
    if (!root) return;
    window.renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
    });
  }

  /* ---- Mermaid (lazy-loaded only when diagrams are present) --------- */
  function initMermaid() {
    if (!document.querySelector(".mermaid")) return;
    const script = document.createElement("script");
    script.src = "/assets/mermaid/mermaid.min.js";
    script.addEventListener("load", () => {
      if (!window.mermaid) return;
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        fontFamily:
          'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        theme: "base",
        themeVariables: {
          primaryColor: "#e1f3ef",
          primaryBorderColor: "#0f766e",
          primaryTextColor: "#16302c",
          lineColor: "#0f766e",
          secondaryColor: "#fef3da",
          tertiaryColor: "#def5ec",
          fontSize: "15px",
        },
      });
      window.mermaid.run({ querySelector: ".mermaid" });
    });
    document.body.appendChild(script);
  }

  /* ---- Service worker ----------------------------------------------- */
  function initServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  ready(() => {
    initNav();
    initCopyButtons();
    initTaskLists();
    initKatex();
    initMermaid();
    initServiceWorker();
  });
})();
