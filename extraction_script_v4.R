# ==============================================================================
#  AI extraction script v4 - two-pass, per-effect-size extraction
# ==============================================================================
#  Pass 1 enumerates the effect sizes a paper reports and extracts file-level
#  fields (country, location). Pass 2 extracts per-effect-size fields in batches.
#  The train/test assignment is read from train_test_split.csv. Run from the
#  repository root: the PDF folder and the split file are expected there.

# ==============================================================================
# 0. Network fixes (Windows proxy / IPv6 issues)
# ==============================================================================
library(httr)
httr::set_config(httr::config(ipresolve = 1L))
httr::set_config(httr::use_proxy(url = ""))
invisible(sapply(c("http_proxy", "https_proxy", "all_proxy",
                   "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"), Sys.unsetenv))

# ==============================================================================
# 1. Packages (auto-install if missing)
# ==============================================================================
required_packages <- c("pdftools", "httr", "jsonlite", "readr", "dplyr", "stringr", "stringi")
new_packages <- required_packages[!(required_packages %in% installed.packages()[, "Package"])]
if (length(new_packages)) install.packages(new_packages)
invisible(lapply(required_packages, library, character.only = TRUE))

# ==============================================================================
# 2. Settings - edit these
# ==============================================================================
Sys.setenv(OPENAI_API_KEY = Sys.getenv("OPENAI_API_KEY"))
if (nchar(Sys.getenv("OPENAI_API_KEY")) < 20) {
  stop("OPENAI_API_KEY environment variable not set. Run: Sys.setenv(OPENAI_API_KEY = 'your-key') in R, or set it in your system environment.")
}
model_id <- "gpt-5.6-sol"
if (grepl("REPLACE_WITH_YOUR_MODEL_ID", model_id, fixed = TRUE)) {
  stop("model identifier not set: edit model_id above")
}

# Run from the repository root; the PDF folder and split file are expected there.
work_dir <- getwd()
pdf_folder_path <- file.path(work_dir, "Dissertation_Literatures", "Pdfs_Literature")
split_csv_path <- file.path(work_dir, "train_test_split.csv")

dry_run <- FALSE          # TRUE = no API calls, just verify PDFs parse
run_mode <- "test"        # "train" or "test"
n_files <- Inf            # cap the number of files (useful while debugging)
max_effect_sizes <- 15    # Pass 1 cap on how many effect sizes to enumerate
batch_size <- 5           # Pass 2: effect sizes per API call

# cost estimate (USD per million tokens)
input_price_per_M  <- 5
output_price_per_M <- 30

output_dir <- work_dir
max_text_chars <- 60000
# very long docs (e.g. 238-page reports): skip TOC/front matter, start from Introduction/Abstract
use_smart_cut <- TRUE

# ==============================================================================
# 3. Text prep: strip references, tag sections, cap length
# ==============================================================================
prepare_text <- function(full_text) {
  cut_re <- "(?im)^\\s*(?:[0-9]+\\.?\\s*)?(references|literature cited|literatur|literaturverzeichnis|bibliography|literature)\\b"
  cut_pos <- stringr::str_locate_all(full_text, cut_re)[[1]]
  # only cut if references appears past the halfway point;
  # JSTOR cover pages start with "REFERENCES" and would otherwise truncate everything
  if (nrow(cut_pos) > 0) {
    threshold <- nchar(full_text) * 0.5
    cut_pos <- cut_pos[cut_pos[, 1] > threshold, , drop = FALSE]
  }
  if (nrow(cut_pos) > 0) {
    full_text <- substr(full_text, 1, cut_pos[1, 1] - 1)
  }
  # long reports: jump past the front matter to the body
  if (use_smart_cut && nchar(full_text) > max_text_chars * 1.5) {
    body_re <- "(?im)^\\s*(?:[0-9]+\\.?\\s*)?(introduction|abstract)\\b"
    body_pos <- stringr::str_locate_all(full_text, body_re)[[1]]
    # take the last occurrence (the first is usually in the TOC)
    if (nrow(body_pos) >= 2) {
      full_text <- substr(full_text, body_pos[nrow(body_pos), 1], nchar(full_text))
    }
  }
  if (nchar(full_text) > max_text_chars) {
    full_text <- substr(full_text, 1, max_text_chars)
  }
  n_all <- nchar(full_text)

  heading_re <- paste0(
    "(?im)^\\s*(?:[0-9]+\\.?\\s*)?(",
    "abstract|introduction|materials?\\s+(and|&)\\s+methods|methods|results|discussion",
    ")\\b"
  )
  loc <- stringr::str_locate_all(full_text, heading_re)[[1]]
  if (nrow(loc) == 0) return(list(text = full_text, n_tags = 0))

  lab <- tolower(stringr::str_extract(
    stringr::str_extract_all(full_text, heading_re)[[1]],
    "(abstract|introduction|methods|results|discussion)"))
  lab_map <- c(abstract = "[ABSTRACT]", introduction = "[INTRODUCTION]",
               methods = "[METHODS]", results = "[RESULTS]", discussion = "[DISCUSSION]")
  tags <- unname(lab_map[lab])
  # keep (position, tag) pairs together; insert from the END so earlier offsets stay valid
  ord <- order(loc[, 1], decreasing = TRUE)
  pos <- loc[ord, 1]
  tags <- tags[ord]

  for (k in seq_along(pos)) {
    full_text <- paste0(substr(full_text, 1, pos[k] - 1), "\n", tags[k], "\n",
                        substr(full_text, pos[k], nchar(full_text)))
  }
  list(text = full_text, n_tags = length(pos))
}

