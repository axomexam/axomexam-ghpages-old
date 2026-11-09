#!/usr/bin/env node
"use strict";

/* ============================================================
   axomexam — tools/build-dhs-dme.js

   Builds the three DHS & DME exam books from
   tools/dhs-dme.structure.js:

     dhs-dme            Non-Technical Grade III  (5 × 100)
     dhs-dme-technical  Technical Grade III      (5 × 100)
     dhs-dme-grade-4    Grade IV                  (5 × 50)

   For each book it writes, idempotently:
     data/exams/<id>.json
     data/exams/<id>/syllabus.json
     data/exams/<id>/<section>.json
     data/exams/<id>/<section>/<topic>/index.json
     data/exams/<id>/<section>/<topic>/question-001.json
     exams/<id>/index.html
     exams/<id>/<section>/index.html
     exams/<id>/<section>/<topic>/index.html

   Question banks are drawn from the shared subject banks under
   data/mock-test/. Each exam takes a *different* slice of every
   shared pool, so the three books never repeat a question. The
   registration block in data/exams/index.json is spliced in place.

   Usage:
     node tools/build-dhs-dme.js
     node tools/build-dhs-dme.js --dry-run
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { sourcesLine, applySourcesLineExamAware } = require("./lib/editorial-sources");

const ROOT = path.resolve(__dirname, "..");
const DRY = process.argv.includes("--dry-run");
const { EXAMS } = require("./dhs-dme.structure.js");

const BASE = "https://axomexam.in";
const GRADE4 = path.join(ROOT, "exams", "adre-grade-4");
const DATE = "2026-11-08";

/* Per-topic slice size taken from a shared pool. Science pools are used by
   only one book, so they can afford a bigger slice. */
const CAP = 80;
const CAP_SCIENCE = 140;

let written = 0;
let skipped = 0;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function lang(obj, key) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  return obj[key] || obj.en || "";
}

function write(rel, content) {
  const abs = path.join(ROOT, rel);
  const next = content.endsWith("\n") ? content : content + "\n";
  let prev = null;
  try { prev = fs.readFileSync(abs, "utf8"); } catch (e) {}
  if (prev === next) { skipped++; return; }
  if (!DRY) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next, "utf8");
  }
  written++;
}

function writeJSON(rel, obj) {
  write(rel, JSON.stringify(obj, null, 2));
}

/* ---------------- shared pool reader ---------------- */

const POOL_CACHE = new Map();
function readPool(src) {
  if (POOL_CACHE.has(src)) return POOL_CACHE.get(src);
  const dir = path.join(ROOT, "data", "mock-test", ...src.split("/"));
  const seen = new Set();
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort(); } catch (e) { files = []; }
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { continue; }
    const qs = Array.isArray(data) ? data : (data && Array.isArray(data.questions) ? data.questions : []);
    for (const q of qs) {
      if (!q || typeof q !== "object" || !q.q || !Array.isArray(q.options)) continue;
      const key = (q.q.en || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
  }
  POOL_CACHE.set(src, out);
  return out;
}

/* Cursor per shared pool, advanced book by book, so two books drawing on the
   same pool receive disjoint slices. */
const POOL_CURSOR = new Map();

/* Question texts already published by another exam book, plus every text this
   run has used. A question that is already live elsewhere is skipped, so the
   three DHS & DME books never repeat a question from each other or from the
   existing books. */
const USED_TEXT = new Set();
(function seedUsed() {
  for (const book of ["assam-police", "adre-grade-3", "adre-grade-4"]) {
    const dir = path.join(ROOT, "data", "exams", book);
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!/^question-\d+\.json$/i.test(e.name)) continue;
        let data;
        try { data = JSON.parse(fs.readFileSync(full, "utf8")); } catch (e) { continue; }
        const arr = Array.isArray(data) ? data : (data && Array.isArray(data.questions) ? data.questions : []);
        for (const q of arr) {
          const t = q && q.q && q.q.en ? String(q.q.en).trim() : "";
          if (t) USED_TEXT.add(t);
        }
      }
    }
  }
})();

function buildBank(src, subId) {
  const pool = readPool(src);
  const cap = src.startsWith("science/") ? CAP_SCIENCE : CAP;
  const start = POOL_CURSOR.get(src) || 0;
  const picked = [];
  let i = start;
  while (i < pool.length && picked.length < cap) {
    const q = pool[i++];
    const key = (q.q.en || "").trim();
    if (!key || USED_TEXT.has(key)) continue;
    USED_TEXT.add(key);
    picked.push(q);
  }
  POOL_CURSOR.set(src, i);
  return picked.map((q, n) => {
    const out = {
      id: `${subId}-${String(n + 1).padStart(3, "0")}`,
      q: { en: q.q.en || "", as: q.q.as || "" },
      options: q.options.map((o) => ({ en: (o && o.en) || "", as: (o && o.as) || "" })),
      correct: Number.isInteger(q.correct) ? q.correct : 0,
    };
    if (q.explanation) out.explanation = { en: q.explanation.en || "", as: q.explanation.as || "" };
    return out;
  });
}

