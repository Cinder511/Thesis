"""AUTHORITATIVE scoring for the test set — final version, single source of truth.
Fixes over earlier versions:
  1. i_months: STRICT rule (range '>24' -> wrong; per-year '14 (2012), 26 (2013)' -> precise hit)
  2. taxon: complete mapping of AI free-text to GT controlled vocabulary,
     including lacewings->insects, specific spiders->spiders, bugs->bugs, etc.
     Rows whose taxon genuinely has no GT equivalent (plants, birds, mites, functional
     groups) are flagged 'no_gt_vocab', NOT counted as wrong.
  3. country/location: study-level containment + granularity matching.
Output: test_scored_final.csv  (the file to attach / cite in the thesis)
"""
import pandas as pd, sys, re, unicodedata, warnings
warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = '.'  # run from the repository root
ai = pd.read_csv(ROOT + '/AI_effect_level_test_20_complete.csv')
gt = pd.read_excel(ROOT + '/extracted_data_2026-06-17.xlsx', sheet_name='data_extraction', header=1)
gt = gt[gt['study_ID'].notna() & (gt['study_ID'].astype(str).str.strip() != '')]
mp = pd.read_csv(ROOT + '/final_mapping_with_meta.csv')

def nfc(s): return unicodedata.normalize('NFC', str(s))
mp['file_nfc'] = mp['file'].map(nfc)
ai['file_nfc'] = ai['file_name'].map(nfc)
ai = ai.merge(mp[['file_nfc', 'gt_study']], on='file_nfc', how='left')
n_missing = ai['gt_study'].isna().sum()
ai = ai.dropna(subset=['gt_study'])
print(f'rows with missing mapping (should be 0): {n_missing} | kept {len(ai)} rows / {ai["file_name"].nunique()} files')

gt_studies = gt.drop_duplicates('study_ID')
sid2loc = dict(zip(gt_studies['study_ID'], gt_studies['location']))
sid2country = dict(zip(gt_studies['study_ID'], gt_studies['country']))

# ============================================================
# country / location (study-level)
# ============================================================
def norm(s):
    if pd.isna(s): return ''
    return re.sub(r'[^a-z0-9]+', ' ', str(s).lower()).strip()

def country_match(av, gv):
    a = norm(av)
    if not a: return 'AI_NA'
    parts = re.split(r'\s*-\s*', str(gv))
    g_main = norm(parts[0]) if parts else ''
    g_sub = norm(parts[-1]) if len(parts) > 1 else ''
    if not g_main: return 'GT_NA'
    alias = {'usa': 'united states', 'united states of america': 'united states',
             'us': 'united states', 'uk': 'united kingdom', 'great britain': 'united kingdom'}
    a = alias.get(a, a); g_main = alias.get(g_main, g_main)
    if a == g_main: return 'correct'
    if g_sub and a in (g_main, g_sub): return 'correct'
    return 'wrong'

def loc_match(av, gv):
    a, g = norm(av), norm(str(gv) if pd.notna(gv) else '')
    if not a: return 'AI_NA'
    if not g: return 'GT_NA'
    if a == g or a in g or g in a: return 'exact'
    at, gt_ = set(a.split()), set(g.split())
    if {t for t in (at & gt_) if len(t) >= 3}: return 'exact'
    if len(at) <= 2 and a not in ('england', 'scotland'): return 'partial'
    if a in ('england', 'scotland', 'wales'): return 'partial'
    return 'wrong'

by_study = ai.drop_duplicates('file_nfc').copy()
by_study['country_s'] = by_study.apply(
    lambda r: country_match(r['country'], sid2country.get(r['gt_study'])), axis=1)
by_study['location_s'] = by_study.apply(
    lambda r: loc_match(r['location'], sid2loc.get(r['gt_study'])), axis=1)

