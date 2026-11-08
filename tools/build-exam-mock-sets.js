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
 * The shuffle is seeded per exam+set, so re-running rewrites identical bytes
 * and a set stays stable for a candidate who re-attempts it.
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

function normalizeQ(item) {
  if (!item || typeof item !== "object") return null;
  if (!item.q || !Array.isArray(item.options) || item.options.length < 2) return null;
  if (!Number.isInteger(item.correct) || item.correct < 0 || item.correct >= item.options.length) return null;
  const out = {
    id: String(item.id || ""),
    q: { en: item.q.en || "", as: item.q.as || "" },
    options: item.options.map((o) => ({ en: o.en || "", as: o.as || "" })),
    correct: item.correct,
  };
  if (item.explanation) out.explanation = { en: item.explanation.en || "", as: item.explanation.as || "" };
  return out;
}

/* Build a de-duplicated, deterministically ordered pool for one exam. */
function buildPool(exam) {
  const seen = new Set();
  const pool = [];
  const sections = (exam.sections || []).filter((s) => s.type !== "syllabus");
  for (const sec of sections) {
    const qs = readSectionQuestions(exam.id, sec);
    for (const raw of qs) {
      const q = normalizeQ(raw);
      if (!q) continue;
      /* A question can repeat across sections in the bank; keep one copy,
         keyed by its stable id, falling back to its English text. */
      const key = q.id || `t:${q.q.en}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(q);
    }
  }
  return pool;
}

function main() {
  const index = readJSON(path.join(ROOT, "data", "exams", "index.json")) || { exams: [] };
  const exams = (index.exams || []).filter((e) => e.status === "available");

  let written = 0;
  let changed = 0;
  const report = [];

  for (const exam of exams) {
    const pool = buildPool(exam);
    const rnd = mulberry32(seedFor(exam.id));
    const order = shuffleInPlace(pool.slice(), rnd);
    const needed = SETS_PER_EXAM * QUESTIONS_PER_SET;

    const dir = path.join(ROOT, "data", "exam-mock-sets", exam.id);
    if (!CHECK) fs.mkdirSync(dir, { recursive: true });

    const sets = Math.min(SETS_PER_EXAM, Math.floor(order.length / QUESTIONS_PER_SET));
    for (let n = 1; n <= sets; n++) {
      const questions = order.slice((n - 1) * QUESTIONS_PER_SET, n * QUESTIONS_PER_SET);
      const payload = {
        setNumber: n,
        title: `Full Paper Set ${n}`,
        exam: exam.id,
        questions,
      };
      const bytes = JSON.stringify(payload, null, 2) + "\n";
      const file = path.join(dir, `set-${n}.json`);
      const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (prev !== bytes) {
        changed++;
        if (!CHECK) fs.writeFileSync(file, bytes);
      }
      written++;
    }
    report.push(`${exam.id}: pool ${pool.length} | sets ${sets} (need ${needed})`);
  }

  console.log(`${CHECK ? "[check] " : ""}Exam mock sets`);
  report.forEach((r) => console.log("  " + r));
  console.log(`  Files ${CHECK ? "with drift" : "written"}: ${CHECK ? changed : written}`);
}

main();