/* ---------------- chrome reuse ---------------- */
function chrome() {
  const leaf = fs.readFileSync(
    path.join(GRADE4, "elementary-mathematics", "number-system", "index.html"),
    "utf8"
  );
  const headEnd = leaf.indexOf("</head>") + "</head>".length;
  const bodyStart = leaf.indexOf("<body>");
  const footerStart = leaf.indexOf("<!-- ===== Footer ===== -->");
  const guard = leaf.indexOf('<script data-axo-guard="1">');
  return {
    head: leaf.slice(0, headEnd),
    bodyOpenToMain: leaf.slice(bodyStart, leaf.indexOf('<main id="app"')),
    footer: leaf.slice(footerStart),
    guardScript: guard >= 0 ? leaf.slice(guard, leaf.indexOf("</script>", guard) + 9) : "",
  };
}
const CHROME = chrome();

function pageHead(opts) {
  let head = CHROME.head;
  const set = (re, val) => { head = head.replace(re, val); };
  /* The chrome leaf is borrowed from another book, so drop its hreflang trio:
     build-as-twins.js writes the correct pair for this page afterwards. */
  head = head.replace(/[ \t]*<link rel="alternate" hreflang="[^"]*" href="[^"]*" \/>\n?/g, "");
  set(/<title>[\s\S]*?<\/title>/, `<title>${esc(opts.title)}</title>`);
  set(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(opts.desc)}" />`);
  set(/<meta name="theme-color"[^>]*>/, `<meta name="theme-color" content="${opts.themeColor}" />`);
  set(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${opts.canonical}" />`);
  set(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(opts.title)}" />`);
  set(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(opts.desc)}" />`);
  set(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${opts.canonical}" />`);
  set(/<meta property="og:image:alt"[^>]*>/, `<meta property="og:image:alt" content="${esc(opts.imageAlt)}" />`);
  set(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${esc(opts.title)}" />`);
  set(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${esc(opts.desc)}" />`);
  set(/<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${BASE}${opts.cover}" />`);
  set(/<meta name="twitter:image" content="[^"]*" \/>/, `<meta name="twitter:image" content="${BASE}${opts.cover}" />`);
  const ldStart = head.indexOf('<script type="application/ld+json">');
  if (ldStart >= 0) {
    const ldEnd = head.indexOf("</script>", ldStart) + "</script>".length;
    head = head.slice(0, ldStart) + opts.jsonld + head.slice(ldEnd);
  }
  return head;
}

function jsonld(opts) {
  const graph = [
    {
      "@type": "WebPage",
      "@id": opts.canonical + "#webpage",
      url: opts.canonical,
      name: opts.title,
      inLanguage: ["en", "as"],
      isPartOf: { "@id": BASE + "/#website" },
      publisher: { "@id": BASE + "/#organization" },
      description: opts.desc,
      primaryImageOfPage: { "@type": "ImageObject", url: BASE + opts.cover },
      breadcrumb: { "@id": opts.canonical + "#breadcrumb" },
      datePublished: DATE,
      dateModified: DATE,
      isAccessibleForFree: true,
      speakable: { "@type": "SpeakableSpecification", cssSelector: ["h1", ".page-desc"] },
    },
  ];
  if (opts.teaches) {
    graph.push({
      "@type": "LearningResource",
      "@id": opts.canonical + "#learningresource",
      name: opts.title,
      description: opts.desc,
      learningResourceType: "Exam question bank",
      educationalLevel: "Competitive exams",
      teaches: opts.teaches,
      about: { "@type": "Thing", name: opts.teaches },
      inLanguage: ["en", "as"],
      isPartOf: { "@id": BASE + "/#website" },
      publisher: { "@id": BASE + "/#organization" },
      datePublished: DATE,
      dateModified: DATE,
      isAccessibleForFree: true,
      author: { "@id": BASE + "/#organization" },
    });
  }
  graph.push({
    "@type": "BreadcrumbList",
    "@id": opts.canonical + "#breadcrumb",
    itemListElement: opts.crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      ...(c.url ? { item: c.url } : {}),
    })),
  });
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph })}</script>`;
}

function breadcrumbHTML(crumbs) {
  const items = crumbs.map((c, i) =>
    i === crumbs.length - 1 ? `<span>${esc(c.name)}</span>` : `<a href="${c.url}">${esc(c.name)}</a>`
  );
  return `<nav class="breadcrumb">${items.join('<span class="bc-sep">/</span>')}</nav>`;
}

/* ---------------- question rendering ---------------- */
function normalize(q) {
  const options = Array.isArray(q.options) ? q.options.map((o) => ({ en: lang(o, "en"), as: lang(o, "as") })) : [];
  const correct = Number.isInteger(q.correct) ? q.correct : -1;
  let aEn = "";
  let aAs = "";
  if (correct >= 0 && options[correct]) {
    const letter = String.fromCharCode(65 + correct);
    aEn = options[correct].en ? `${letter}) ${options[correct].en}` : `${letter})`;
    aAs = options[correct].as ? `${letter}) ${options[correct].as}` : "";
  }
  return {
    q: { en: lang(q.q, "en"), as: lang(q.q, "as") },
    options,
    a: { en: aEn, as: aAs },
    ex: { en: lang(q.explanation, "en"), as: lang(q.explanation, "as") },
  };
}

function optionsHTML(q) {
  if (!q.options.length) return "";
  const opts = q.options
    .map((o, i) =>
      `<div lang="en" style="margin:2px 0;">(${String.fromCharCode(65 + i)}) ${esc(o.en)}${
        o.as && o.as !== o.en ? ` <span lang="as" style="color:#64748b;">${esc(o.as)}</span>` : ""
      }</div>`
    )
    .join("");
  return `<div style="margin-top:8px; color:#334155;">${opts}</div>`;
}

function qaItemHTML(q, n) {
  const parts = [
    `<div lang="en" style="font-weight:800; font-size:1.02rem; line-height:1.5; margin-bottom:6px;">Q${n}. ${esc(q.q.en)}</div>`,
  ];
  if (q.q.as) parts.push(`<div lang="as" style="color:#64748b; font-size:0.9rem; line-height:1.6; margin-bottom:8px;">${esc(q.q.as)}</div>`);
  const opts = optionsHTML(q);
  if (opts) parts.push(opts);
  if (q.a.en) parts.push(`<div lang="en" style="margin-top:8px;"><strong>Answer:</strong> <span>${esc(q.a.en)}</span></div>`);
  if (q.a.as && q.a.as !== q.a.en) parts.push(`<div lang="as" style="color:#64748b; font-size:0.9rem;">${esc(q.a.as)}</div>`);
  if (q.ex.en) parts.push(`<div lang="en" style="margin-top:6px; font-size:0.9rem; color:#64748b;"><strong>Explanation:</strong> ${esc(q.ex.en)}</div>`);
  if (q.ex.as) parts.push(`<div lang="as" style="font-size:0.9rem; color:#64748b;">${esc(q.ex.as)}</div>`);
  return `<div class="qa-item" style="margin-bottom:22px;">${parts.join("")}</div>`;
}

/* ---------------- page shell ---------------- */
function pageShell(opts) {
  const guard = CHROME.guardScript ? `\n  ${CHROME.guardScript}` : "";
  return `<!DOCTYPE html>