# ==============================================================================
# 4. DOI from PDF text via regex (free, no tokens spent)
# ==============================================================================
extract_doi_regex <- function(full_text) {
  m <- stringr::str_extract(full_text, "10\\.\\d{4,9}/[^\\s\\]\\)\\}]+")
  if (is.na(m)) return("NA")
  return(m)
}

# ==============================================================================
# 5. Generic API call (returns parsed JSON + token usage)
# ==============================================================================
call_api <- function(system_prompt, user_prompt, usage = TRUE) {
  messages <- list(
    list(role = "developer", content = system_prompt),
    list(role = "user", content = user_prompt)
  )
  req <- list(model = model_id, messages = messages,
              response_format = list(type = "json_object"))
  response <- httr::POST(
    url = "https://api.openai.com/v1/chat/completions",
    httr::add_headers(
      "Authorization" = paste("Bearer", Sys.getenv("OPENAI_API_KEY")),
      "Content-Type" = "application/json"
    ),
    body = jsonlite::toJSON(req, auto_unbox = TRUE),
    encode = "json"
  )
  if (httr::status_code(response) != 200) {
    message("   [failed] API HTTP ", httr::status_code(response), ": ",
            substr(httr::content(response, "text", encoding = "UTF-8"), 1, 300))
    return(list(ok = FALSE, parsed = NULL, usage = NULL, raw = NA_character_))
  }
  raw_content <- httr::content(response, "text", encoding = "UTF-8")
  res_json <- jsonlite::fromJSON(raw_content)
  content <- res_json$choices$message$content[[1]]
  clean <- trimws(gsub("^```(json)?\\s*|\\s*```$", "", content, perl = TRUE))
  parsed <- tryCatch(jsonlite::fromJSON(clean), error = function(e) NULL)
  usage <- res_json$usage
  if (is.null(usage)) usage <- list(prompt_tokens = NA, completion_tokens = NA)
  if (is.null(parsed)) {
    return(list(ok = FALSE, parsed = NULL, usage = usage, raw = content))
  }
  list(ok = TRUE, parsed = parsed, usage = usage, raw = content)
}

# ==============================================================================
# 6. Pass 1: enumerate effect sizes + file-level fields
# ==============================================================================
pass1_enumerate <- function(text) {
  sys <- paste0(
    'You are an expert ecological meta-analysis extractor. Given a scientific paper, ',
    'enumerate its effect sizes and extract file-level metadata.',
    'In ecological meta-analysis, ONE effect size = one comparison of an intervention ',
    '(e.g., flower strip) against a control (e.g., conventional field), for ONE taxonomic group, ',
    'measured with ONE biodiversity metric. The same paper can report many effect sizes.',
    'Return ONLY a valid JSON object, no markdown, no commentary.'
  )
  usr <- paste0(
    'Identify the effect sizes reported in this paper and extract file-level metadata.\n\n',
    'TASK A (file-level):\n',
    '1. country: standard country name of the study. Look in [ABSTRACT] then [METHODS]. "NA" if unclear.\n',
    '2. location: state/province/primary region only. "NA" if unclear.\n\n',
    'TASK B (effect-size enumeration):\n',
    'List the distinct effect sizes reported in the RESULTS. An effect size is a specific ',
    'quantitative comparison: intervention vs control, for a given taxon and a given metric. ',
    'Be rigorous and parsimonious: only list effect sizes that are explicitly reported with quantitative ',
    'outcomes (statistics, means, significant/non-significant comparisons). DO NOT invent effect sizes, ',
    'do NOT duplicate the same comparison under different labels just to reach a number. ',
    sprintf('List at most %d effect sizes. If fewer are reported, list fewer. ', max_effect_sizes),
    'Each item should have:\n',
    '  - effect_id: a short unique label like "ES1", "ES2", ...\n',
    '  - description: 1 sentence naming the intervention, control, taxon, and metric.\n\n',
    'Return JSON in EXACTLY this structure:\n',
    '{\n  "country": "...", "location": "...",\n  "effect_sizes": [\n    {"effect_id": "ES1", "description": "intervention X vs control Y, taxon Z, metric W"},\n    {"effect_id": "ES2", "description": "..."}\n  ]\n}\n\n',
    'Paper text:\n', text
  )
  call_api(sys, usr)
}

