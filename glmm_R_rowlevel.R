# ==============================================================================
#  Mixed-effects logistic regression - row-level scoring outcome (lme4)
# ==============================================================================
#  Run from the repository root. Requires lme4 and readr.
#  Input:  test_glmm_data_rowlevel.csv  (118 scorable rows, 14 studies)
#    fail        = 1 if the row-level verdict is "wrong" (PRIMARY outcome;
#                  94/118 = 79.7% failure; 24 non-failures across 6 studies)
#    fail_strict = 1 unless "definite-correct" (113/118 = 95.8%; only 5
#                  successes, all in one study, so a regression on it has
#                  nothing to explain - not modelled here)
#  Output: glmm_R_rowlevel_results.txt
# ==============================================================================

# ---- 0. packages ----
required <- c("lme4", "readr", "stats")
newp <- required[!(required %in% installed.packages()[, "Package"])]
if (length(newp)) install.packages(newp)
library(lme4)
library(readr)

# ---- 1. data ----
d <- read_csv("test_glmm_data_rowlevel.csv", show_col_types = FALSE)
d$gt_study <- factor(d$gt_study)
d$fail <- as.integer(d$fail)
d$fail_strict <- as.integer(d$fail_strict)

cat("N =", nrow(d), "| studies =", length(unique(d$gt_study)),
    "| failure rate (wrong) =", round(100 * mean(d$fail), 1), "%\n")
cat("strict failure rate (wrong or ambiguous) =", round(100 * mean(d$fail_strict), 1), "%\n\n")

# ---- 2. primary model: definitely wrong ----
m_glmer <- glmer(fail ~ species_Multiple + sentence_Long + multi_sampling + (1 | gt_study),
                 family = binomial, data = d,
                 control = glmerControl(optimizer = "bobyqa"))
cat("========== MIXED-EFFECTS (glmer, fail = wrong) ==========\n")
print(round(summary(m_glmer)$coefficients, 4))
cat("\n")

# ---- 3. likelihood-ratio tests for each predictor ----
cat("========== LIKELIHOOD-RATIO TESTS (drop1) ==========\n")
print(drop1(m_glmer, test = "Chisq"))
cat("\n")

# ---- 4. random intercept variance and approximate ICC ----
vc <- as.data.frame(VarCorr(m_glmer))
sigma2_study <- vc$vcov[1]
icc <- sigma2_study / (sigma2_study + pi^2 / 3)
cat("Random intercept variance =", round(sigma2_study, 4), "\n")
cat("Approximate ICC =", round(icc, 4), "\n\n")

# ---- 5. per-study failure table ----
cat("========== PER-STUDY FAILURE (wrong) ==========\n")
print(table(gt_study = d$gt_study, fail = d$fail))

# ---- 6. save everything ----
sink("glmm_R_rowlevel_results.txt")
cat("N =", nrow(d), "| studies =", length(unique(d$gt_study)),
    "| failure rate (wrong) =", round(100 * mean(d$fail), 1), "%\n")
cat("strict failure rate (wrong or ambiguous) =", round(100 * mean(d$fail_strict), 1), "%\n\n")
cat("========== MIXED-EFFECTS (glmer, fail = wrong) ==========\n")
print(round(summary(m_glmer)$coefficients, 4))
cat("\n========== LIKELIHOOD-RATIO TESTS (drop1) ==========\n")
print(drop1(m_glmer, test = "Chisq"))
cat("\nRandom intercept variance =", round(sigma2_study, 4),
    "\nApproximate ICC =", round(icc, 4), "\n\n")
cat("========== PER-STUDY FAILURE (wrong) ==========\n")
print(table(gt_study = d$gt_study, fail = d$fail))
sink()
cat("\nResults saved to glmm_R_rowlevel_results.txt\n")