# ============================================================
# i_months: strict rule
# ============================================================
def parse_gt_months(v):
    if pd.isna(v): return set()
    s = str(v).strip()
    if s.lower() in ('na', 'n/a', ''): return set()
    m = re.match(r'^([<>~]?)\s*([\d.]+)\s*(?:[-–—~to]+\s*([\d.]+))?$', s)
    if not m:
        try: return {int(round(float(s)))}
        except: return set()
    op, lo = m.group(1), float(m.group(2))
    hi = float(m.group(3)) if m.group(3) else None
    if hi is not None: return set(range(int(lo), int(hi) + 1))
    if op == '<': return set(range(0, int(lo)))
    if op == '>': return set(range(int(lo), int(lo) * 3 + 1))
    return {int(round(lo))}

gt_months = {sid: set().union(*[parse_gt_months(v) for v in grp['i_months_since_establishment']])
             for sid, grp in gt.groupby('study_ID')}

def score_m(v, sid):
    if pd.isna(v) or str(v).strip().lower() in ('na', 'n/a', ''): return 'AI_NA'
    s = str(v).strip()
    if re.match(r'^>\s*\d+$', s): return 'wrong'          # range -> strict wrong
    if re.fullmatch(r'\d+(\.\d+)?', s):
        cand = {int(round(float(s)))}
    else:
        nums = re.findall(r'\d+', s)                        # per-year values
        cand = {int(n) for n in nums} if nums else set()
    if not cand: return 'AI_NA'
    g = gt_months.get(sid, set())
    if not g: return 'GT_NA'
    return 'correct' if (cand & g) else 'wrong'

ai['m_s'] = ai.apply(lambda r: score_m(r['i_months_since_establishment'], r['gt_study']), axis=1)

# ============================================================
# bd_metric
# ============================================================
BD = {'Abundance': 'abundance', 'Density': 'density', 'Activity Density': 'activity-density',
      'Species Richness': 'species richness', 'Shannon Diversity': 'diversity index',
      'Simpson Diversity': 'diversity index', 'Visitation Rate': 'capture/visitation rate',
      'Egg Density': 'density'}
ai['bd_g'] = ai['bd_metric'].map(lambda x: BD.get(x) if isinstance(x, str) else None)
ai['bd_other'] = ai['bd_metric'].astype(str).str.startswith('Other')
gt_bd = gt.groupby('study_ID')['bd_metric'].apply(
    lambda s: set(s.dropna().astype(str).str.strip().str.lower())).to_dict()

def score_bd(r):
    if r['bd_other']: return 'other_free_text'
    b = r['bd_g']
    if b is None: return 'unmapped'
    g = gt_bd.get(r['gt_study'], set())
    if not g: return 'GT_NA'
    return 'correct' if b in g else 'wrong'

ai['b_s'] = ai.apply(score_bd, axis=1)

