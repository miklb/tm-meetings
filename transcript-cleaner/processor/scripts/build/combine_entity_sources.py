#!/usr/bin/env python3
"""
Build comprehensive standard entity database from all authoritative sources.

This combines:
1. ISO 3166 countries
2. US states and territories  
3. Federal holidays
4. Tampa geographic features
5. Historical events and figures
6. Religious terms

All sources are documented in docs/CAPITALIZATION_SOURCES.md
"""

import json
from pathlib import Path
from datetime import datetime

# Input files from download scripts
DATA_DIR = Path(__file__).parent / "data"
OUTPUT_FILE = DATA_DIR / "standard_entities.json"

def load_json_safe(filepath):
    """Load JSON file if it exists, return None otherwise."""
    if filepath.exists():
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None

def build_standard_entities():
    """Combine all downloaded entity sources."""
    
    print("Building comprehensive standard entity database...")
    print("=" * 60)
    
    entities = {
        'countries': set(),
        'us_states': set(),
        'holidays': set(),
        'tampa_features': set(),
        'historical_events': set(),
        'historical_figures': set(),
        'ethnic_racial_terms': set(),
        'religious_terms': set(),
    }
    
    sources_used = []
    
    # 1. Countries
    countries_file = DATA_DIR / "iso_countries.json"
    countries_data = load_json_safe(countries_file)
    if countries_data:
        entities['countries'].update(countries_data['country_names'])
        sources_used.append({
            'category': 'countries',
            'source': countries_data['source'],
            'count': len(countries_data['country_names']),
            'file': str(countries_file)
        })
        print(f"✓ Loaded {len(countries_data['country_names'])} countries")
    else:
        print(f"⚠ Missing {countries_file} - run download_iso_countries.py")
    
    # 2. US States
    states_file = DATA_DIR / "us_states.json"
    states_data = load_json_safe(states_file)
    if states_data:
        entities['us_states'].update(states_data['all_names'])
        sources_used.append({
            'category': 'us_states',
            'source': states_data['source'],
            'count': len(states_data['all_names']),
            'file': str(states_file)
        })
        print(f"✓ Loaded {len(states_data['all_names'])} US states/territories")
    else:
        print(f"⚠ Missing {states_file} - run download_us_states.py")
    
    # 3. Holidays
    holidays_file = DATA_DIR / "federal_holidays.json"
    holidays_data = load_json_safe(holidays_file)
    if holidays_data:
        entities['holidays'].update(holidays_data['all_holiday_names'])
        sources_used.append({
            'category': 'holidays',
            'source': holidays_data['source'],
            'count': len(holidays_data['all_holiday_names']),
            'file': str(holidays_file)
        })
        print(f"✓ Loaded {len(holidays_data['all_holiday_names'])} holidays")
    else:
        print(f"⚠ Missing {holidays_file} - run download_federal_holidays.py")
    
    # 4. Tampa features
    tampa_file = DATA_DIR / "tampa_features.json"
    tampa_data = load_json_safe(tampa_file)
    if tampa_data:
        entities['tampa_features'].update(tampa_data['feature_names'])
        sources_used.append({
            'category': 'tampa_features',
            'source': tampa_data['source'],
            'count': len(tampa_data['feature_names']),
            'file': str(tampa_file)
        })
        print(f"✓ Loaded {len(tampa_data['feature_names'])} Tampa features")
    else:
        print(f"⚠ Missing {tampa_file} - run download_tampa_features.py")
    
    # 5. Historical terms
    history_file = DATA_DIR / "historical_terms.json"
    history_data = load_json_safe(history_file)
    if history_data:
        # Use all_terms which includes events, figures, ethnic terms, AND last names
        entities['historical_events'].update(history_data['event_names'])
        entities['historical_figures'].update(history_data['historical_figures'])
        entities['ethnic_racial_terms'].update(history_data['ethnic_racial_terms'])
        # Also add all last names as standalone entities
        if 'historical_figure_last_names' in history_data:
            entities['historical_figures'].update(history_data['historical_figure_last_names'].keys())
        sources_used.append({
            'category': 'historical_terms',
            'source': history_data['source'],
            'count': len(history_data['all_terms']),
            'file': str(history_file)
        })
        print(f"✓ Loaded {len(history_data['all_terms'])} historical terms")
    else:
        print(f"⚠ Missing {history_file} - run download_historical_terms.py")
    
    # 6. Religious terms
    religion_file = DATA_DIR / "religious_terms.json"
    religion_data = load_json_safe(religion_file)
    if religion_data:
        entities['religious_terms'].update(religion_data['all_terms'])
        sources_used.append({
            'category': 'religious_terms',
            'source': religion_data['source'],
            'count': len(religion_data['all_terms']),
            'file': str(religion_file)
        })
        print(f"✓ Loaded {len(religion_data['all_terms'])} religious terms")
    else:
        print(f"⚠ Missing {religion_file} - run download_religious_terms.py")
    
    # Combine all entities
    all_entities = set()
    for category, terms in entities.items():
        all_entities.update(terms)
    
    # Add common time terms (not proper nouns but always capitalized)
    days_months = [
        'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ]
    entities['days_months'] = set(days_months)
    all_entities.update(days_months)
    
    # Common acronyms that should be uppercase
    acronyms = [
        'Q&A', 'USA', 'US', 'UK', 'FBI', 'CIA', 'NASA', 'NATO',
        'UN', 'EU', 'WWII', 'WWI', 'PhD', 'MD', 'CEO', 'CFO',
        'CRA', 'DRC', 'TPD'  # Tampa-specific acronyms
    ]
    entities['acronyms'] = set(acronyms)
    all_entities.update(acronyms)
    
    # Special rules
    special_rules = {
        'always_uppercase': ['I'],  # pronoun
        'always_lowercase': ['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'from', 'by', 'of', 'in']
    }
    
    # Convert sets to sorted lists for JSON
    entities_serializable = {k: sorted(v) for k, v in entities.items()}
    
    # Build output
    output_data = {
        'metadata': {
            'created': datetime.now().isoformat(),
            'description': 'Comprehensive standard entity database from authoritative sources',
            'documentation': 'See docs/CAPITALIZATION_SOURCES.md for source details',
            'total_entities': len(all_entities),
        },
        'sources': sources_used,
        'entities': entities_serializable,
        'special_rules': special_rules,
        'all_entities': sorted(all_entities)
    }
    
    # Save
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print("\n" + "=" * 60)
    print(f"✓ Saved comprehensive database to {OUTPUT_FILE}")
    print(f"\nTotal entities: {len(all_entities)}")
    print("\nBreakdown by category:")
    for category, terms in entities.items():
        print(f"  {category}: {len(terms)}")
    
    return output_data

if __name__ == "__main__":
    result = build_standard_entities()
    
    print("\n" + "=" * 60)
    print("Sample entities from each category:")
    for category, terms in result['entities'].items():
        if terms:
            sample = terms[:5]
            print(f"\n{category}:")
            for term in sample:
                print(f"  - {term}")
