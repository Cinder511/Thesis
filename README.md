# Automated Data Extraction from Ecological Literature Using Large Language Models

Code and data for an MSc dissertation evaluating whether a large language model (gpt-5.6-sol) can automate effect-size-level data extraction for ecological meta-analysis. A two-pass pipeline (Pass 1 enumerates the effect sizes a paper reports; Pass 2 extracts per-effect-size fields) was run on 51 papers on flower planting for biodiversity, and every output was scored against a manually curated reference database maintained by the Biodiversity Futures Lab, Natural History Museum (3,302 effect-size rows across 68 papers; 3,220 rows belong to the 51 papers used here).

## Repository structure

| Path | What it is |
|---|---|
| `extraction_script_v4.R` | The extraction pipeline (text preparation, Pass 1, Pass 2, quote verification). Reads `train_test_split.csv`; API key comes from the `OPENAI_API_KEY` environment variable. |
| `prompts/pass1.md`, `prompts/pass2.md` | The Pass 1 and Pass 2 prompts in full. |
| `train_test_split.csv` | Train/test assignment of the 51 papers (31 training, 20 held-out test). |
| `score_final_authoritative.py` | Original scoring script. Its taxon and metric scoring (synonym mapping, controlled vocabularies) produced the columns in `test_scored_final.csv` that the paper's taxon and metric figures are built on. Its country and months scoring were superseded by the scripts below (country used a first-site-only rule later replaced by set matching; months used a study-level rule later replaced by row-level scoring). |
| `test_scored_final.csv` | Model outputs for the 245 enumerated effect rows with the paper's mapped taxon and metric labels and scores. |
| `rescore_verification_20260823.js` | Country re-scoring (set-based matching, 20/20 correct) and location audit. Its months section is superseded by `rowlevel_months_rule.mjs`. |
| `rowlevel_months_rule.mjs` | The final row-level months scoring rule (definite-correct / ambiguous / wrong; per-year halves; range answers wrong). Reads `reference_locked.csv` (override with `REFERENCE_CSV`) and writes `months_rowlevel_scored.csv`. |
| `months_rowlevel_scored.csv` | Per-row months verdicts for all 245 enumerated rows (no reference values included). |
| `build_glmm_rowlevel_data.mjs` | Builds `test_glmm_data_rowlevel.csv` from the verdict table and the predictor columns in `test_glmm_data.csv`. |
| `test_glmm_data.csv` | Predictor columns (sentence properties, multi-year sampling flag) for the GLMM rows. Its `fail` column holds the superseded study-level verdict and is overwritten by the build script. |
| `test_glmm_data_rowlevel.csv` | GLMM input: 118 row-level scoreable rows from 13 test papers, with `fail` (definitely wrong) and `fail_strict` (wrong or ambiguous). |
| `glmm_R_rowlevel.R` | The mixed-effects logistic regression (lme4). Run from the repository root; writes `glmm_R_rowlevel_results.txt`. |
| `glmm_R_rowlevel_results.txt` | Model output (coefficients, likelihood-ratio tests, ICC). |
| `agreement_stats_20260823.js` | Cohen's kappa and percentage agreement for the categorical fields, computed on rows with an unambiguous reference counterpart. Reads `test_scored_final.csv` and the reference export (override with `REFERENCE_MD`). |
| `export_reference_csv.mjs` | Exports the reference snapshot `reference_locked.csv` from a markdown conversion of the lab's xlsx (override with `REFERENCE_MD`). |
| `figures/` | Figure sources (`*.svg`) and rendered PNGs used by the thesis. |

## Reproduction notes

1. **The reference database is not public.** It is curated by the Biodiversity Futures Lab and is available from the research group on request. To re-run scoring, export the `data_extraction` sheet of the lab's xlsx to markdown and save it as `reference_data_extraction.md` (or set `REFERENCE_MD`), then run `export_reference_csv.mjs` to produce `reference_locked.csv`.
2. **API key.** `extraction_script_v4.R` reads the key from the `OPENAI_API_KEY` environment variable; no credentials are stored in this repository.
3. **R scripts** (`glmm_R_rowlevel.R`, `extraction_script_v4.R`) are run from the repository root. They need R with the `lme4`, `readr`, `dplyr`, `stringr`, `stringi`, `httr`, `jsonlite` and `pdftools` packages.
4. **The bun scripts** (`*.mjs`) require bun (tested with 1.3.x).
5. **Which number comes from where.** Country 100% and location 95% come from `rescore_verification_20260823.js`; months 4.2% (5/118), its 20.3% upper bound and the 23.0% lenient comparison come from `rowlevel_months_rule.mjs`; taxon 72.7% (mapping) and metric 82.7% come from the taxon and metric scoring in `score_final_authoritative.py` (columns `taxon_gt`, `t_s`, `b_s` in `test_scored_final.csv`); the kappa values come from `agreement_stats_20260823.js`; the regression results come from `glmm_R_rowlevel.R`.

The thesis itself is available from the author on request.
