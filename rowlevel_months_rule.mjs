import { readFileSync, writeFileSync } from "node:fs";

// ============================================================================
// FINAL row-level months scoring rule (reproducible, bun-compatible)
// ============================================================================
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else { if (c === '"') inQ = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += c; }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const toRec = (h, r) => { const o = {}; h.forEach((x, i) => o[x] = (r[i] ?? "").trim()); return o; };
const normSid = s => String(s ?? "").trim().replace(/\.0+$/, "");
const roundHalfUp = n => Math.round(n + Number.EPSILON); // 5.5 -> 6, 6.5 -> 7 (documented)

// ---------- load reference (fixed CSV snapshot of the lab's xlsx) ----------
const REF_CSV = process.env.REFERENCE_CSV || `${import.meta.dirname}/reference_locked.csv`;
const refRows = parseCSV(readFileSync(REF_CSV, "utf8"));
const refH = refRows[0].map(h => h.trim());
const gtRows = refRows.slice(1).map(r => toRec(refH, r)).filter(r => r.study_ID);
const byStudy = new Map();
for (const r of gtRows) { const sid = normSid(r.study_ID); if (!byStudy.has(sid)) byStudy.set(sid, []); byStudy.get(sid).push(r); }

// ---------- load model ----------
const ai = parseCSV(readFileSync(`${import.meta.dirname}/AI_effect_level_test_20_complete.csv`, "utf8"));
const aiH = ai[0];
const aiRows = ai.slice(1).map(r => toRec(aiH, r)).filter(r => r.file_name);
const mp = parseCSV(readFileSync(`${import.meta.dirname}/final_mapping_with_meta.csv`, "utf8"));
const mpH = mp[0];
const file2study = {};
for (const r of mp.slice(1)) { const rec = toRec(mpH, r); if (rec.file) file2study[rec.file.normalize("NFC")] = normSid(rec.gt_study); }
for (const r of aiRows) r.gt_study = file2study[String(r.file_name).normalize("NFC")] || null;

// ---------- metric group (single published table, both sides) ----------
function metricGroupAI(s) {
  const t = String(s ?? "").trim().toLowerCase();
  if (t.startsWith("other")) return "other";
  if (t === "abundance") return "abundance";
  if (/dens/.test(t)) return "density";
  if (/rich/.test(t)) return "richness";
  if (/divers/.test(t)) return "diversity";
  if (/visit/.test(t)) return "visitation";
  return "other";
}
function metricGroupGT(s) {
  const t = String(s ?? "").trim().toLowerCase();
  if (t === "abundance") return "abundance";
  if (t === "activity-density" || t === "density" || t === "effort-corrected density") return "density";
  if (t === "species richness" || t === "group richness") return "richness";
  if (t === "diversity index" || t === "species diversity" || t === "group diversity") return "diversity";
  if (t === "capture/visitation rate") return "visitation";
  if (t === "biomass") return "biomass";   // no AI label maps here; "Other(...)" never lands in this group
  return "other";
}

// ---------- month parsing ----------
// GT: closed range "a-b"/"a–b"/"a–b"/"a to b" -> integer interval; plain number -> {n}.
//     open ">N"/"<N" -> NON_POINT sentinel (never definite, never wrong; point answer => ambiguous).
const NON_POINT = Symbol("non-point");
function parseGTMonths(v) {
  const s = String(v ?? "").trim();
  if (!s || /^na$/i.test(s)) return new Set();
  let m = s.match(/^([<>]?)\s*([\d.]+)\s*(?:[-–—~]+|\bto\b)\s*([\d.]+)\s*$/i);
  if (m && m[3]) { const a = roundHalfUp(parseFloat(m[2])), b = roundHalfUp(parseFloat(m[3])); const out = new Set(); for (let i = a; i <= b; i++) out.add(i); return out; }
  m = s.match(/^([<>]?)\s*([\d.]+)\s*$/);
  if (m) {
    if (m[1] === ">" || m[1] === "<") { const out = new Set(); out.add(NON_POINT); return out; }
    return new Set([roundHalfUp(parseFloat(m[2]))]);
  }
  const f = parseFloat(s);
  return isNaN(f) ? new Set() : new Set([roundHalfUp(f)]);
}
function parseAIMonths(v) {
  const s = String(v ?? "").trim();
  if (!s || /^na$/i.test(s)) return { type: "AI_NA", tokens: [] };
  if (/^>\s*\d+$/.test(s)) return { type: "range", tokens: [] };   // range answer where point expected -> WRONG
  if (/^\d+(\.\d+)?$/.test(s)) return { type: "single", tokens: [{ v: roundHalfUp(parseFloat(s)), y: null }] };
  const tokens = [];
  const re = /(\d+(?:\.\d+)?)\s*\(?\s*((?:19|20)\d{2})\s*\)?/g;
  let m;
  while ((m = re.exec(s))) tokens.push({ v: roundHalfUp(parseFloat(m[1])), y: parseInt(m[2]) });
  if (tokens.length) return { type: "per_year", tokens };
  const nums = [...s.matchAll(/\d+(?:\.\d+)?/g)].map(x => roundHalfUp(parseFloat(x[0])));
  return { type: "single", tokens: nums.map(v => ({ v, y: null })) };
}