# ============================================================
# taxon: complete mapping
# ============================================================
TAXON = {
    # spiders (all araneae)
    'Spiders': 'spiders', 'Plant-dwelling spiders': 'spiders', 'Ground-dwelling spiders': 'spiders',
    'Small spiders': 'spiders', 'Large spiders': 'spiders', 'Ground-hunting spiders': 'spiders',
    'Sheet-web spiders': 'spiders', 'Jumping spiders': 'spiders', 'Juvenile spiders': 'spiders',
    'Adult spiders': 'spiders', 'Stalker spiders': 'spiders', 'Ambusher spiders': 'spiders',
    'Space-web-building spiders': 'spiders', 'Orb-weaving spiders': 'spiders',
    # bees
    'Bees': 'bees', 'Wild bees': 'bees', 'Bumblebees': 'bees', 'Native bees': 'bees',
    'Solitary bees': 'bees', 'Small Halictid bees': 'bees', 'Honeybees': 'bees',
    'Bees and butterflies': 'bees', 'Red List bees': 'bees', 'Red List wild bees': 'bees',
    'Andrenid bees': 'bees', 'Eusocial bees': 'bees', 'Megachilid bees': 'bees',
    'Non-kleptoparasitic Halictidae': 'bees', 'Kleptoparasitic Halictidae': 'bees',
    'Non-kleptoparasitic halictid bees': 'bees',
    # flies - hoverflies
    'Hoverflies': 'flies - hoverflies', 'Aphidophagous syrphids': 'flies - hoverflies',
    'Syrphid flies': 'flies - hoverflies', 'Aphidophagous hoverflies': 'flies - hoverflies',
    # flies - other
    'Cabbage root fly': 'flies - other flies', 'Flies': 'flies - other flies',
    # bugs
    'True bugs': 'bugs', 'Predatory bugs': 'bugs', 'Predatory bug nymphs': 'bugs',
    'Insidious flower bug': 'bugs', 'Insidious flower bugs': 'bugs',
    'Predacious Heteroptera': 'bugs', 'Phytophagous Heteroptera': 'bugs',
    'Leafhoppers and treehoppers': 'bugs', 'Planthoppers': 'bugs',
    # beetles generic
    'Beetles': 'beetles', 'Staphylinid beetles': 'beetles - other beetles',
    'Rove beetles': 'beetles - other beetles', 'Ladybirds': 'beetles - other beetles',
    'Ladybeetles': 'beetles - other beetles', 'Polyphagous ladybirds': 'beetles - other beetles',
    'Predatory ladybirds': 'beetles - other beetles', 'Coccinellids': 'beetles - other beetles',
    'Coccinellid beetles': 'beetles - other beetles', 'Aphidophagous coccinellids': 'beetles - other beetles',
    'Fruit weevils, Pod midges': 'beetles - other beetles', 'Predacious beetles': 'beetles - other beetles',
    'Herbivorous beetles': 'beetles - other beetles',
    # ground beetles
    'Carabid beetles': 'beetles - ground beetles', 'Ground beetles': 'beetles - ground beetles',
    'Carnivorous ground beetles': 'beetles - ground beetles',
    'Small carabid beetles': 'beetles - ground beetles', 'Omnivorous carabid beetles': 'beetles - ground beetles',
    # aphids
    'Aphids': 'aphids', 'Soybean aphid': 'aphids', 'Cereal aphids': 'aphids',
    'Milkweed-oleander aphid': 'aphids', 'Green apple aphids': 'aphids',
    'Woolly apple aphid': 'aphids', 'Pest aphids': 'aphids',
    # butterflies
    'Butterflies': 'butterflies', 'Host-plant specialist butterflies': 'butterflies',
    'Host-plant generalist butterflies': 'butterflies', 'Red-listed butterflies': 'butterflies',
    # orthoptera
    'Orthoptera': 'orthoptera', 'Crickets and grasshoppers': 'orthoptera',
    'Grasshoppers': 'orthoptera', "Roesel's bush-cricket": 'orthoptera',
    # wasps
    'Solitary wasps': 'wasps', 'Parasitoid wasps': 'wasps',
    'Chalcid wasps': 'wasps', 'Ichneumonid wasps': 'wasps', 'Wasps': 'wasps',
    'Predatory wasps': 'wasps',
    # insects (lacewings = Neuroptera -> insects, ants -> insects, wild insects)
    'Insects': 'insects', 'Green lacewings': 'insects', 'Common green lacewings': 'insects',
    'Brown lacewings': 'insects', 'Lacewings': 'insects', 'Black garden ants': 'insects',
    'Wild insects': 'insects', 'Canopy insects': 'insects',
    # invertebrates (sampling-method descriptors naming invertebrates)
    'Invertebrates': 'invertebrates', 'General invertebrates': 'invertebrates',
    'Predatory arthropods': 'arthropods', 'Arthropods': 'arthropods',
    'Canopy-dwelling invertebrates': 'invertebrates', 'Soil-core invertebrates': 'invertebrates',
    'Canopy active invertebrates': 'invertebrates', 'Soil-surface invertebrates': 'invertebrates',
    'Soil surface active invertebrates': 'invertebrates',
    # mammals
    'Small mammals': 'mammals', 'Common hamster': 'mammals',
}
# no GT equivalent (plants, birds, mites, moths, functional groups, pests, pollinators)
NO_GT = {
    'Highbush blueberry', 'Apple trees', 'Cider apple', 'Flowering plants', 'Plants',
    'Vascular plants', 'Flowering dicotyledon plants', 'Flowering forbs',
    'Flowering dicot plants', 'Native perennial wildflowers', 'Declining arable plants',
    'Phytoseiid mites', 'Spider mites', 'Stigmaeid mites', 'Tydeid mites',
    'Birds', 'Farmland birds', 'Barn Owls',
    'Leafminer moth', 'Summer fruit tortrix moth', 'Codling moth',
    'Natural enemies', 'Aphidophagous natural enemies', 'Non-aphidophagous natural enemies',
    'Arthropod predators', 'Parasitoids', 'Eulophid parasitoids',
    'Cabbage insect pests', 'Insect pests', 'Wild pollinators',
}

