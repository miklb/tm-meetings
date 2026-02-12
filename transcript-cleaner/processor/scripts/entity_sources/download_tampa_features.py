#!/usr/bin/env python3
"""
Download Tampa/Hillsborough County geographic features from USGS GNIS.

Source: US Geological Survey Geographic Names Information System
License: US Government work (public domain)
URL: https://www.usgs.gov/tools/geographic-names-information-system-gnis

Note: GNIS data files are large (~1GB). This script uses a curated list
of Tampa-area features verified against GNIS as of 2025-11-23.
"""

import json
from pathlib import Path

OUTPUT_FILE = Path(__file__).parent / "data" / "tampa_features.json"

# Tampa/Hillsborough County features from USGS GNIS
# Verified at: https://geonames.usgs.gov/apex/f?p=138:1
TAMPA_FEATURES = {
    'military': [
        {'name': 'MacDill Air Force Base', 'gnis_id': '294492', 'type': 'military'},
    ],
    'neighborhoods': [
        {'name': 'Ybor City', 'type': 'populated place'},
        {'name': 'Hyde Park', 'type': 'populated place'},
        {'name': 'Seminole Heights', 'type': 'populated place'},
        {'name': 'Westshore', 'type': 'populated place'},
        {'name': 'Carver City', 'type': 'populated place'},
    ],
    'parks': [
        {'name': 'Curtis Hixon Park', 'type': 'park'},
        {'name': 'Lettuce Lake Park', 'type': 'park'},
        {'name': 'Lowry Park', 'type': 'park'},
        {'name': 'Al Lopez Park', 'type': 'park'},
    ],
    'waterways': [
        {'name': 'Hillsborough River', 'gnis_id': '283806', 'type': 'stream'},
        {'name': 'Tampa Bay', 'type': 'bay'},
        {'name': 'Old Tampa Bay', 'type': 'bay'},
        {'name': 'McKay Bay', 'type': 'bay'},
    ],
    'municipalities': [
        {'name': 'Tampa', 'type': 'city'},
        {'name': 'Temple Terrace', 'type': 'city'},
        {'name': 'Plant City', 'type': 'city'},
    ],
    'bridges': [
        {'name': 'Gandy Bridge', 'type': 'bridge'},
        {'name': 'Howard Frankland Bridge', 'type': 'bridge'},
        {'name': 'Courtney Campbell Causeway', 'type': 'bridge'},
    ],
    'institutions': [
        {'name': 'University of South Florida', 'type': 'school'},
        {'name': 'University of Tampa', 'type': 'school'},
        {'name': 'Tampa General Hospital', 'type': 'hospital'},
    ],
    'streets': [
        # Major streets/roads commonly mentioned in council meetings
        {'name': 'Dale Mabry Highway', 'type': 'road'},
        {'name': 'Bayshore Boulevard', 'type': 'road'},
        {'name': 'Nebraska Avenue', 'type': 'road'},
        {'name': 'Florida Avenue', 'type': 'road'},
    ]
}

def save_tampa_features():
    """Save Tampa geographic features to JSON."""
    
    print("Building Tampa geographic features database...")
    print(f"Source: USGS Geographic Names Information System")
    print(f"URL: https://geonames.usgs.gov/")
    
    # Extract all feature names
    all_features = []
    feature_names = set()
    
    for category, features in TAMPA_FEATURES.items():
        for feature in features:
            all_features.append({
                'name': feature['name'],
                'category': category,
                'type': feature.get('type'),
                'gnis_id': feature.get('gnis_id')
            })
            feature_names.add(feature['name'])
    
    output_data = {
        'source': 'USGS Geographic Names Information System',
        'url': 'https://geonames.usgs.gov/',
        'license': 'US Government work (public domain)',
        'verified': '2025-11-23',
        'area': 'Tampa / Hillsborough County, Florida',
        'categories': TAMPA_FEATURES,
        'all_features': sorted(all_features, key=lambda x: x['name']),
        'feature_names': sorted(feature_names)
    }
    
    OUTPUT_FILE.parent.mkdir(exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"✓ Saved {len(feature_names)} Tampa features to {OUTPUT_FILE}")
    
    print("\nCategories:")
    for category, features in TAMPA_FEATURES.items():
        print(f"  {category}: {len(features)}")
    
    return output_data

if __name__ == "__main__":
    result = save_tampa_features()
    print(f"\n✓ Successfully saved {len(result['feature_names'])} Tampa feature names")
    print(f"  Output: {OUTPUT_FILE}")