<html lang="en">
${opts.head}
${CHROME.bodyOpenToMain}<main id="app" class="container main">
${opts.mainHTML}
  </main>
${opts.extraHTML || ""}
${CHROME.footer}${guard}`;
}

function editorialBlock(EXAM, labelObj, subject) {
  const examEn = lang(EXAM.title, "en");
  const labelEn = lang(labelObj, "en") || "Complete syllabus and topic-wise practice";
  const labelAs = lang(labelObj, "as") || "সম্পূৰ্ণ পাঠ্যক্ৰম আৰু বিষয়ভিত্তিক অনুশীলন";
  return applySourcesLineExamAware(`  <section class="section" data-axo-editorial-credit="1" style="padding-top:2px; padding-bottom:22px;">
          <div lang="en" data-axo-lang="en" class="info-panel" style="max-width:900px; margin:0 auto; background:var(--bg,#ffffff); border:1px solid var(--border,#e2e8f0); border-radius:16px; padding:20px 22px; line-height:1.8; color:var(--ink-soft,#475569); text-align:left;">
            <p style="margin:0 0 12px;">${esc(labelEn)} for the ${esc(examEn)} examination. The questions and explanations follow the patterns used in recent Assam recruitment papers, and each topic is written so that the method can be reproduced in the examination hall.</p>
            <div class="editorial-meta"><span class="editorial-meta-item"><strong>Author:</strong> <a href="/editorial-team/#axomexam-team">axomexam team</a></span><span class="editorial-meta-item"><strong>Reviewed by:</strong> <a href="/editorial-team/">Axomexam Editorial Team</a></span><span class="editorial-meta-item"><strong>Sources:</strong> ${sourcesLine(subject)}</span><span class="editorial-meta-item"><strong>Published:</strong> 8 November 2026</span><span class="editorial-meta-item"><strong>Last updated:</strong> 8 November 2026</span><span class="editorial-meta-item"><a href="/editorial-policy/">How we review</a></span></div>
          </div>
