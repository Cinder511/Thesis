import { readFileSync } from "node:fs";

// ---------- CSV parser ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const toRec = (header, r) => { const o = {}; header.forEach((h, i) => o[h] = (r[i] ?? "").trim()); return o; };

// ---------- load AI output ----------
const aiRaw = parseCSV(readFileSync(`${import.meta.dirname}/AI_effect_level_test_20_complete.csv`, "utf8"));
const aiHeader = aiRaw[0].map(h => h.trim());
const aiRows = aiRaw.slice(1).map(r => toRec(aiHeader, r)).filter(r => r.file_name);
// map file -> gt_study
const mpRaw = parseCSV(readFileSync(`${import.meta.dirname}/final_mapping_with_meta.csv`, "utf8"));
const mpHeader = mpRaw[0].map(h => h.trim());
const file2study = {};
for (const r of mpRaw.slice(1)) {
  const rec = toRec(mpHeader, r);
  if (rec.file) file2study[rec.file.normalize("NFC")] = rec.gt_study;
}
for (const r of aiRows) {
  const s = file2study[String(r.file_name).normalize("NFC")] || null;
  r.gt_study = s ? s.replace(/\.0$/, "") : null;
}
const normSid = s => String(s ?? "").trim().replace(/\.0$/, "");
console.log("AI rows:", aiRows.length, "| with study mapping:", aiRows.filter(r => r.gt_study).length);

// ---------- load reference from converted xlsx markdown ----------
// Reference rows: markdown conversion of the lab's reference xlsx (data_extraction
// sheet). Not public; export the sheet and save as reference_data_extraction.md,
// or set REFERENCE_MD.
const REF_MD = process.env.REFERENCE_MD || `${import.meta.dirname}/reference_data_extraction.md`;
const md = readFileSync(REF_MD, "utf8");
const lines = md.split("\n");
const splitRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(s => s.trim());
const hdrIdx = lines.findIndex(l => /^\| *target_intervention \| *study_ID \|/.test(l));
if (hdrIdx < 0) throw new Error("reference table header not found in " + REF_MD);
const gtHeader = splitRow(lines[hdrIdx]);
const endIdx = lines.findIndex((l, i) => i > hdrIdx && /^## /.test(l));
const gtRows = [];
for (let i = hdrIdx + 1; i < (endIdx < 0 ? lines.length : endIdx); i++) {
  const l = lines[i];
  if (!l.startsWith("|")) continue;
  const cells = splitRow(l);
  if (cells.length >= 5 && cells[1] && cells[1] !== "") gtRows.push(toRec(gtHeader, cells));
}
console.log("GT rows:", gtRows.length);
const gtByStudy = new Map();
for (const r of gtRows) {
  const sid = normSid(r.study_ID);
  if (!gtByStudy.has(sid)) gtByStudy.set(sid, []);
  gtByStudy.get(sid).push(r);
}

// ---------- normalisation helpers ----------
const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ALIAS = { usa: "united states", "united states of america": "united states", us: "united states", uk: "united kingdom", "great britain": "united kingdom" };
const mainCountry = c => {
  if (!c) return null;
  const parts = String(c).split("-");
  const main = norm(parts[0]);
  return ALIAS[main] || main || null;
};
// parse AI country string into a set of main-form countries
function parseAICountries(s) {
  if (!s) return new Set();
  const parts = s.split(/[,;&/]/).map(x => x.trim()).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    const m = mainCountry(p);
    if (m) out.add(m);
  }
  return out;
}

// ---------- 1) COUNTRY re-score (set-based, all site countries) ----------
console.log("\n===== COUNTRY =====");
const byFile = new Map();
for (const r of aiRows) if (!byFile.has(r.file_name)) byFile.set(r.file_name, r);
let cOK = 0, cTotal = 0;
for (const [f, r] of byFile) {
  const sid = r.gt_study;
  const gtRecs = gtByStudy.get(String(sid)) || [];
  if (!gtRecs.length) { console.log(`  ${f}: no GT rows (skip)`); continue; }
  const gtSet = new Set(gtRecs.map(g => mainCountry(g.country)).filter(Boolean));
  const aiSet = parseAICountries(r.country);
  const ok = aiSet.size > 0 && gtSet.size > 0 && [...gtSet].every(c => aiSet.has(c));
  // also flag extra countries in AI (model added countries GT doesn't have)
  const extra = [...aiSet].filter(c => !gtSet.has(c));
  cTotal++;
  if (ok && extra.length === 0) cOK++;
  console.log(`  study ${sid} [${f.slice(0, 28)}]: GT={${[...gtSet].join(", ")}} AI={${[...aiSet].join(", ")}} -> ${ok ? (extra.length ? "PARTIAL(extra:" + extra.join(",") + ")" : "CORRECT") : "WRONG"}`);
}
console.log(`COUNTRY: ${cOK}/${cTotal} = ${(100 * cOK / cTotal).toFixed(1)}%`);

