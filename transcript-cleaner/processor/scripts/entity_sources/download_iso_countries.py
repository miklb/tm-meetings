#!/usr/bin/env python3
"""
Download ISO 3166 country codes from authoritative source.

Source: UN Statistics Division via GitHub datasets repository
License: Open Data Commons Public Domain Dedication and License (PDDL)
URL: https://github.com/datasets/country-codes
"""

import json
import csv
from pathlib import Path
from urllib.request import urlretrieve
from urllib.error import URLError

# Authoritative source
COUNTRY_CODES_URL = "https://raw.githubusercontent.com/datasets/country-codes/master/data/country-codes.csv"
OUTPUT_FILE = Path(__file__).parent / "data" / "iso_countries.json"

def download_countries():
    """Download and parse ISO 3166 country codes."""
    
    print("Downloading ISO 3166 country codes...")
    print(f"Source: {COUNTRY_CODES_URL}")
    
    # Create temp file
    temp_csv = OUTPUT_FILE.parent / "temp_countries.csv"
    temp_csv.parent.mkdir(exist_ok=True)
    
    try:
        # Download CSV
        urlretrieve(COUNTRY_CODES_URL, temp_csv)
        print(f"✓ Downloaded to {temp_csv}")
        
        # Parse CSV
        countries = []
        with open(temp_csv, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Extract relevant fields
                country = {
                    'name': row.get('official_name_en') or row.get('CLDR display name'),
                    'common_name': row.get('CLDR display name'),
                    'iso_alpha2': row.get('ISO3166-1-Alpha-2'),
                    'iso_alpha3': row.get('ISO3166-1-Alpha-3'),
                    'nationality': row.get('CLDR display name'),  # Used for adjectival form
                }
                
                # Only include if we have a valid name
                if country['name'] or country['common_name']:
                    countries.append(country)
        
        print(f"✓ Parsed {len(countries)} countries")
        
        # Extract unique country names for capitalization
        country_names = set()
        for country in countries:
            if country['name']:
                country_names.add(country['name'])
            if country['common_name'] and country['common_name'] != country['name']:
                country_names.add(country['common_name'])
        
        # Save structured data
        output_data = {
            'source': COUNTRY_CODES_URL,
            'license': 'Open Data Commons PDDL',
            'downloaded': '2025-11-23',
            'count': len(countries),
            'countries': sorted(countries, key=lambda x: x.get('common_name') or x.get('name')),
            'country_names': sorted(country_names)
        }
        
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)
        
        print(f"✓ Saved {len(country_names)} country names to {OUTPUT_FILE}")
        
        # Clean up temp file
        temp_csv.unlink()
        
        # Show sample
        print("\nSample country names:")
        for name in sorted(country_names)[:20]:
            print(f"  - {name}")
        
        return output_data
        
    except URLError as e:
        print(f"✗ Download failed: {e}")
        return None
    except Exception as e:
        print(f"✗ Error: {e}")
        if temp_csv.exists():
            temp_csv.unlink()
        return None

if __name__ == "__main__":
    result = download_countries()
    if result:
        print(f"\n✓ Successfully downloaded {result['count']} countries")
        print(f"  Output: {OUTPUT_FILE}")
    else:
        print("\n✗ Download failed")
        exit(1)