<div lang="as" data-axo-lang="as" class="info-panel" style="max-width:900px; margin:0 auto; background:var(--bg,#ffffff); border:1px solid var(--border,#e2e8f0); border-radius:16px; padding:20px 22px; line-height:1.8; color:var(--ink-soft,#475569); text-align:left;">
<p style="margin:0 0 12px;">${esc(examEn)} পৰীক্ষাৰ ${esc(labelAs)}। প্ৰশ্ন আৰু ব্যাখ্যাবোৰ শেহতীয়া অসম নিয়োগ পত্ৰত ব্যৱহৃত আৰ্হি অনুসৰি প্ৰস্তুত, আৰু প্ৰতিটো অধ্যায় এনে ধৰণে লিখা হৈছে যাতে পৰীক্ষা কক্ষত পদ্ধতিটো পুনৰ উলিয়াব পাৰি।</p>
<div class="editorial-meta"><span class="editorial-meta-item"><strong>লেখক:</strong> <a href="/editorial-team/#axomexam-team">axomexam টীম</a></span><span class="editorial-meta-item"><strong>পৰ্যালোচনা:</strong> <a href="/editorial-team/">Axomexam Editorial Team</a></span><span class="editorial-meta-item"><strong>প্ৰসংগ উৎস:</strong> মানক প্ৰসংগ পুথি আৰু বিশ্বাসযোগ্য অনলাইন উৎস</span><span class="editorial-meta-item"><strong>প্ৰকাশিত:</strong> 8 নৱেম্বৰ 2026</span><span class="editorial-meta-item"><strong>শেহতীয়া আপডেট:</strong> 8 নৱেম্বৰ 2026</span></div>
</div>
        </section>`, `exams/${EXAM.id}/${subject}`);
}

/* JSON in the style of data/exams/index.json. */
function compactJSON(value, indent) {
  const pad = " ".repeat(indent);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const items = value.map((v) => pad + "  " + compactJSON(v, indent + 2));
    return "[\n" + items.join(",\n") + "\n" + pad + "]";
  }
  const keys = Object.keys(value);
  const inline = keys.every((k) => {
    const v = value[k];
    return v === null || typeof v !== "object";
  });
  const oneLine = "{" + keys.map((k) => ` ${JSON.stringify(k)}: ${JSON.stringify(value[k])}`).join(",") + " }";
  if (inline && oneLine.length + indent <= 150) return oneLine;
  const lines = keys.map((k) => pad + "  " + JSON.stringify(k) + ": " + compactJSON(value[k], indent + 2));
  return "{\n" + lines.join(",\n") + "\n" + pad + "}";
}

/* ---------------- build one book ---------------- */
function buildBook(EXAM) {
  const examPath = `/exams/${EXAM.id}`;
  const examCanonical = `${BASE}${examPath}/`;
  const crumbsRoot = [
    { name: "Home", url: BASE + "/" },
    { name: "Your Exams", url: BASE + "/exams/" },
  ];

  writeJSON(`data/exams/${EXAM.id}.json`, examEntry(EXAM));
  writeJSON(`data/exams/${EXAM.id}/syllabus.json`, { id: "syllabus", type: "syllabus", ...EXAM.syllabus });

  const leaves = [];
  for (const sec of EXAM.sections) {
    if (sec.type === "syllabus") continue;
    writeJSON(`data/exams/${EXAM.id}/${sec.id}.json`, {
      id: sec.id,
      type: "qa",
      title: sec.title,
      subject: sec.title,
      description: {
        en: `Topic-wise question bank for the ${lang(EXAM.title, "en")} examination - ${lang(sec.title, "en")}.`,
        as: `${lang(EXAM.title, "as")} পৰীক্ষাৰ ${lang(sec.title, "as")}ৰ বিষয়-ভিত্তিক প্ৰশ্ন-বেংক।`,
      },
      questions: [],
    });
    for (const sub of sec.subcategories || []) {
      const children = Array.isArray(sub.subcategories) ? sub.subcategories : [];
      if (children.length) {
        writeJSON(`data/exams/${EXAM.id}/${sec.id}/${sub.id}/index.json`, { subcategory: sub.id, files: [] });
        for (const leaf of children) leaves.push({ sec, group: sub, leaf });
      } else {
        leaves.push({ sec, group: null, leaf: sub });
      }
    }
  }

  for (const item of leaves) {
    const parts = [item.sec.id, ...(item.group ? [item.group.id] : []), item.leaf.id];
    const rel = ["data", "exams", EXAM.id, ...parts].join("/");
    const bank = BANKS[`${EXAM.id}:${item.leaf.id}`] || [];
    writeJSON(`${rel}/question-001.json`, bank);
    writeJSON(`${rel}/index.json`, { subcategory: item.leaf.id, files: ["question-001.json"] });
  }

  /* hub page */
  {
    const title = `${lang(EXAM.title, "en")} Exam Book | axomexam`;
    const desc = `${lang(EXAM.title, "en")} exam book - complete syllabus and topic-wise practice for ${EXAM.sections
      .filter((s) => s.type !== "syllabus").map((s) => lang(s.title, "en")).join(", ")}.`;
    const crumbs = [...crumbsRoot, { name: lang(EXAM.title, "en") }];
    const head = pageHead({
      title, desc, canonical: examCanonical, themeColor: EXAM.color,
      imageAlt: `axomexam - ${lang(EXAM.title, "en")} Exam Book`,
      cover: EXAM.cover,
      jsonld: jsonld({ canonical: examCanonical, title, desc, crumbs, cover: EXAM.cover }),
    });
    const cards = EXAM.sections.map((s) => `        <a class="sub-card reveal" data-exam-subcats href="${examPath}/${s.id}/" style="display:block; margin:10px 0; padding:14px 16px; border:1px solid var(--border,#e2e8f0); border-radius:14px; text-decoration:none;"><b style="color:var(--ink,#0f172a);">${esc(lang(s.title, "en"))}</b><span style="display:block; color:var(--ink-muted,#64748b); font-size:0.86rem;">${esc(lang(s.title, "as"))}</span></a>`).join("\n");
    const bookTotal = leaves.reduce((a, l) => a + (BANK_COUNT[`${EXAM.id}:${l.leaf.id}`] || 0), 0);
    const bookTotalLabel = `${bookTotal.toLocaleString("en-IN")} questions available in this book &bull; ${bookTotal.toLocaleString("en-IN")} টা প্ৰশ্ন এই পুথিত উপলব্ধ`;
    const mainHTML = `    <div class="page-head">
      ${breadcrumbHTML(crumbs)}
      <h1>${esc(lang(EXAM.title, "en"))}</h1>
      <p class="page-desc">${esc(lang(EXAM.subtitle, "as"))} &bull; ${esc(lang(EXAM.title, "as"))}</p>
      <p class="exam-book-total">${bookTotalLabel}</p>
    </div>

    <section class="section" data-exam-subcats style="padding-bottom:40px;">
      <h2 style="margin:0 0 6px;">Subjects</h2>
      <div class="sub-grid">
