#!/usr/bin/env node
"use strict";

/*
 * tools/build-exam-mock-sets.js
 *
 * Builds full-paper mock-test sets for each available exam.
 *
 * An exam-wise mock test is not a single-subject practice set: it mirrors the
 * real paper, so one set mixes every subject of that exam and runs to a fixed
 * length (100 questions). This tool draws those questions from the exam's own
 * question bank (data/exams/<exam>/<section>/...) and writes
 *
 *   data/exam-mock-sets/<exam>/set-<n>.json
 *
 * with the same canonical question shape the bank uses, so the runtime mock
 * engine can normalise and play it without a special case.
 *
 * Two build modes
 * ---------------
 * 1. Blueprint mode. If data/exam-mock-sets/blueprints/<exam>.json exists, the
 *    paper follows that section-wise blueprint exactly: each section
 *    contributes its fixed number of questions (for Assam Police, 25 / 25 /
 *    20 / 15 / 15 across Sections A-E). Questions are drawn round-robin across
 *    the section's sub-categories so one set spans the whole section, and each
 *    set draws a *different* slice of every section, so the five sets never
 *    repeat a question. This is how the real paper is set, so a candidate
 *    practises the true section mix instead of a random draw.
 * 2. Legacy mode. With no blueprint the whole bank is shuffled and sliced, as
 *    before. The shuffle is seeded per exam, so re-running rewrites identical
 *    bytes and a set stays stable for a candidate who re-attempts it.
 *
 * Usage:
 *   node tools/build-exam-mock-sets.js            # apply
 *   node tools/build-exam-mock-sets.js --check    # report drift only
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CHECK = process.argv.includes("--check");
const SETS_PER_EXAM = 5;
const QUESTIONS_PER_SET = 100;

/* ---------- helpers ---------- */

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

/* Flatten a section's subcategory tree into leaf paths. */
function leafPaths(subs, prefix) {
  const out = [];
  (subs || []).forEach((s) => {
    const trail = prefix.concat(s.id);
    const kids = s.subcategories || [];
    if (kids.length) out.push(...leafPaths(kids, trail));
    else out.push(trail);
  });
  return out;
}

function normalizeQ(item) {
  if (!item || typeof item !== "object") return null;
  if (!item.q || !Array.isArray(item.options) || item.options.length < 2) return null;
  if (!Number.isInteger(item.correct) || item.correct < 0 || item.correct >= item.options.length) return null;
  const out = {
    id: String(item.id || ""),
    q: { en: item.q.en || "", as: item.q.as || "" },
    options: item.options.map((o) => {
      const opt = { en: o.en || "", as: o.as || "" };
      /* Non-verbal questions carry the shape as an inline SVG on the option
         (and sometimes on the question itself). Keep it so the runtime and the
         static page can draw the figure. */
      if (typeof o.fig === "string" && o.fig) opt.fig = o.fig;
      return opt;
    }),
    correct: item.correct,
  };
  if (typeof item.fig === "string" && item.fig) out.fig = item.fig;
  if (item.explanation) out.explanation = { en: item.explanation.en || "", as: item.explanation.as || "" };
  return out;
}

/* Every question of one section, in file order. */
function readSectionQuestions(examId, sec) {
  const subs = Array.isArray(sec.subcategories) ? sec.subcategories : [];
  const paths = subs.length ? leafPaths(subs, []) : [[]];
  const all = [];
  for (const trail of paths) {
    const dir = path.join(ROOT, "data", "exams", examId, sec.id, ...trail);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => /^question-.*\.json$/i.test(f)).sort();
    for (const f of files) {
      const data = readJSON(path.join(dir, f));
      if (Array.isArray(data)) all.push(...data);
    }
  }
  return all;
}

/* Same as readSectionQuestions, but grouped per leaf sub-category so the
   blueprint builder can round-robin across them. */
function readSectionGroups(examId, sec) {
  const subs = Array.isArray(sec.subcategories) ? sec.subcategories : [];
  const paths = subs.length ? leafPaths(subs, []) : [[]];
  const groups = [];
  for (const trail of paths) {
    const dir = path.join(ROOT, "data", "exams", examId, sec.id, ...trail);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => /^question-.*\.json$/i.test(f)).sort();
    const qs = [];
    for (const f of files) {
      const data = readJSON(path.join(dir, f));
      if (Array.isArray(data)) {
        for (const raw of data) {
          const q = normalizeQ(raw);
          if (q) qs.push(q);
        }
      }
    }
    if (qs.length) groups.push(qs);
  }
  return groups;
}

/* Interleave the groups one item at a time, so the merged list alternates
   across sub-categories rather than exhausting one before the next. */
function roundRobin(groups) {
  const out = [];
  const max = groups.reduce((m, g) => Math.max(m, g.length), 0);
  for (let i = 0; i < max; i++) {
    for (const g of groups) if (i < g.length) out.push(g[i]);
  }
  return out;
}