// ---------- classify ----------
const buckets = { def: 0, amb: 0, wrong: 0, noRef: 0, aiNA: 0 };
const perYearRows = [];
const verdictRows = [];
const record = (r, verdict, note) => verdictRows.push({
  file: r.file_name, study: normSid(r.gt_study), effect: r.effect_id,
  metric: r.bd_metric, answer: r.i_months_since_establishment, verdict, note,
});
for (const r of aiRows) {
  const sid = r.gt_study; if (!sid) continue;
  const p = parseAIMonths(r.i_months_since_establishment);
  if (p.type === "AI_NA") { buckets.aiNA++; record(r, "AI_NA", "model withheld"); continue; }
  const mg = metricGroupAI(r.bd_metric);
  const g = byStudy.get(String(sid)) || [];
  const S = g.filter(gr => metricGroupGT(gr.bd_metric) === mg);
  const values = new Set(); const yearVal = new Map();
  for (const gr of S) {
    const yy = String(gr.earliest_sampling_date_year ?? "").trim();
    for (const mm of parseGTMonths(gr.i_months_since_establishment)) {
      if (mm === NON_POINT) { values.add(NON_POINT); continue; }
      values.add(mm);
      if (yy) yearVal.set(`${yy}|${mm}`, true);
    }
  }
  const pointVals = [...values].filter(x => x !== NON_POINT);
  const hasNonPoint = values.has(NON_POINT);
  if (!values.size) { buckets.noRef++; record(r, "no_ref", "no reference months for this study or metric"); continue; }
  if (p.type === "range") { buckets.wrong++; record(r, "wrong", "range answer where a point is expected"); continue; }

  if (p.type === "per_year") {
    const halves = p.tokens.map(t => ({ ...t, ok: t.y != null && yearVal.has(`${t.y}|${t.v}`) }));
    perYearRows.push({ sid, effect: r.effect_id, months: r.i_months_since_establishment, halves });
    if (halves.every(h => h.ok)) { buckets.def++; record(r, "definite-correct", "all year-tagged halves match"); }
    else { buckets.wrong++; record(r, "wrong", `per-year mismatch: ${halves.map(h => `${h.v}(${h.y})${h.ok ? "" : "!"}`).join(" ")}`); }
    continue;
  }
  // single untagged value
  const hit = p.tokens.some(t => pointVals.includes(t.v));
  if (!hit) {
    if (hasNonPoint) { buckets.amb++; record(r, "ambiguous", "open-ended reference value cannot disprove the answer"); }
    else { buckets.wrong++; record(r, "wrong", "value not in the reference scope"); }
    continue;
  }
  if (pointVals.length === 1 && !hasNonPoint) { buckets.def++; record(r, "definite-correct", "unique reference value in scope"); }
  else { buckets.amb++; record(r, "ambiguous", "value in scope but more than one possible"); }
}
const D = buckets.def + buckets.amb + buckets.wrong;
// per-row verdict table (appendix deliverable; no reference values included)
const vcsv = ["file,study,effect,metric,answer,verdict,note",
  ...verdictRows.map(v => [v.file, v.study, v.effect, v.metric, v.answer, v.verdict, v.note]
    .map(c => /[",\n\r]/.test(String(c ?? "")) ? `"${String(c).replace(/"/g, '""')}"` : (c ?? "")).join(","))].join("\n") + "\n";
writeFileSync(`${import.meta.dirname}/months_rowlevel_scored.csv`, vcsv, "utf8");
console.log("=== FINAL row-level rule ===");
console.log(`definite-correct = ${buckets.def}`);
console.log(`ambiguous        = ${buckets.amb}`);
console.log(`wrong            = ${buckets.wrong}`);
console.log(`no_ref (excluded)= ${buckets.noRef}`);
console.log(`AI_NA (excluded) = ${buckets.aiNA}`);
console.log(`scorable D       = ${D}`);
console.log(`ROW-LEVEL ACCURACY = ${buckets.def}/${D} = ${(100 * buckets.def / D).toFixed(1)}%`);
console.log(`  (optimistic upper bound incl ambiguous = ${(100 * (buckets.def + buckets.amb) / D).toFixed(1)}%)`);
console.log(`per-year rows:`);
for (const p of perYearRows) console.log(`  study ${p.sid} ${p.effect}: ${JSON.stringify(p.months)} -> ${p.halves.map(h => `${h.v}(${h.y})${h.ok ? "OK" : "WRONG"}`).join(" ")}`);