${cards}
      </div>
    </section>`;
    write(`exams/${EXAM.id}/index.html`, pageShell({ head, mainHTML, extraHTML: editorialBlock(EXAM, { en: "Complete syllabus and topic-wise practice", as: "সম্পূৰ্ণ পাঠ্যক্ৰম আৰু বিষয়ভিত্তিক অনুশীলন" }, "gk") + "\n" }));
  }

  /* section pages */
  for (const sec of EXAM.sections) {
    if (sec.type === "syllabus") continue;
    const subs = (sec.subcategories || []).flatMap((sub) =>
      Array.isArray(sub.subcategories) && sub.subcategories.length
        ? sub.subcategories.map((c) => ({ parent: sub, leaf: c }))
        : [{ parent: null, leaf: sub }]
    );
    const canonical = `${BASE}${examPath}/${sec.id}/`;
    const title = `${lang(sec.title, "en")} - ${lang(EXAM.title, "en")} Exam Book | axomexam`;
    const desc = `${lang(EXAM.title, "en")} ${lang(sec.title, "en")} - read the complete book online in English and Assamese.`;
    const crumbs = [...crumbsRoot, { name: lang(EXAM.title, "en"), url: examCanonical }, { name: lang(sec.title, "en") }];
    const head = pageHead({
      title, desc, canonical, themeColor: sec.color,
      imageAlt: `axomexam - ${lang(sec.title, "en")}`, cover: EXAM.cover,
      jsonld: jsonld({ canonical, title, desc, crumbs, cover: EXAM.cover }),
    });
    const cards = subs.map((s) => {
      const href = `${examPath}/${sec.id}/${s.parent ? s.parent.id + "/" : ""}${s.leaf.id}/`;
      return `        <a class="sub-card reveal" data-exam-subcats href="${href}" style="display:block; margin:10px 0; padding:14px 16px; border:1px solid var(--border,#e2e8f0); border-radius:14px; text-decoration:none;"><b style="color:var(--ink,#0f172a);">${esc(lang(s.leaf.title, "en"))}</b><span style="display:block; color:var(--ink-muted,#64748b); font-size:0.86rem;">${esc(lang(s.leaf.title, "as"))}</span></a>`;
    }).join("\n");
    const mainHTML = `    <div class="page-head">
      ${breadcrumbHTML(crumbs)}
      <h1>${esc(lang(sec.title, "en"))}</h1>
      <p class="page-desc">${esc(lang(sec.title, "as"))} &bull; ${esc(lang(EXAM.title, "as"))}</p>
    </div>

    <section class="section" style="padding-bottom:46px;">
      <div style="margin-top:18px;"><a class="btn btn-outline btn-sm" href="${examPath}/">Back to ${esc(lang(EXAM.title, "en"))}</a></div>
    </section>
    <section class="section" data-exam-subcats style="padding-bottom:40px;">
      <h2 style="margin:0 0 6px;">Sub-categories</h2>
      <div class="sub-grid">