# ==============================================================================
# 7. Pass 2: per-effect-size fields, in batches
# ==============================================================================
pass2_extract_batch <- function(text, batch_effects) {
  sys <- paste0(
    'You are an expert ecological data extractor. Extract precise per-effect-size fields. ',
    'Return ONLY a valid JSON object. Never invent values: if not found, use "NA".'
  )
  batch_json <- jsonlite::toJSON(batch_effects, auto_unbox = TRUE)
  usr <- paste0(
    'For each effect size listed below, extract its fields from the paper text.\n\n',
    'Field rules:\n',
    '- taxon_common: common name of the focal taxon for THIS effect size (Bees, Butterflies, Hoverflies, Spiders, Beetles, Bumblebees, etc.). If the paper only reports a functional role (e.g., natural enemies, beneficial insects, parasitoids), return that functional role name itself (e.g., "Natural enemies", "Parasitoids") instead of "NA" — it is still a valid taxon label for matching.\n',
    '- taxon_scientific: scientific (Latin) name(s). List multiple separated by commas. If not given, "NA".\n',
    '- bd_metric: controlled vocabulary — Abundance, Species Richness, Shannon Diversity, Simpson Diversity, Activity Density, Density, Egg Density, Visitation Rate, Other (details in parentheses).\n',
    '- i_months_since_establishment: months between intervention ESTABLISHMENT (sowing/planting) and SAMPLING, FOR THIS SPECIFIC EFFECT SIZE. Priority:\n',
    '   (a) explicit establishment date AND sampling date for this study -> compute the month difference. If establishment is given as a window (e.g. "between May and June"), use its START month. If sampling spanned a period (e.g. "May to September"), use the FIRST sampling month. Round 0.5 up.\n',
    '   (b) a stated intervention age at the time of sampling (e.g. "2-year-old wildflower areas", "three-year study after sowing") -> age in years x 12;\n',
    '   (c) a specific duration ("seven weeks after sowing") -> convert to months and round.\n',
    '   CRITICAL rules:\n',
    '   - Distinguish the INTERVENTION-to-SAMPLING interval from POLICY/MANAGEMENT durations. E.g., "maintained during two to six years" is how long strips are KEPT, NOT the time between establishment and sampling — do not use it as i_months.\n',
    '   - If the paper reports only a RANGE of ages across sites (e.g. "age varied from <1 to 10 years") and you CANNOT determine the age relevant to THIS effect size\x27s sampling event, return "NA". Do NOT take the range maximum. A wrong specific guess is worse than "NA".\n',
    '   - Only return "NA" if no temporal information about establishment and sampling exists anywhere in the text.\n',
    '- i_months_evidence: one verbatim sentence showing the establishment/sampling time used. NA if i_months is NA.\n',
    '- extracted_quote: EXACT verbatim sentence from the text reporting THIS SPECIFIC effect size (its focal taxon + metric + outcome). CRITICAL: the quote must be UNIQUE to this effect size\x27s focal taxon — do NOT reuse the same sentence for multiple different effect sizes. If you cannot find a sentence specific to this effect size\x27s taxon/metric, return "NA" rather than reusing another effect size\x27s quote. It must be a character-for-character substring of the provided text; do NOT paraphrase.\n',
    '- species_count: "Single" if the quote concerns one taxonomic group, "Multiple" if several. Exactly one.\n',
    '- sentence_length: "Short" if a simple sentence, "Long" if compound/complex with multiple clauses or commas. Exactly one.\n\n',
    'Return JSON in EXACTLY this structure:\n',
    '{\n  "effects": [\n    {"effect_id": "ES1", "taxon_common": "...", "taxon_scientific": "...", "bd_metric": "...", "i_months_since_establishment": "...", "i_months_evidence": "...", "extracted_quote": "...", "species_count": "Single", "sentence_length": "Long"},\n    {"effect_id": "ES2", ...}\n  ]\n}\n\n',
    'Effect sizes to extract:\n', batch_json, '\n\n',
    'Paper text:\n', text
  )
  call_api(sys, usr)
}

