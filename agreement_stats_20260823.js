import { readFileSync } from "node:fs";

// ============================================================================
// Agreement statistics (tier 1): percentage agreement + Cohen's kappa, computed
// from the existing scored output.
// Model rows: test_scored_final.csv (mapped taxon term, metric, months).
// Reference rows: markdown conversion of the lab's reference xlsx, data_extraction
// sheet. The database is not public; export that sheet to markdown and save it as
// reference_data_extraction.md, or point REFERENCE_MD at your copy.
// Pairing rule for kappa: model row pairs with GT rows of same (study, metric group).
//   - taxon kappa: pair unambiguous if all matched GT rows share ONE mapped taxon term
//   - metric kappa: pair unambiguous if all GT rows of same (study, mapped taxon term) share ONE metric group
//   - months: strict agreement on rows whose (study, metric group) GT rows share a single month value
// GT-side label -> controlled term via transparent keyword rules (listed in output).
// ============================================================================

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
const toRec = (header, r) => { const o = {}; header.forEach((h, i) => o[h] = (r[i] ?? "").trim()); return o; };

// ---------- model rows ----------
const sc = parseCSV(readFileSync(`${import.meta.dirname}/test_scored_final.csv`, "utf8"));
const scH = sc[0].map(h => h.trim());
const normSid = s => String(s ?? "").trim().replace(/\.0$/, "");
const model = sc.slice(1).map(r => toRec(scH, r)).filter(r => r.file_name).map(r => { r.gt_study = normSid(r.gt_study); return r; });
console.log("model rows:", model.length);