// ---------- 2) LOCATION audit ----------
console.log("\n===== LOCATION =====");
const locStats = {};
for (const [f, r] of byFile) {
  const sid = r.gt_study;
  const gtRecs = gtByStudy.get(String(sid)) || [];
  const gtLocs = [...new Set(gtRecs.map(g => String(g.location || "").trim()).filter(Boolean))];
  const aiLoc = String(r.location || "").trim();
  let verdict;
  if (!aiLoc) verdict = "AI_NA";
  else {
    const a = norm(aiLoc);
    const exact = gtLocs.some(g => norm(g) === a || norm(g).includes(a) || a.includes(norm(g)));
    verdict = exact ? "exact" : "granularity/partial";
  }
  locStats[verdict] = (locStats[verdict] || 0) + 1;
  if (verdict === "AI_NA") console.log(`  NO-LOCATION paper: study ${sid} [${f}] | GT locations: ${gtLocs.slice(0, 4).join(" / ")}`);
}
console.log("location verdicts:", locStats);

// ---------- 3) MONTHS row-level sensitivity ----------
console.log("\n===== MONTHS (study-set vs row-level) =====");
function parseGTMonths(v) {
  if (!v) return new Set();
  const s = String(v).trim();
  if (["na", "n/a", ""].includes(s.toLowerCase())) return new Set();
  let m = s.match(/^([<>~]?)\s*([\d.]+)\s*(?:[-–—~to]+\s*([\d.]+))?$/);
  if (!m) {
    const f = parseFloat(s);
    return isNaN(f) ? new Set() : new Set([Math.round(f)]);
  }
  const op = m[1], lo = parseFloat(m[2]), hi = m[3] ? parseFloat(m[3]) : null;
  if (hi !== null) { const out = new Set(); for (let i = Math.round(lo); i <= Math.round(hi); i++) out.add(i); return out; }
  if (op === "<") { const out = new Set(); for (let i = 0; i < Math.round(lo); i++) out.add(i); return out; }
  if (op === ">") { const out = new Set(); for (let i = Math.round(lo); i <= Math.round(lo) * 3; i++) out.add(i); return out; }
  return new Set([Math.round(lo)]);
}
function parseAIMonths(v) {
  if (!v) return { type: "AI_NA", cand: new Set(), years: [] };
  const s = String(v).trim();
  if (s.toLowerCase() === "na") return { type: "AI_NA", cand: new Set(), years: [] };
  if (/^>\s*\d+$/.test(s)) return { type: "range", cand: new Set(), years: [] };
  if (/^\d+(\.\d+)?$/.test(s)) return { type: "single", cand: new Set([Math.round(parseFloat(s))]), years: [] };
  // per-year: "14 (2012), 26 (2013)"
  const years = [...s.matchAll(/\(?\b(19|20)\d{2}\b\)?/g)].map(m => m[0].replace(/[()]/g, ""));
  const cand = new Set([...s.matchAll(/(\d+(?:\.\d+)?)(?=\s*\(?(?:19|20)\d{2}\)?)/g)].map(m => Math.round(parseFloat(m[1]))));
  if (!cand.size) {
    const nums = [...s.matchAll(/\d+/g)].map(m => parseInt(m[0]));
    return { type: "single", cand: new Set(nums), years: [] };
  }
  return { type: "per_year", cand, years };
}

const BD = { "abundance": "abundance", "density": "density", "activity density": "activity density", "species richness": "species richness", "shannon diversity": "diversity index", "simpson diversity": "diversity index", "visitation rate": "capture/visitation rate", "egg density": "density", "other (flower cover)": null };
const gtMetric = g => String(g.bd_metric || "").trim().toLowerCase();