${cards}
      </div>
    </section>`;
    write(`exams/${EXAM.id}/${sec.id}/index.html`, pageShell({ head, mainHTML, extraHTML: editorialBlock(EXAM, sec.title, sec.id) + "\n" }));
  }

  /* leaf pages */
  for (const item of leaves) {
    const parts = [item.sec.id, ...(item.group ? [item.group.id] : []), item.leaf.id];
    const route = `${examPath}/${parts.join("/")}`;
    const canonical = `${BASE}${route}/`;
    const bank = (BANKS[`${EXAM.id}:${item.leaf.id}`] || []).map(normalize);
    const title = `${lang(item.leaf.title, "en")} - ${lang(item.sec.title, "en")} - ${lang(EXAM.title, "en")} | axomexam`;
    const desc = `Practise ${lang(item.leaf.title, "en")} MCQs with answers and explanations for ${lang(EXAM.title, "en")} - ${lang(item.sec.title, "en")}.`;
    const crumbs = [
      ...crumbsRoot,
      { name: lang(EXAM.title, "en"), url: examCanonical },
      { name: lang(item.sec.title, "en"), url: `${BASE}${examPath}/${item.sec.id}/` },
      ...(item.group ? [{ name: lang(item.group.title, "en"), url: `${BASE}${examPath}/${item.sec.id}/${item.group.id}/` }] : []),
      { name: lang(item.leaf.title, "en") },
    ];
    const head = pageHead({
      title, desc, canonical, themeColor: item.sec.color,
      imageAlt: `axomexam - ${lang(item.leaf.title, "en")}`, cover: EXAM.cover,
      jsonld: jsonld({ canonical, title, desc, crumbs, cover: EXAM.cover, teaches: lang(item.sec.title, "en") }),
    });
    const mainHTML = `    <div class="page-head">
      ${breadcrumbHTML(crumbs)}
      <h1>${esc(lang(item.leaf.title, "en"))}</h1>
      <p class="page-desc">${esc(lang(item.leaf.title, "as"))} &bull; ${esc(lang(item.sec.title, "en"))} &bull; ${esc(lang(EXAM.title, "en"))}</p>
    </div>

    <section class="section" style="padding-bottom:46px;">
      <div style="margin-top:18px;"><a class="btn btn-outline btn-sm" href="${examPath}/${item.sec.id}/">Back to ${esc(lang(item.sec.title, "en"))}</a></div>
    </section>
    <section class="section" style="padding-bottom:40px;"><!-- axo-static-qa --><div class="qa-list" style="max-width:860px; margin:0 auto;"><h2 style="font-size:1.15rem; margin-bottom:18px;">${bank.length} Questions with Answers</h2>${bank.map((q, i) => qaItemHTML(q, i + 1)).join("")}</div></section>`;
    write(`exams/${EXAM.id}/${parts.join("/")}/index.html`, pageShell({ head, mainHTML, extraHTML: editorialBlock(EXAM, item.sec.title, item.sec.id) + "\n" }));
  }

  /* syllabus page */
  {
    const sec = EXAM.sections.find((s) => s.type === "syllabus");
    const route = `${examPath}/${sec.id}`;
    const canonical = `${BASE}${route}/`;
    const title = `${lang(EXAM.syllabus.title, "en")} and Exam Pattern | axomexam`;
    const desc = lang(EXAM.syllabus.description, "en");
    const crumbs = [...crumbsRoot, { name: lang(EXAM.title, "en"), url: examCanonical }, { name: lang(sec.title, "en") }];
    const head = pageHead({
      title, desc, canonical, themeColor: sec.color,
      imageAlt: `axomexam - ${lang(EXAM.syllabus.title, "en")}`, cover: EXAM.cover,
      jsonld: jsonld({ canonical, title, desc, crumbs, cover: EXAM.cover }),
    });
    const articleFor = (key) => EXAM.syllabus.chapters.map((c) => {
      const body = lang(c.content, key);
      const blocks = String(body).split("\n\n").map((b) => {
        const lines = b.split("\n").filter((l) => l.trim());
        if (lines.length > 1 && lines.slice(1).every((l) => /^\s*[-•]/.test(l))) {
          const head0 = `<p><strong>${esc(lines[0].trim())}</strong></p>`;
          const items = lines.slice(1).map((l) => `<li>${esc(l.replace(/^\s*[-•]\s*/, "").trim())}</li>`).join("");
          return head0 + `<ul>${items}</ul>`;
        }
        return `<p>${esc(b.replace(/\n/g, " ").trim())}</p>`;
      }).join("");
      return `<h3>${esc(lang(c.title, key))}</h3>\n${blocks}`;
    }).join("\n");
    const mainHTML = `    <div class="page-head">
      ${breadcrumbHTML(crumbs)}
      <h1>${esc(lang(sec.title, "en"))}</h1>
      <p class="page-desc">${esc(lang(sec.title, "as"))} &bull; ${esc(lang(EXAM.title, "en"))}</p>
    </div>

    <section class="section" style="padding-bottom:46px;">
      <article class="info-panel" style="background:var(--bg,#ffffff); border:1px solid var(--border,#e2e8f0); border-radius:18px; padding:28px 24px; line-height:1.85; color:var(--ink-soft,#475569); max-width:900px; margin:18px auto 0; text-align:left;">
        <h2>${esc(lang(EXAM.syllabus.title, "en"))} and Exam Pattern</h2>
        <p>${esc(lang(EXAM.syllabus.description, "en"))}</p>