# ==============================================================================
# 8. Quote matching with normalisation
# ==============================================================================
norm_for_match <- function(s) {
  if (is.null(s) || is.na(s) || !nzchar(s)) return("")
  s <- iconv(s, to = "ASCII//TRANSLIT", sub = "")
  gsub("[^A-Za-z0-9]", "", tolower(s))
}

# ==============================================================================
# 9. Main loop
# ==============================================================================
split_df <- readr::read_csv(split_csv_path, show_col_types = FALSE)
if (!"status" %in% names(split_df)) split_df$status <- "ok"
# pick files by run_mode; scanned/no-text PDFs are skipped either way
target_files <- split_df$file[split_df$role == run_mode & split_df$status == "ok"]
cat(sprintf("mode: %s | target %d | other split %d | skipped(scanned) %d\n",
            run_mode, length(target_files),
            sum(split_df$role != run_mode & split_df$status == "ok"),
            sum(split_df$status != "ok")))

# Unicode filename fix: the split CSV uses NFC, disk files may be NFD (Markó vs Markó).
# Build a name -> real-disk-name map so file.exists() doesn't wrongly fail.
disk_names <- list.files(pdf_folder_path, pattern = "\\.pdf$")
disk_map <- stats::setNames(disk_names, vapply(disk_names, function(nm) {
  tryCatch(stringi::stri_trans_nfc(nm), error = function(e) nm)
}, character(1)))
target_files <- unname(disk_map[stringi::stri_trans_nfc(target_files)])
target_files <- target_files[!is.na(target_files)]

if (is.finite(n_files)) target_files <- head(target_files, n_files)
cat(sprintf("processing %d papers (dry_run=%s)\n", length(target_files), dry_run))

results_list <- list()
tot_in <- tot_out <- 0
t_start_all <- Sys.time()

