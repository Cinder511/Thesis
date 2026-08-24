import { readFileSync, writeFileSync } from "node:fs";

// Build the row-level GLMM dataset:
//   scorable rows = verdict in {definite-correct, ambiguous, wrong} (D = 118),
//   joined to the old GLMM rows (test_glmm_data.csv) for predictor columns.
//   fail_primary  = 1 if verdict == "wrong"            (definitely wrong; 94/118 = 79.7%)
//   fail_strict   = 1 if verdict != "definite-correct" (strict; 113/118, only 5 successes, all in one study -> separation)
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
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
const toRec = (h, r) => { const o = {}; h.forEach((x, i) => o[x] = (r[i] ?? "").trim()); return o; };

const v = parseCSV(readFileSync(`${import.meta.dirname}/months_rowlevel_scored.csv`, "utf8"));
const vH = v[0].map(h => h.trim());
const vRows = v.slice(1).map(r => toRec(vH, r)).filter(r => ["definite-correct", "ambiguous", "wrong"].includes(r.verdict));

const g = parseCSV(readFileSync(`${import.meta.dirname}/test_glmm_data.csv`, "utf8"));
const gH = g[0].map(h => h.trim());
const gRows = g.slice(1).map(r => toRec(gH, r));

const normSid = s => String(s ?? "").trim().replace(/\.0+$/, "");
const key = (file, effect) => `${String(file).normalize("NFC")}|${String(effect).trim()}`;
const gByKey = new Map(gRows.map(r => [key(r.file_name, r.effect_id), r]));

const out = [];
let unmatched = 0;
for (const vr of vRows) {
  const rec = gByKey.get(key(vr.file, vr.effect));
  if (!rec) { unmatched++; console.log("UNMATCHED:", vr.file, vr.effect); continue; }
  out.push({
    file_name: rec.file_name,
    gt_study: normSid(rec.gt_study),
    effect_id: rec.effect_id,
    bd_metric: rec.bd_metric,
    i_months_since_establishment: rec.i_months_since_establishment,
    verdict: vr.verdict,
    fail: vr.verdict === "wrong" ? 1 : 0,
    fail_strict: vr.verdict === "definite-correct" ? 0 : 1,
    species_Multiple: rec.species_Multiple,
    sentence_Long: rec.sentence_Long,
    multi_sampling: rec.multi_sampling,
  });
}
console.log(`joined ${out.length}/${vRows.length} (unmatched ${unmatched})`);
const nFail = out.filter(r => r.fail === 1).length;
const nFailStrict = out.filter(r => r.fail_strict === 1).length;
console.log(`fail_primary: ${nFail}/${out.length} = ${(100 * nFail / out.length).toFixed(1)}%`);
console.log(`fail_strict: ${nFailStrict}/${out.length} = ${(100 * nFailStrict / out.length).toFixed(1)}%`);
const succ = out.filter(r => r.fail === 0);
console.log(`non-fail rows: ${succ.length} across studies: ${[...new Set(succ.map(r => r.gt_study))].join(",")}`);
const succStrict = out.filter(r => r.fail_strict === 0);
console.log(`strict-success rows: ${succStrict.length} across studies: ${[...new Set(succStrict.map(r => r.gt_study))].join(",")}`);

const header = "file_name,gt_study,effect_id,bd_metric,i_months_since_establishment,verdict,fail,fail_strict,species_Multiple,sentence_Long,multi_sampling";
const csv = [header, ...out.map(r => [r.file_name, r.gt_study, r.effect_id, r.bd_metric, r.i_months_since_establishment, r.verdict, r.fail, r.fail_strict, r.species_Multiple, r.sentence_Long, r.multi_sampling]
  .map(c => /[",\n\r]/.test(String(c ?? "")) ? `"${String(c).replace(/"/g, '""')}"` : (c ?? "")).join(","))].join("\n") + "\n";
writeFileSync(`${import.meta.dirname}/test_glmm_data_rowlevel.csv`, csv, "utf8");
console.log("saved test_glmm_data_rowlevel.csv");