${articleFor("en")}
        <h3>${esc(lang(EXAM.syllabus.title, "as"))}</h3>
${articleFor("as")}
        <p style="margin-top:22px; padding-top:14px; border-top:1px solid var(--border,#e2e8f0); font-size:0.88rem; color:#64748b;"><strong>Note:</strong> axomexam.in is an independent study platform and is not affiliated with DHS, DME or the Government of Assam. Verify all details from the official notification.</p>
      </article>
      <div style="margin-top:18px; text-align:center;"><a class="btn btn-outline btn-sm" href="${examPath}/">Back to ${esc(lang(EXAM.title, "en"))}</a></div>
    </section>`;
    write(`exams/${EXAM.id}/${sec.id}/index.html`, pageShell({ head, mainHTML, extraHTML: editorialBlock(EXAM, { en: "Syllabus and exam pattern", as: "পাঠ্যক্ৰম আৰু পৰীক্ষাৰ ধৰণ" }, "gk") + "\n" }));
  }

  /* upload guide */
  {
    const rows = [];
    for (const sec of EXAM.sections) {
      if (sec.type === "syllabus") continue;
      for (const sub of sec.subcategories || []) {
        rows.push(`| ${lang(sec.title, "en")} | ${lang(sub.title, "en")} | \`${sec.id}/${sub.id}\` |`);
      }
    }
    const readme = `# ${lang(EXAM.title, "en")} — Question Upload Guide

This folder uses the **exact same structure as** \`data/exams/adre-grade-4/\`.
The list of sections and topics is controlled by \`data/exams/index.json\` (repo root).

## Rules

1. Upload questions **only** inside the exact topic folder shown in the table below.
2. Keep the whole bank for a topic in its single \`question-001.json\`. Add \`question-002.json\` and upward only if a topic genuinely needs a second file, and then list it in \`index.json\`'s \`"files"\` array.
3. Do not put questions in \`index.json\`. That file is only a manifest.
4. A question file holds an array \`[ ... ]\` of question objects.
5. Every question needs bilingual \`en\` and \`as\` text for \`q\`, each option and the \`explanation\`. \`correct\` is the 0-based index of the right option.

## Where to upload — section & topic wise

| Section | Topic | Upload folder (inside \`data/exams/${EXAM.id}/\`) |
| --- | --- | --- |
| Syllabus | Syllabus notes | \`syllabus.json\` |
${rows.join("\n")}

---

The JSON here is generated by \`tools/build-dhs-dme.js\` from
\`tools/dhs-dme.structure.js\` (which reads the shared banks under
\`data/mock-test/\`). Re-run that script after editing the sources instead of
hand-editing the JSON here.
`;
    write(`data/exams/${EXAM.id}/README.md`, readme);
  }

  return leaves;
}

function examEntry(EXAM) {
  return {
    id: EXAM.id,
    title: EXAM.title,
    subtitle: EXAM.subtitle,
    note: EXAM.note,
    cover: EXAM.cover,
    coverAlt: EXAM.coverAlt,
    logo: EXAM.logo,
    logoAlt: EXAM.logoAlt,
    color: EXAM.color,
    icon: EXAM.icon,
    status: EXAM.status,
    sections: EXAM.sections.map((s) => {
      const out = { id: s.id, type: s.type, color: s.color, title: s.title };
      if (Array.isArray(s.subcategories)) {
        out.subcategories = s.subcategories.map((sub) => ({ id: sub.id, title: sub.title }));
      }
      return out;
    }),
  };
}

/* ---------------- registry splice ---------------- */
function spliceIndex(EXAMS) {
  const idxRel = "data/exams/index.json";
  const idxAbs = path.join(ROOT, idxRel);
  let raw = fs.readFileSync(idxAbs, "utf8");

  const objEnd = (text, openIdx) => {
    let depth = 0, inStr = false, esc2 = false;
    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc2) esc2 = false;
        else if (ch === "\\") esc2 = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (!depth) return i; }
    }
    return -1;
  };
  const blockFor = (id) => {
    const key = `"id": "${id}"`;
    const at = raw.indexOf(key);
    if (at === -1) return null;
    const open = raw.lastIndexOf("{", at);
    const close = objEnd(raw, open);
    if (open === -1 || close === -1) return null;
    return { open, end: close + 1 };
  };

  for (const EXAM of EXAMS) {
    const entry = examEntry(EXAM);
    const text = "    " + compactJSON(entry, 4);
    const existing = blockFor(EXAM.id);
    if (existing) {
      raw = raw.slice(0, existing.open) + text.trimStart() + raw.slice(existing.end);
    } else {
      const anchor = blockFor("adre-grade-4");
      if (anchor) {
        raw = raw.slice(0, anchor.end) + ",\n" + text + raw.slice(anchor.end);
      }
    }
  }
  write(idxRel, raw);
}