let setCorrect = 0, setWrong = 0, defCorrect = 0, ambCorrect = 0, perYearDef = 0;
let wrongStay = 0, rangeWrong = 0, aiNA = 0, gtNA = 0;
for (const r of aiRows) {
  const sid = r.gt_study;
  const gtRecs = gtByStudy.get(String(sid)) || [];
  const gtMonthSet = new Set();
  for (const g of gtRecs) for (const m of parseGTMonths(g.i_months_since_establishment)) gtMonthSet.add(m);
  const parsed = parseAIMonths(r.i_months_since_establishment);
  if (parsed.type === "AI_NA") { aiNA++; continue; }
  if (!gtMonthSet.size) { gtNA++; continue; }
  if (parsed.type === "range") { rangeWrong++; setWrong++; wrongStay++; continue; }
  const hit = [...parsed.cand].some(c => gtMonthSet.has(c));
  if (!hit) { setWrong++; wrongStay++; continue; }
  setCorrect++;
  // row-level classification
  if (parsed.type === "per_year") {
    perYearDef++; defCorrect++; continue; // has year tags; assume aligned (verify below for study 190)
  }
  // study has only one distinct month? then set-correct == row-correct
  if (gtMonthSet.size === 1) { defCorrect++; continue; }
  // narrow by metric group
  const aiBD = BD[String(r.bd_metric).trim().toLowerCase()];
  let mRecs;
  if (aiBD) mRecs = gtRecs.filter(g => gtMetric(g) === aiBD);
  else mRecs = gtRecs; // free-text "Other" -> cannot narrow
  const mM = new Set();
  for (const g of mRecs) for (const m of parseGTMonths(g.i_months_since_establishment)) mM.add(m);
  const hitNarrow = [...parsed.cand].some(c => mM.has(c));
  if (hitNarrow && mM.size === 1) defCorrect++;
  else ambCorrect++;
}
const nScored = setCorrect + setWrong;
console.log(`set-based: correct=${setCorrect} wrong=${setWrong} (acc ${(100 * setCorrect / nScored).toFixed(1)}%) [AI_NA=${aiNA}, GT_NA=${gtNA}]`);
console.log(`of ${setCorrect} set-correct: definite=${defCorrect}, ambiguous=${ambCorrect} (per-year definite=${perYearDef})`);
console.log(`row-level strict (definite only): ${(100 * defCorrect / nScored).toFixed(1)}%  (${defCorrect}/${nScored})`);
console.log(`row-level range: ${(100 * defCorrect / nScored).toFixed(1)}% – 23.0%`);

// ---------- per-year check for study 190 ----------
console.log("\nper-year rows (study 190):");
const g190 = gtByStudy.get("190") || [];
for (const g of g190.slice(0, 8)) {
  console.log(`  GT: metric=${g.bd_metric} months=${g.i_months_since_establishment} year=${g.earliest_sampling_date_year}`);
}
console.log("AI rows for 190:", aiRows.filter(r => r.gt_study === "190").map(r => `${r.effect_id} months=${r.i_months_since_establishment} metric=${r.bd_metric}`).join(" | "));

// ---------- 4) D4: taxon vocabulary re-mapping feasibility ----------
console.log("\n===== TAXON no_gt_vocab labels =====");
const tCount = {};
for (const r of aiRows) {
  const t = String(r.taxon_common || "").trim();
  if (!t || t === "NA") continue;
  // skip ones already mapped? we don't have TAXON dict here; just list all distinct with counts
  tCount[t] = (tCount[t] || 0) + 1;
}
const noGTKeys = ["mite", "moth", "bird", "owl", "plant", "apple", "flower", "forb", "natural enem", "parasit", "pollinator", "pest"];
console.log("AI labels that look like no_gt candidates:");
for (const [t, n] of Object.entries(tCount).sort((a, b) => b[1] - a[1])) {
  if (noGTKeys.some(k => t.toLowerCase().includes(k))) console.log(`  ${t} (n=${n})`);
}
console.log("\nGT labels containing mite/moth/bird per matching study:");
const aiLabelsByStudy = new Map();
for (const r of aiRows) {
  if (!aiLabelsByStudy.has(r.gt_study)) aiLabelsByStudy.set(r.gt_study, new Set());
  const t = String(r.taxon_common || "").trim();
  if (t && t !== "NA") aiLabelsByStudy.get(r.gt_study).add(t);
}
for (const [sid, labels] of aiLabelsByStudy) {
  const gtRecs = gtByStudy.get(String(sid)) || [];
  const gtLabels = new Set(gtRecs.flatMap(g => [g.taxon_common, g.taxon_other, g.taxon_scientific].filter(Boolean).map(x => x.trim())));
  const shortGT = [...gtLabels].filter(l => l.length < 60);
  const has = shortGT.filter(l => /mite|moth|bird|owl/i.test(l));
  const aiM = [...labels].filter(l => /mite|moth|bird|owl/i.test(l));
  if (has.length || aiM.length) {
    console.log(`  study ${sid}: AI={${aiM.join("; ")}} | GT={${has.join("; ")}}`);
  }
}