for (i in seq_along(target_files)) {
  fn <- target_files[i]
  pdf_path <- file.path(pdf_folder_path, fn)
  t0 <- Sys.time()
  cat(sprintf("\n[%d/%d] %s\n", i, length(target_files), substr(fn, 1, 55)))

  if (!file.exists(pdf_path)) {
    cat("   [skip] file missing\n"); next
  }
  raw_pdf <- pdftools::pdf_text(pdf_path)
  full_text <- paste(raw_pdf, collapse = "\n\n--- PAGE BREAK ---\n\n")
  doi_val <- extract_doi_regex(full_text)
  prep <- prepare_text(full_text)
  cat(sprintf("   doi=%s | text %d chars (raw %d) | tags %d\n",
              doi_val, nchar(prep$text), nchar(full_text), prep$n_tags))

  if (dry_run) {
    cat("   [dry-run] PDF loads fine, skipping API\n")
    next
  }

  # ---- Pass 1: enumerate ----
  r1 <- pass1_enumerate(prep$text)
  if (!r1$ok || is.null(r1$parsed$effect_sizes)) {
    cat("   [failed] Pass 1 enumeration\n")
    next
  }
  country <- ifelse(is.null(r1$parsed$country), "NA", r1$parsed$country)
  location <- ifelse(is.null(r1$parsed$location), "NA", r1$parsed$location)
  # count Pass 1 tokens in the cost estimate too
  tk_p1_in <- r1$usage$prompt_tokens; tk_p1_out <- r1$usage$completion_tokens
  if (is.null(tk_p1_in) || is.na(tk_p1_in)) tk_p1_in <- 0
  if (is.null(tk_p1_out) || is.na(tk_p1_out)) tk_p1_out <- 0
  tot_in <- tot_in + tk_p1_in; tot_out <- tot_out + tk_p1_out
  effs <- r1$parsed$effect_sizes
  if (is.data.frame(effs)) {
    effs <- split(effs, seq_len(nrow(effs)))
  } else if (length(effs) > 0 && !is.list(effs[[1]])) {
    # model returned a single effect size as an object, wrap it
    effs <- list(effs)
  }
  # enforce the enumeration cap (defensive: the model may return more than asked)
  if (length(effs) > max_effect_sizes) effs <- effs[seq_len(max_effect_sizes)]
  cat(sprintf("   Pass1: %d effect sizes | %s, %s | input=%s\n",
              length(effs), country, location,
              ifelse(is.null(r1$usage$prompt_tokens), "?", r1$usage$prompt_tokens)))

  # ---- Pass 2: batched per-effect-size extraction ----
  raw_dir <- file.path(output_dir, "raw_responses_v4")
  dir.create(raw_dir, showWarnings = FALSE)
  safe_name <- sub("\\.pdf$", "", fn)
  writeLines(r1$raw, file.path(raw_dir, paste0(safe_name, "__pass1.json")))

  batches <- split(effs, ceiling(seq_along(effs) / batch_size))
  for (b in seq_along(batches)) {
    r2 <- pass2_extract_batch(prep$text, batches[[b]])
    if (!r2$ok || is.null(r2$parsed$effects)) {
      cat(sprintf("   [failed] Pass2 batch %d\n", b))
      next
    }
    # save raw response per batch
    writeLines(r2$raw, file.path(raw_dir, paste0(safe_name, "__pass2_batch", b, ".json")))

    eff_rows <- r2$parsed$effects
    if (is.data.frame(eff_rows)) {
      eff_rows <- split(eff_rows, seq_len(nrow(eff_rows)))
    } else if (length(eff_rows) > 0 && !is.list(eff_rows[[1]])) {
      eff_rows <- list(eff_rows)
    }
    for (er in eff_rows) {
      eid <- ifelse(is.null(er$effect_id), NA, er$effect_id)
      q <- ifelse(is.null(er$extracted_quote), "NA", er$extracted_quote)
      row <- data.frame(
        file_name = fn, doi = doi_val, country = country, location = location,
        effect_id = eid,
        taxon_common = ifelse(is.null(er$taxon_common), "NA", er$taxon_common),
        taxon_scientific = ifelse(is.null(er$taxon_scientific), "NA", er$taxon_scientific),
        bd_metric = ifelse(is.null(er$bd_metric), "NA", er$bd_metric),
        i_months_since_establishment = ifelse(is.null(er$i_months_since_establishment), "NA", er$i_months_since_establishment),
        i_months_evidence = ifelse(is.null(er$i_months_evidence), "NA", er$i_months_evidence),
        extracted_quote = q,
        species_count = ifelse(is.null(er$species_count), "NA", er$species_count),
        sentence_length = ifelse(is.null(er$sentence_length), "NA", er$sentence_length),
        stringsAsFactors = FALSE
      )
      row$quote_exact <- if (is.na(q) || q == "NA") NA else grepl(q, full_text, fixed = TRUE)
      row$quote_approx <- if (is.na(q) || q == "NA" || nchar(norm_for_match(q)) < 30) {
        NA
      } else {
        grepl(norm_for_match(q), norm_for_match(full_text), fixed = TRUE)
      }
      row$input_tokens <- r2$usage$prompt_tokens
      row$output_tokens <- r2$usage$completion_tokens
      results_list[[length(results_list) + 1]] <- row
    }
    # accumulate token counts
    tk_i <- r2$usage$prompt_tokens; tk_o <- r2$usage$completion_tokens
    if (is.null(tk_i) || is.na(tk_i)) tk_i <- 0
    if (is.null(tk_o) || is.na(tk_o)) tk_o <- 0
    tot_in <- tot_in + tk_i; tot_out <- tot_out + tk_o
    cat(sprintf("   Pass2 batch %d: OK (%d effects)\n", b, length(eff_rows)))
  }

  cat(sprintf("   %.0f sec for this paper\n", as.numeric(difftime(Sys.time(), t0, units = "secs"))))
}

# ==============================================================================
# 10. Save results
# ==============================================================================
if (length(results_list) > 0) {
  final_df <- dplyr::bind_rows(results_list)
  stamp <- format(Sys.time(), "%Y%m%d_%H%M")
  out_csv <- file.path(output_dir, sprintf("AI_effect_level_%s_%d_files_%s.csv", run_mode, length(unique(final_df$file_name)), stamp))
  readr::write_csv(final_df, out_csv)
  est_cost <- tot_in / 1e6 * input_price_per_M + tot_out / 1e6 * output_price_per_M
  cat("\n====================================================\n")
  cat("Done!\n")
  cat("papers:", length(unique(final_df$file_name)), "| effect-size rows:", nrow(final_df), "\n")
  cat("input tokens:", tot_in, "| output tokens:", tot_out, "\n")
  cat(sprintf("est. cost: $%.2f | total %.0f sec\n", est_cost,
              as.numeric(difftime(Sys.time(), t_start_all, units = "secs"))))
  cat("saved to:", out_csv, "\n")
  cat("====================================================\n")
} else {
  cat("nothing extracted (dry_run or all failed).\n")
}
