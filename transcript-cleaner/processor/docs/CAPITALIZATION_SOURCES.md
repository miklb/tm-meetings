# Standard Proper Noun Sources

This document lists the authoritative sources for standard capitalization rules.

## Public Domain / Government Sources

### 1. Countries & Nationalities

**Source**: ISO 3166-1 (International Organization for Standardization)

- **URL**: https://www.iso.org/iso-3166-country-codes.html
- **License**: Publicly available standard
- **Download**: https://github.com/datasets/country-codes (Open Data Commons)
- **File**: `country-codes.csv` from UN Statistics Division

**Alternative**: UN Member States List

- **URL**: https://www.un.org/en/about-us/member-states
- **License**: Public domain (UN data)

### 2. US States & Territories

**Source**: US Census Bureau

- **URL**: https://www.census.gov/library/reference/code-lists/ansi.html
- **License**: US Government work (public domain)
- **File**: ANSI INCITS 38:2009 codes

**Alternative**: USPS Official Abbreviations

- **URL**: https://pe.usps.com/text/pub28/28apb.htm
- **License**: US Government work (public domain)

### 3. Federal Holidays

**Source**: US Office of Personnel Management (OPM)

- **URL**: https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/
- **License**: US Government work (public domain)
- **List**: New Year's Day, MLK Day, Presidents Day, Memorial Day, Independence Day, Labor Day, Columbus Day, Veterans Day, Thanksgiving, Christmas

### 4. Geographic Names (Tampa Area)

**Source**: US Geological Survey (USGS) Geographic Names Information System (GNIS)

- **URL**: https://www.usgs.gov/tools/geographic-names-information-system-gnis
- **Query**: Hillsborough County, Florida
- **License**: US Government work (public domain)
- **Download**: https://geonames.usgs.gov/domestic/download_data.htm

**Specific features**:

- MacDill Air Force Base (Feature ID: 294492)
- Hillsborough River (Feature ID: 283806)
- Ybor City (populated place)
- Tampa Bay (bay)

### 5. Military Installations

**Source**: US Department of Defense

- **URL**: https://www.defense.gov/Our-Story/Our-Forces/
- **License**: US Government work (public domain)
- **MacDill AFB**: https://www.macdill.af.mil/

### 6. Military Awards & Decorations

**Source**: Institute of Heraldry, US Army

- **URL**: https://tioh.army.mil/Catalog/Awards
- **License**: US Government work (public domain)
- **List**: Medal of Honor, Purple Heart, Bronze Star, Silver Star, etc.

## Open Data Sources

### 7. Historical Events

**Source**: Library of Congress Subject Headings (LCSH)

- **URL**: https://id.loc.gov/authorities/subjects.html
- **License**: CC0 1.0 (public domain)
- **Search**: "World War" → https://id.loc.gov/authorities/subjects/sh85148273.html
- **Examples**:
  - World War, 1939-1945 (sh85148273)
  - Vietnam War, 1961-1975 (sh85143277)
  - United States--History--Civil War, 1861-1865 (sh85026421)

### 8. Ethnic & Racial Designations

**Source**: US Census Bureau Race & Ethnicity Categories

- **URL**: https://www.census.gov/topics/population/race/about.html
- **License**: US Government work (public domain)
- **Categories**: White, Black or African American, Asian, Native American, Hispanic or Latino, etc.

**Alternative**: OMB Statistical Policy Directive 15

- **URL**: https://www.govinfo.gov/content/pkg/FR-1997-10-30/pdf/97-28653.pdf
- **License**: US Government work

### 9. Religious Terms

**Source**: Library of Congress Religion Subject Headings

- **URL**: https://www.loc.gov/aba/publications/FreeLCSH/freelcsh.html
- **License**: Public domain
- **Download**: https://id.loc.gov/authorities/subjects.html

**Examples**:

- Christianity (sh85025082)
- Islam (sh85068390)
- Judaism (sh85070848)
- God (sh85055559)

## Pre-trained Model Knowledge (Already Trained)

### 10. spaCy Named Entity Recognition

**Source**: spaCy `en_core_web_sm` model

- **URL**: https://spacy.io/models/en#en_core_web_sm
- **Training Data**: OntoNotes 5 corpus
  - **URL**: https://catalog.ldc.upenn.edu/LDC2013T19
  - **License**: LDC User Agreement (academic use)
  - **Contains**: News articles, web text, broadcast conversation

**What it knows**:

- GPE (Geopolitical entities): Countries, cities, states
- PERSON: Individual names
- ORG: Organizations
- EVENT: Named events (World War II, etc.)
- DATE: Days, months, holidays

**Installation**:

```bash
pip install spacy
python -m spacy download en_core_web_sm
```

### 11. DBpedia / Wikidata (Optional - for comprehensive coverage)

**Source**: DBpedia Ontology

- **URL**: https://www.dbpedia.org/resources/ontology/
- **License**: CC BY-SA 3.0 & GFDL
- **SPARQL Endpoint**: https://dbpedia.org/sparql
- **Download**: https://databus.dbpedia.org/dbpedia/collections/latest-core

**Wikidata Alternative**:

- **URL**: https://www.wikidata.org/
- **License**: CC0 (public domain)
- **SPARQL**: https://query.wikidata.org/
- **Example Query**: Get all countries
  ```sparql
  SELECT ?country ?countryLabel WHERE {
    ?country wdt:P31 wd:Q6256.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }
  ```

## Implementation Strategy

### Phase 1: Static Lists (Immediate)

Download and parse:

1. ISO 3166 country codes (CSV)
2. US Census state names (text list)
3. OPM federal holidays (scrape from official page)
4. USGS GNIS Tampa features (download database subset)

### Phase 2: spaCy NER (Recommended)

Use pre-trained `en_core_web_sm` model:

- Already trained on millions of documents
- Knows common proper nouns (countries, people, organizations)
- Fast inference (CPU-friendly)
- No custom training needed

### Phase 3: Domain-Specific (Your Data)

Build from your agendas:

- Tampa officials (from agenda JSON)
- Local organizations (from agenda JSON)
- Speaker names (from scraped transcripts)
- Frequency-weighted confidence scores

## Scripts to Create

1. `download_iso_countries.py` - Fetch ISO 3166 data
2. `download_gnis_tampa.py` - Fetch USGS geographic names
3. `build_standard_entities.py` - Combine all sources into single database
4. `test_spacy_entities.py` - Test spaCy on your problematic cases

## Verification

Each source should include:

- ✅ URL to authoritative source
- ✅ License/usage terms
- ✅ Download/access method
- ✅ Last updated date
- ✅ Verification script to check source is still valid

---

**Next Steps**:

1. Review these sources - are they acceptable?
2. Which sources do you want to prioritize?
3. Should I create download scripts for the government data sources?
