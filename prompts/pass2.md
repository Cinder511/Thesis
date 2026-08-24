# Pass 2 prompt (per-effect-size field extraction)

## Developer message

You are an expert ecological data extractor. Extract precise per-effect-size fields. Return ONLY a valid JSON object. Never invent values: if not found, use "NA".

## User message

For each effect size listed below, extract its fields from the paper text.

Field rules:
- taxon_common: common name of the focal taxon for THIS effect size (Bees, Butterflies, Hoverflies, Spiders, Beetles, Bumblebees, etc.). If the paper only reports a functional role (e.g., natural enemies, beneficial insects, parasitoids), return that functional role name itself (e.g., "Natural enemies", "Parasitoids") instead of "NA" — it is still a valid taxon label for matching.
- taxon_scientific: scientific (Latin) name(s). List multiple separated by commas. If not given, "NA".
- bd_metric: controlled vocabulary — Abundance, Species Richness, Shannon Diversity, Simpson Diversity, Activity Density, Density, Egg Density, Visitation Rate, Other (details in parentheses).
- i_months_since_establishment: months between intervention ESTABLISHMENT (sowing/planting) and SAMPLING, FOR THIS SPECIFIC EFFECT SIZE. Priority:
  (a) explicit establishment date AND sampling date for this study -> compute the month difference. If establishment is given as a window (e.g. "between May and June"), use its START month. If sampling spanned a period (e.g. "May to September"), use the FIRST sampling month. Round 0.5 up.
  (b) a stated intervention age at the time of sampling (e.g. "2-year-old wildflower areas", "three-year study after sowing") -> age in years x 12;
  (c) a specific duration ("seven weeks after sowing") -> convert to months and round.
  CRITICAL rules:
  - Distinguish the INTERVENTION-to-SAMPLING interval from POLICY/MANAGEMENT durations. E.g., "maintained during two to six years" is how long strips are KEPT, NOT the time between establishment and sampling — do not use it as i_months.
  - If the paper reports only a RANGE of ages across sites (e.g. "age varied from <1 to 10 years") and you CANNOT determine the age relevant to THIS effect size's sampling event, return "NA". Do NOT take the range maximum. A wrong specific guess is worse than "NA".
  - Only return "NA" if no temporal information about establishment and sampling exists anywhere in the text.
- i_months_evidence: one verbatim sentence showing the establishment/sampling time used. NA if i_months is NA.
- extracted_quote: EXACT verbatim sentence from the text reporting THIS SPECIFIC effect size (its focal taxon + metric + outcome). CRITICAL: the quote must be UNIQUE to this effect size's focal taxon — do NOT reuse the same sentence for multiple different effect sizes. If you cannot find a sentence specific to this effect size's taxon/metric, return "NA" rather than reusing another effect size's quote. It must be a character-for-character substring of the provided text; do NOT paraphrase.
- species_count: "Single" if the quote concerns one taxonomic group, "Multiple" if several. Exactly one.
- sentence_length: "Short" if a simple sentence, "Long" if compound/complex with multiple clauses or commas. Exactly one.

Return JSON in EXACTLY this structure:
{
  "effects": [
    {"effect_id": "ES1", "taxon_common": "...", "taxon_scientific": "...", "bd_metric": "...", "i_months_since_establishment": "...", "i_months_evidence": "...", "extracted_quote": "...", "species_count": "Single", "sentence_length": "Long"},
    {"effect_id": "ES2", ...}
  ]
}

Effect sizes to extract:
[JSON array of the effect sizes enumerated in Pass 1]

Paper text:
[full paper text with section tags]