/* ---------------- sitemap ---------------- */
function updateSitemap(EXAMS, leavesByExam) {
  const smAbs = path.join(ROOT, "sitemap.xml");
  if (!fs.existsSync(smAbs)) return;
  let xml = fs.readFileSync(smAbs, "utf8");
  const add = [];
  for (const EXAM of EXAMS) {
    const examPath = `/exams/${EXAM.id}`;
    const urls = [
      `${examPath}/`,
      ...EXAM.sections.map((s) => `${examPath}/${s.id}/`),
      ...leavesByExam[EXAM.id].map((l) => `${examPath}/${[l.sec.id, ...(l.group ? [l.group.id] : []), l.leaf.id].join("/")}/`),
    ];
    for (const u of urls) {
      if (xml.indexOf(`<loc>${BASE}${u}</loc>`) !== -1) continue;
      add.push(`  <url>\n    <loc>${BASE}${u}</loc>\n    <lastmod>${DATE}</lastmod>\n  </url>`);
    }
  }
  if (add.length) {
    xml = xml.replace("</urlset>", add.join("\n") + "\n</urlset>");
    write("sitemap.xml", xml);
  }
}

/* ---------------- exams/index.html crawler copy ---------------- */
function updateExamsIndex(EXAMS, leavesByExam) {
  const file = path.join(ROOT, "exams", "index.html");
  if (!fs.existsSync(file)) return;
  let html = fs.readFileSync(file, "utf8");
  let touched = false;
  for (const EXAM of EXAMS) {
    const examEn = lang(EXAM.title, "en");
    const examAs = lang(EXAM.title, "as");
    const href = `/exams/${EXAM.id}/`;
    const qaSecs = EXAM.sections.filter((s) => s.type !== "syllabus");
    const total = leavesByExam[EXAM.id].reduce((a, l) => a + (BANK_COUNT[`${EXAM.id}:${l.leaf.id}`] || 0), 0);
    const label = `${examEn} — ${qaSecs.map((s) => lang(s.title, "en")).join(", ")}`;
    if (html.indexOf(`href="${href}"`) === -1) {
      const li = `        <li><a href="${href}">${esc(label)}</a></li>\n`;
      const marker = "Exam books available on this portal:";
      const at = html.indexOf(marker);
      if (at !== -1) {
        const ulEnd = html.indexOf("</ul>", at);
        if (ulEnd !== -1) { html = html.slice(0, ulEnd) + li + html.slice(ulEnd); touched = true; }
      }
    }
    if (html.indexOf(`<strong>${examEn}</strong>`) === -1) {
      const li = `          <li><strong>${esc(examEn)}</strong> <span lang="as">${esc(examAs)}</span> — ${EXAM.sections.length} sections, ${total.toLocaleString("en-IN")} practice questions.</li>\n`;
      const at = html.indexOf(`<strong>Assam Police</strong>`);
      if (at !== -1) {
        const lineEnd = html.indexOf("\n", at) + 1;
        html = html.slice(0, lineEnd) + li + html.slice(lineEnd);
        touched = true;
      }
    }
  }
  if (touched) write("exams/index.html", html);
}

/* ---------------- driver ---------------- */
const BANKS = {};
const BANK_COUNT = {};

/* Pre-build every bank so the cursor advances deterministically across books
   before any page is rendered. */
for (const EXAM of EXAMS) {
  for (const sec of EXAM.sections) {
    if (sec.type === "syllabus") continue;
    for (const sub of sec.subcategories || []) {
      const bank = buildBank(sub.source, sub.id);
      BANKS[`${EXAM.id}:${sub.id}`] = bank;
      BANK_COUNT[`${EXAM.id}:${sub.id}`] = bank.length;
    }
  }
}

const leavesByExam = {};
for (const EXAM of EXAMS) leavesByExam[EXAM.id] = buildBook(EXAM);
spliceIndex(EXAMS);
updateSitemap(EXAMS, leavesByExam);
updateExamsIndex(EXAMS, leavesByExam);

console.log(`build-dhs-dme${DRY ? " (dry-run)" : ""}`);
for (const EXAM of EXAMS) {
  const total = leavesByExam[EXAM.id].reduce((a, l) => a + (BANK_COUNT[`${EXAM.id}:${l.leaf.id}`] || 0), 0);
  console.log(`  ${EXAM.id}: ${EXAM.sections.length} sections, ${leavesByExam[EXAM.id].length} topics, ${total} questions`);
}
console.log(`  written  : ${written}   unchanged: ${skipped}`);