/* Deterministic PRNG (mulberry32) so a set is reproducible from its seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffleInPlace(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function deDupe(list) {
  const seen = new Set();
  const out = [];
  for (const q of list) {
    const key = q.id || `t:${q.q.en}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/* Write one set; returns true when the file bytes changed. */
function writeSet(dir, n, payload) {
  const bytes = JSON.stringify(payload, null, 2) + "\n";
  const file = path.join(dir, `set-${n}.json`);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (prev === bytes) return false;
  if (!CHECK) fs.writeFileSync(file, bytes);
  return true;
}

/* ---------- blueprint mode ---------- */

function readBlueprint(examId) {
  const p = path.join(ROOT, "data", "exam-mock-sets", "blueprints", `${examId}.json`);
  if (!fs.existsSync(p)) return null;
  const bp = readJSON(p);
  if (!bp || !Array.isArray(bp.sections) || !bp.sections.length) return null;
  return bp;
}

function blueprintMeta(bp) {
  return {
    durationMinutes: bp.durationMinutes,
    totalMarks: bp.totalMarks,
    marksPerQuestion: bp.marksPerQuestion,
    negativeMarking: !!bp.negativeMarking,
    sections: bp.sections.map((s) => ({ id: s.id, questions: s.questions, label: s.label })),
  };
}

/* Build the five sets so each follows the blueprint exactly, and every set
   draws a different slice of every section (no question repeats across sets). */
function buildBlueprintSets(exam, bp, dir) {
  const perSection = bp.sections.map((s) => {
    const sec = (exam.sections || []).find((x) => x.id === s.id);
    const pool = sec ? deDupe(roundRobin(readSectionGroups(exam.id, sec))) : [];
    const order = shuffleInPlace(pool, mulberry32(seedFor(`${exam.id}:${s.id}`)));
    return { id: s.id, need: s.questions, order };
  });

  const total = perSection.reduce((n, ps) => n + ps.need, 0);
  if (total !== QUESTIONS_PER_SET) {
    throw new Error(`${exam.id}: blueprint sections total ${total}, expected ${QUESTIONS_PER_SET}`);
  }
  const sets = Math.min(SETS_PER_EXAM, Math.min(...perSection.map((ps) => Math.floor(ps.order.length / ps.need))));
  const meta = blueprintMeta(bp);

  let changed = 0;
  for (let n = 1; n <= sets; n++) {
    const questions = [];
    for (const ps of perSection) questions.push(...ps.order.slice((n - 1) * ps.need, n * ps.need));
    shuffleInPlace(questions, mulberry32(seedFor(`${exam.id}:set:${n}`)));
    if (writeSet(dir, n, { setNumber: n, title: `Full Paper Set ${n}`, exam: exam.id, blueprint: meta, questions })) changed++;
  }

  const detail = perSection.map((ps) => `${ps.id}=${ps.need}`).join(", ");
  return { sets, changed, note: `blueprint [${detail}]` };
}

/* ---------- legacy mode (no blueprint) ---------- */

function buildLegacySets(exam, dir) {
  const seen = new Set();
  const pool = [];
  for (const sec of (exam.sections || []).filter((s) => s.type !== "syllabus")) {
    for (const raw of readSectionQuestions(exam.id, sec)) {
      const q = normalizeQ(raw);
      if (!q) continue;
      const key = q.id || `t:${q.q.en}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(q);
    }
  }

  const order = shuffleInPlace(pool.slice(), mulberry32(seedFor(exam.id)));
  const sets = Math.min(SETS_PER_EXAM, Math.floor(order.length / QUESTIONS_PER_SET));

  let changed = 0;
  for (let n = 1; n <= sets; n++) {
    const questions = order.slice((n - 1) * QUESTIONS_PER_SET, n * QUESTIONS_PER_SET);
    if (writeSet(dir, n, { setNumber: n, title: `Full Paper Set ${n}`, exam: exam.id, questions })) changed++;
  }
  return { sets, changed, note: `pool ${pool.length}` };
}

function main() {
  const index = readJSON(path.join(ROOT, "data", "exams", "index.json")) || { exams: [] };
  const exams = (index.exams || []).filter((e) => e.status === "available");

  let changed = 0;
  const report = [];

  for (const exam of exams) {
    const dir = path.join(ROOT, "data", "exam-mock-sets", exam.id);
    if (!CHECK) fs.mkdirSync(dir, { recursive: true });

    const bp = readBlueprint(exam.id);
    const built = bp ? buildBlueprintSets(exam, bp, dir) : buildLegacySets(exam, dir);
    changed += built.changed;
    report.push(`${exam.id}: ${built.note} | sets ${built.sets}`);
  }

  console.log(`${CHECK ? "[check] " : ""}Exam mock sets`);
  report.forEach((r) => console.log("  " + r));
  console.log(`  Files ${CHECK ? "with drift" : "changed"}: ${changed}`);
}

main();