def taxon_status(t):
    if pd.isna(t) or str(t).strip() in ('NA', 'nan', ''): return 'AI_NA'
    if TAXON.get(t): return 'mapped'
    if t in NO_GT: return 'no_gt_vocab'
    return 'UNMAPPED'

ai['taxon_gt'] = ai['taxon_common'].map(TAXON)
ai['t_s'] = ai['taxon_common'].map(taxon_status)

# ============================================================
# Assemble final output
# ============================================================
out = ai[['file_nfc', 'file_name', 'gt_study', 'effect_id', 'country', 'location', 'taxon_common',
          'taxon_gt', 't_s', 'bd_metric', 'b_s', 'i_months_since_establishment', 'm_s',
          'i_months_evidence', 'extracted_quote', 'species_count', 'sentence_length']].copy()
out = out.merge(by_study[['file_nfc', 'country_s', 'location_s']], on='file_nfc', how='left')
out.to_csv(ROOT + '/test_scored_final.csv', index=False)

# ============================================================
# Report
# ============================================================
print('=' * 64)
print('AUTHORITATIVE TEST-SET SCORING')
print('=' * 64)
print('country (study):', by_study['country_s'].value_counts().to_dict())
c = (by_study['country_s'] == 'correct').sum()
print(f'  -> acc = {100*c/len(by_study):.1f}%')
lv = by_study['location_s'].value_counts()
print('location (study):', lv.to_dict())
print(f'  -> exact+partial = {100*(lv.get("exact",0)+lv.get("partial",0))/len(by_study):.1f}%')
print()
print('i_months:', ai['m_s'].value_counts().to_dict())
cm = (ai['m_s'] == 'correct').sum(); wm = (ai['m_s'] == 'wrong').sum()
print(f'  -> acc(excl NA/GT_NA) = {100*cm/(cm+wm):.1f}%  ({cm}/{cm+wm})')
print()
print('bd_metric:', ai['b_s'].value_counts().to_dict())
cb = (ai['b_s'] == 'correct').sum(); wb = (ai['b_s'] == 'wrong').sum()
print(f'  -> acc(comparable subset) = {100*cb/(cb+wb):.1f}%')
print()
print('taxon:', ai['t_s'].value_counts().to_dict())
print(f'  -> mapped = {(ai["t_s"]=="mapped").sum()}/{len(ai)} = {100*(ai["t_s"]=="mapped").sum()/len(ai):.1f}%')
print(f'  -> no_gt_vocab (not errors) = {(ai["t_s"]=="no_gt_vocab").sum()} | UNMAPPED left = {(ai["t_s"]=="UNMAPPED").sum()}')
print()
print('saved: test_scored_final.csv')