// ---------- reference rows ----------
const REF_MD = process.env.REFERENCE_MD || `${import.meta.dirname}/reference_data_extraction.md`;
const md = readFileSync(REF_MD, "utf8");
const lines = md.split("\n");
const splitRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(s => s.trim());
const hdrIdx = lines.findIndex(l => /^\| *target_intervention \| *study_ID \|/.test(l));
if (hdrIdx < 0) throw new Error("reference table header not found in " + REF_MD);
const gtH = splitRow(lines[hdrIdx]);
const endIdx = lines.findIndex((l, i) => i > hdrIdx && /^## /.test(l));
const gtRows = [];
for (let i = hdrIdx + 1; i < (endIdx < 0 ? lines.length : endIdx); i++) {
  const l = lines[i];
  if (!l.startsWith("|")) continue;
  const cells = splitRow(l);
  if (cells.length >= 5 && cells[1] && cells[1] !== "") gtRows.push(toRec(gtH, cells));
}
console.log("GT rows:", gtRows.length);
const gtByStudy = new Map();
for (const r of gtRows) {
  const sid = normSid(r.study_ID);
  if (!gtByStudy.has(sid)) gtByStudy.set(sid, []);
  gtByStudy.get(sid).push(r);
}

// ---------- GT-side taxon -> controlled term (keyword rules, transparent) ----------
// v2 (2026-08-23, after independent verification): beetle/carabid/ladybird rules BEFORE the bees rule
// (word "beetle" contains "bee"); multi-group detection via distinct-hit counting; column precedence:
// specific non-umbrella column first (taxon_other > taxon_common > taxon_scientific).
const UMBRELLA = new Set(["arthropods", "insects", "invertebrates"]);
const GROUPS = [
  [/plant[- ]bug/, "bugs"],
  [/ladybird|coccinellid/, "beetles - other beetles"],
  [/carabid|ground beetle/, "beetles - ground beetles"],
  [/beetle|weevil/, "beetles - other beetles"],
  [/mites?\b|mites and ticks|acari/, "mites"],
  [/moth/, "moths"],
  [/bird|owl/, "birds"],
  [/spider/, "spiders"],
  [/bee|bumble|halictid|megachilid|andrenid/, "bees"],
  [/hoverfly|syrphid/, "flies - hoverflies"],
  [/flies|fly/, "flies - other flies"],
  [/aphid/, "aphids"],
  [/butterfl/, "butterflies"],
  [/orthoptera|grasshopper|cricket/, "orthoptera"],
  [/wasp/, "wasps"],
  [/bug|heteroptera|leafhopper|planthopper/, "bugs"],
  [/lacewing|ant/, "insects"],
  [/insect/, "insects"],
  [/arthropod/, "arthropods"],
  [/invertebrat/, "invertebrates"],
  [/mammal|hamster|mouse|shrew|vole/, "mammals"],
  [/natural enem|parasitoid|pollinator|pest|decomposer|parasite/, "functional"],
];
function mapLabel(s) {
  const t = String(s ?? "").toLowerCase();
  if (!t) return null;
  const hits = new Set();
  for (const [re, term] of GROUPS) if (re.test(t)) hits.add(term);
  if (hits.size === 0) return null;
  if (hits.size === 1) return [...hits][0];
  if (hits.size === 2 && hits.has("butterflies") && hits.has("moths")) return "butterflies"; // lepidoptera pair
  return "mixed taxa";
}
function gtTaxonTerm(r) {
  // column precedence: specific (non-umbrella) taxon_other first
  const o = mapLabel(r.taxon_other);
  if (o && !UMBRELLA.has(o)) return o;
  const c = mapLabel(r.taxon_common);
  if (c) return c;
  const s = mapLabel(r.taxon_scientific);
  if (s && !UMBRELLA.has(s)) return s;
  const full = mapLabel([r.taxon_other, r.taxon_common, r.taxon_scientific].filter(Boolean).join(" | "));
  return full || "unmapped";
}

// ---------- model-side category (incl. mini-mapping for no_gt_vocab labels) ----------
function modelTermCat(r) {
  if (r.taxon_gt) return r.taxon_gt;
  if (r.t_s === "no_gt_vocab") {
    const t = String(r.taxon_common || "").toLowerCase();
    if (/mite/.test(t)) return "mites";
    if (/moth/.test(t)) return "moths";
    if (/bird|owl/.test(t)) return "birds";
    if (/plant|flower|forb|apple/.test(t)) return "plants";
    if (/natural enem|parasitoid|pollinator|pest/.test(t)) return "functional";
  }
  return "outside";
}

// ---------- metric group (both sides) ----------
function metricGroup(s) {
  const t = String(s ?? "").toLowerCase();
  if (/activit.*dens/.test(t)) return "activity density";
  if (/abund/.test(t)) return "abundance";
  if (/rich/.test(t)) return "richness";
  if (/divers/.test(t)) return "diversity";
  if (/visit/.test(t)) return "visitation";
  if (/dens/.test(t)) return "density";
  if (/other|predator-prey|fruit|egg|ratio|size|weight|parasit/.test(t)) return "other";
  return "other";
}

// ---------- months parsing (GT) ----------
function parseGTMonths(v) {
  if (!v) return new Set();
  const s = String(v).trim();
  if (["na", "n/a", ""].includes(s.toLowerCase())) return new Set();
  let m = s.match(/^([<>~]?)\s*([\d.]+)\s*(?:[-–—~to]+\s*([\d.]+))?$/);
  if (!m) { const f = parseFloat(s); return isNaN(f) ? new Set() : new Set([Math.round(f)]); }
  const op = m[1], lo = parseFloat(m[2]), hi = m[3] ? parseFloat(m[3]) : null;
  if (hi !== null) { const out = new Set(); for (let i = Math.round(lo); i <= Math.round(hi); i++) out.add(i); return out; }
  if (op === "<") { const out = new Set(); for (let i = 0; i < Math.round(lo); i++) out.add(i); return out; }
  if (op === ">") { const out = new Set(); for (let i = Math.round(lo); i <= Math.round(lo) * 3; i++) out.add(i); return out; }
  return new Set([Math.round(lo)]);
}
function parseAIMonths(v) {
  if (!v || String(v).trim().toLowerCase() === "na") return { type: "AI_NA", cand: new Set() };
  const s = String(v).trim();
  if (/^>\s*\d+$/.test(s)) return { type: "range", cand: new Set() };
  if (/^\d+(\.\d+)?$/.test(s)) return { type: "single", cand: new Set([Math.round(parseFloat(s))]) };
  const cand = new Set([...s.matchAll(/(\d+(?:\.\d+)?)(?=\s*\(?(?:19|20)\d{2}\)?)/g)].map(m => Math.round(parseFloat(m[1]))));
  if (cand.size) return { type: "per_year", cand };
  const nums = [...s.matchAll(/\d+/g)].map(m => parseInt(m[0]));
  return { type: "single", cand: new Set(nums) };
}

// ---------- kappa / AC1 ----------
function cohenKappa(contingency, cats) {
  // contingency: 2D array [modelCat][gtCat] counts
  let N = 0, Po = 0;
  for (let i = 0; i < cats.length; i++) for (let j = 0; j < cats.length; j++) { N += contingency[i][j]; if (i === j) Po += contingency[i][j]; }
  Po /= N;
  const rowSum = cats.map((_, i) => cats.reduce((a, _, j) => a + contingency[i][j], 0));
  const colSum = cats.map((_, j) => cats.reduce((a, _, i) => a + contingency[i][j], 0));
  let Pe = 0;
  for (let i = 0; i < cats.length; i++) Pe += (rowSum[i] / N) * (colSum[i] / N);
  return { N, Po, Pe, kappa: (Po - Pe) / (1 - Pe) };
}
function gwetAC1(contingency, cats) {
  let N = 0, Po = 0;
  for (let i = 0; i < cats.length; i++) for (let j = 0; j < cats.length; j++) { N += contingency[i][j]; if (i === j) Po += contingency[i][j]; }
  Po /= N;
  const rowSum = cats.map((_, i) => cats.reduce((a, _, j) => a + contingency[i][j], 0));
  const colSum = cats.map((_, j) => cats.reduce((a, _, i) => a + contingency[i][j], 0));
  let Pe = 0;
  for (let i = 0; i < cats.length; i++) {
    const pi = (rowSum[i] + colSum[i]) / (2 * N);
    Pe += pi * (1 - pi);
  }
  Pe *= cats.length / (cats.length - 1);
  return { Po, Pe, ac1: (Po - Pe) / (1 - Pe) };
}

// ============ 1) country / location: % agreement only ============
const byFile = new Map();
for (const r of model) if (!byFile.has(r.file_name)) byFile.set(r.file_name, r);
const cOK = [...byFile.values()].filter(r => r.country_s === "correct").length;
const lOK = [...byFile.values()].filter(r => ["exact", "partial"].includes(r.location_s)).length;
console.log(`\ncountry: ${cOK}/20 agreement (100% if ${cOK}==20)`);
console.log(`location: ${lOK}/20 agreement (exact+partial)`);

// ============ 1b) taxon: study-level set agreement (paper's 60.8% design, my GT mapping) ============
{
  let agree = 0, n = 0;
  const breakdown = {};
  for (const r of model) {
    const mc = modelTermCat(r);
    if (!mc || mc === "AI_NA") continue;
    n++;
    const sid = r.gt_study;
    const g = gtByStudy.get(String(sid)) || [];
    const gTerms = new Set(g.map(gtTaxonTerm).filter(t => t !== "unmapped" && t !== "mixed taxa"));
    if (gTerms.has(mc)) { agree++; breakdown[mc] = (breakdown[mc] || 0) + 1; }
  }
  console.log(`\ntaxon study-level set agreement (my GT mapping): ${agree}/${n} = ${(100 * agree / n).toFixed(1)}%  [paper: 149/245=60.8%]`);
  console.log("agree by term:", JSON.stringify(breakdown));
}

// ============ 2) taxon: set-membership agreement + kappa on unambiguous pairs ============
let setAgree = 0, setN = 0, cats = null, catIdx = null;
// first pass: collect categories
const modelCat = model.map(r => r.taxon_gt || (r.t_s === "no_gt_vocab" ? "outside" : r.t_s));
const catSet = new Set(modelCat.filter(c => c && c !== "AI_NA"));
for (const r of model) {
  const sid = r.gt_study;
  const g = gtByStudy.get(String(sid)) || [];
  const gTerms = new Set(g.map(gtTaxonTerm).filter(t => t !== "unmapped" && t !== "mixed taxa"));
  for (const t of gTerms) catSet.add(t);
}
catSet.add("mixed taxa");
cats = [...catSet].sort();
catIdx = new Map(cats.map((c, i) => [c, i]));
const cont = cats.map(() => cats.map(() => 0));
let pairedN = 0, ambiguous = 0, noPair = 0, pairAgree = 0;
for (const r of model) {
  const mc = modelTermCat(r);
  if (!mc || mc === "AI_NA") continue;
  const sid = r.gt_study;
  const g = gtByStudy.get(String(sid)) || [];
  const mg = metricGroup(r.bd_metric);
  const cand = g.filter(gr => metricGroup(gr.bd_metric) === mg);
  const gTerms = new Set(cand.map(gtTaxonTerm).filter(t => t !== "unmapped"));
  if (!gTerms.size) { noPair++; continue; }
  // set-membership agreement (paper's 60.8% design)
  setN++;
  if (gTerms.has(mc)) setAgree++;
  if (gTerms.size === 1) {
    pairedN++;
    const gc = [...gTerms][0];
    const i = catIdx.has(mc) ? catIdx.get(mc) : catIdx.get("mixed taxa");
    const j = catIdx.has(gc) ? catIdx.get(gc) : catIdx.get("mixed taxa");
    cont[i][j]++;
    if (mc === gc) pairAgree++;
  } else ambiguous++;
}
console.log(`\ntaxon set-membership: ${setAgree}/${setN} = ${(100 * setAgree / setN).toFixed(1)}% (paper reports 149/245=60.8%)`);
console.log(`taxon kappa pairs: paired=${pairedN} ambiguous=${ambiguous} noPair=${noPair}, pair agreement ${pairAgree}/${pairedN}`);
const kt = cohenKappa(cont, cats);
console.log(`taxon Cohen's kappa = ${kt.kappa.toFixed(3)} (Po=${kt.Po.toFixed(3)}, Pe=${kt.Pe.toFixed(3)}, N=${kt.N})`);
const at = gwetAC1(cont, cats);
console.log(`taxon Gwet's AC1 = ${at.ac1.toFixed(3)}`);
// sensitivity: exclude model "outside" rows
{
  const iOut = catIdx.get("outside");
  const contNoOut = cont.map(row => row.slice());
  for (let i = 0; i < cats.length; i++) contNoOut[i][iOut] = 0;
  contNoOut[iOut] = cats.map(() => 0);
  // filter cats to those with nonzero marginals after removal
  const keep = [];
  for (let i = 0; i < cats.length; i++) {
    const rs = contNoOut[i].reduce((a, b) => a + b, 0);
    const cs = contNoOut.reduce((a, row) => a + row[i], 0);
    if (rs + cs > 0) keep.push(i);
  }
  const cats2 = keep.map(i => cats[i]);
  const cont2 = keep.map(i => keep.map(j => contNoOut[i][j]));
  const k2 = cohenKappa(cont2, cats2);
  console.log(`taxon kappa excluding outside rows = ${k2.kappa.toFixed(3)} (Po=${k2.Po.toFixed(3)}, Pe=${k2.Pe.toFixed(3)}, N=${k2.N})`);
}
// sensitivity: no mini-mapping, all no_gt_vocab forced to "outside"
{
  const cont3 = cats.map(() => cats.map(() => 0));
  let N3 = 0;
  for (const r of model) {
    const mc = r.taxon_gt || (r.t_s === "no_gt_vocab" ? "outside" : r.t_s);
    if (!mc || mc === "AI_NA") continue;
    const sid = r.gt_study;
    const g = gtByStudy.get(String(sid)) || [];
    const mg = metricGroup(r.bd_metric);
    const cand = g.filter(gr => metricGroup(gr.bd_metric) === mg);
    const gTerms = new Set(cand.map(gtTaxonTerm).filter(t => t !== "unmapped"));
    if (gTerms.size !== 1) continue;
    N3++;
    const gc = [...gTerms][0];
    const i = catIdx.has(mc) ? catIdx.get(mc) : catIdx.get("mixed taxa");
    const j = catIdx.has(gc) ? catIdx.get(gc) : catIdx.get("mixed taxa");
    cont3[i][j]++;
  }
  const k3 = cohenKappa(cont3, cats);
  console.log(`taxon kappa (no mini-mapping, outside as-is) = ${k3.kappa.toFixed(3)} (Po=${k3.Po.toFixed(3)}, Pe=${k3.Pe.toFixed(3)}, N=${k3.N})`);
}
// print contingency (non-zero cells)
console.log("taxon contingency (model \\ GT), non-zero cells:");
for (let i = 0; i < cats.length; i++) for (let j = 0; j < cats.length; j++) if (cont[i][j] > 0) console.log(`  ${cats[i]} -> ${cats[j]}: ${cont[i][j]}`);

// ============ 3) metric kappa: pair by (study, model mapped taxon term), unique GT metric group ============
const mcats = ["abundance", "density", "activity density", "richness", "diversity", "visitation", "other"];
const mIdx = new Map(mcats.map((c, i) => [c, i]));
const mCont = mcats.map(() => mcats.map(() => 0));
let mPair = 0, mAmb = 0, mNoPair = 0, mAgree = 0;
for (const r of model) {
  const mc = modelTermCat(r);
  const sid = r.gt_study;
  const g = gtByStudy.get(String(sid)) || [];
  // GT rows whose mapped taxon term equals the model's mapped term
  const cand = g.filter(gr => gtTaxonTerm(gr) === mc);
  if (!cand.length) { mNoPair++; continue; }
  const groups = new Set(cand.map(gr => metricGroup(gr.bd_metric)));
  if (groups.size === 1) {
    mPair++;
    const gg = [...groups][0];
    const mg = metricGroup(r.bd_metric);
    const i = mIdx.has(mg) ? mIdx.get(mg) : 6, j = mIdx.has(gg) ? mIdx.get(gg) : 6;
    mCont[i][j]++;
    if (mg === gg) mAgree++;
  } else mAmb++;
}
const km = cohenKappa(mCont, mcats);
console.log(`\nmetric kappa pairs: paired=${mPair} ambiguous=${mAmb} noPair=${mNoPair}, agreement ${mAgree}/${mPair}`);
console.log(`metric Cohen's kappa = ${km.kappa.toFixed(3)} (Po=${km.Po.toFixed(3)}, Pe=${km.Pe.toFixed(3)}, N=${km.N})`);
console.log("metric contingency non-zero:");
for (let i = 0; i < mcats.length; i++) for (let j = 0; j < mcats.length; j++) if (mCont[i][j] > 0) console.log(`  ${mcats[i]} -> ${mcats[j]}: ${mCont[i][j]}`);

// ============ 4) months: strict agreement on rows whose (study, metric group) GT share ONE month value ============
let moPair = 0, moAmb = 0, moNoRef = 0, moAgree = 0, moNA = 0;
const monthSetAgree = model.filter(r => r.m_s === "correct").length;
const monthSetWrong = model.filter(r => r.m_s === "wrong").length;
for (const r of model) {
  const p = parseAIMonths(r.i_months_since_establishment);
  if (p.type === "AI_NA") { moNA++; continue; }
  if (p.type === "range") { moNoRef++; continue; } // strict rule: range = wrong
  const sid = r.gt_study;
  const g = gtByStudy.get(String(sid)) || [];
  const mg = metricGroup(r.bd_metric);
  const cand = g.filter(gr => metricGroup(gr.bd_metric) === mg);
  const mSets = cand.map(gr => parseGTMonths(gr.i_months_since_establishment)).filter(s => s.size);
  if (!mSets.length) { moNoRef++; continue; }
  const union = new Set(); for (const s of mSets) for (const x of s) union.add(x);
  const allSingle = mSets.every(s => s.size === 1) && union.size === 1;
  if (allSingle) {
    moPair++;
    const gv = [...union][0];
    if ([...p.cand].some(c => c === gv)) moAgree++;
  } else {
    moAmb++;
  }
}
console.log(`\nmonths (paper set-scoring): correct=${monthSetAgree} wrong=${monthSetWrong}`);
console.log(`months strict single-value pairs: paired=${moPair} agree=${moAgree} (${(100 * moAgree / (moPair || 1)).toFixed(1)}%) ambiguous=${moAmb} noRef=${moNoRef} AI_NA=${moNA}`);

// ============ 5) sanity: model b_s / paper metric % ============
const bOK = model.filter(r => r.b_s === "correct").length;
const bW = model.filter(r => r.b_s === "wrong").length;
console.log(`\npaper metric scoring: correct=${bOK} wrong=${bW} = ${(100 * bOK / (bOK + bW)).toFixed(1)}%`);
