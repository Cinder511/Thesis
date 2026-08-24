import { readFileSync, writeFileSync } from "node:fs";

// Export a fixed CSV snapshot of the reference database (data_extraction sheet)
// from its markdown conversion, for the row-level scoring scripts.
// Private data: do not commit this file to GitHub.
const REF_MD = process.env.REFERENCE_MD || `${import.meta.dirname}/reference_data_extraction.md`;
const md = readFileSync(REF_MD, "utf8");
const lines = md.split("\n");
const splitRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(s => s.trim());
const hdrIdx = lines.findIndex(l => /^\| *target_intervention \| *study_ID \|/.test(l));
if (hdrIdx < 0) throw new Error("reference table header not found in " + REF_MD);
const header = splitRow(lines[hdrIdx]);
const endIdx = lines.findIndex((l, i) => i > hdrIdx && /^## /.test(l));
const toRec = (r) => { const o = {}; header.forEach((h, i) => o[h] = (r[i] ?? "").trim()); return o; };

const KEEP = ["study_ID", "taxon_common", "taxon_other", "taxon_scientific", "functional_group",
  "bd_metric", "i_months_since_establishment", "earliest_sampling_date_year", "country", "location"];
const rows = [];
for (let i = hdrIdx + 1; i < (endIdx < 0 ? lines.length : endIdx); i++) {
  const l = lines[i];
  if (!l.startsWith("|")) continue;
  const cells = splitRow(l);
  if (cells.length >= 5 && cells[1] && cells[1] !== "") {
    const rec = toRec(cells);
    rows.push(KEEP.map(k => rec[k] ?? ""));
  }
}
const csv = [KEEP.join(","), ...rows.map(r => r.map(c => {
  const s = String(c ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(","))].join("\n") + "\n";
writeFileSync(`${import.meta.dirname}/reference_locked.csv`, csv, "utf8");
console.log(`exported ${rows.length} rows x ${KEEP.length} cols -> reference_locked.csv`);
console.log("unique study_IDs:", new Set(rows.map(r => r[0].replace(/\.0+$/, ""))).size);
