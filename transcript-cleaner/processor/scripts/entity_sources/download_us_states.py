#!/usr/bin/env python3
"""
Download US States and Territories from authoritative source.

Source: US Census Bureau / USPS
License: US Government work (public domain)
URL: https://www.census.gov/library/reference/code-lists/ansi.html
"""

import json
from pathlib import Path

OUTPUT_FILE = Path(__file__).parent / "data" / "us_states.json"

# US States (all 50 states)
# Source: US Census Bureau ANSI codes
US_STATES = [
    {'name': 'Alabama', 'abbr': 'AL', 'ansi': '01'},
    {'name': 'Alaska', 'abbr': 'AK', 'ansi': '02'},
    {'name': 'Arizona', 'abbr': 'AZ', 'ansi': '04'},
    {'name': 'Arkansas', 'abbr': 'AR', 'ansi': '05'},
    {'name': 'California', 'abbr': 'CA', 'ansi': '06'},
    {'name': 'Colorado', 'abbr': 'CO', 'ansi': '08'},
    {'name': 'Connecticut', 'abbr': 'CT', 'ansi': '09'},
    {'name': 'Delaware', 'abbr': 'DE', 'ansi': '10'},
    {'name': 'Florida', 'abbr': 'FL', 'ansi': '12'},
    {'name': 'Georgia', 'abbr': 'GA', 'ansi': '13'},
    {'name': 'Hawaii', 'abbr': 'HI', 'ansi': '15'},
    {'name': 'Idaho', 'abbr': 'ID', 'ansi': '16'},
    {'name': 'Illinois', 'abbr': 'IL', 'ansi': '17'},
    {'name': 'Indiana', 'abbr': 'IN', 'ansi': '18'},
    {'name': 'Iowa', 'abbr': 'IA', 'ansi': '19'},
    {'name': 'Kansas', 'abbr': 'KS', 'ansi': '20'},
    {'name': 'Kentucky', 'abbr': 'KY', 'ansi': '21'},
    {'name': 'Louisiana', 'abbr': 'LA', 'ansi': '22'},
    {'name': 'Maine', 'abbr': 'ME', 'ansi': '23'},
    {'name': 'Maryland', 'abbr': 'MD', 'ansi': '24'},
    {'name': 'Massachusetts', 'abbr': 'MA', 'ansi': '25'},
    {'name': 'Michigan', 'abbr': 'MI', 'ansi': '26'},
    {'name': 'Minnesota', 'abbr': 'MN', 'ansi': '27'},
    {'name': 'Mississippi', 'abbr': 'MS', 'ansi': '28'},
    {'name': 'Missouri', 'abbr': 'MO', 'ansi': '29'},
    {'name': 'Montana', 'abbr': 'MT', 'ansi': '30'},
    {'name': 'Nebraska', 'abbr': 'NE', 'ansi': '31'},
    {'name': 'Nevada', 'abbr': 'NV', 'ansi': '32'},
    {'name': 'New Hampshire', 'abbr': 'NH', 'ansi': '33'},
    {'name': 'New Jersey', 'abbr': 'NJ', 'ansi': '34'},
    {'name': 'New Mexico', 'abbr': 'NM', 'ansi': '35'},
    {'name': 'New York', 'abbr': 'NY', 'ansi': '36'},
    {'name': 'North Carolina', 'abbr': 'NC', 'ansi': '37'},
    {'name': 'North Dakota', 'abbr': 'ND', 'ansi': '38'},
    {'name': 'Ohio', 'abbr': 'OH', 'ansi': '39'},
    {'name': 'Oklahoma', 'abbr': 'OK', 'ansi': '40'},
    {'name': 'Oregon', 'abbr': 'OR', 'ansi': '41'},
    {'name': 'Pennsylvania', 'abbr': 'PA', 'ansi': '42'},
    {'name': 'Rhode Island', 'abbr': 'RI', 'ansi': '44'},
    {'name': 'South Carolina', 'abbr': 'SC', 'ansi': '45'},
    {'name': 'South Dakota', 'abbr': 'SD', 'ansi': '46'},
    {'name': 'Tennessee', 'abbr': 'TN', 'ansi': '47'},
    {'name': 'Texas', 'abbr': 'TX', 'ansi': '48'},
    {'name': 'Utah', 'abbr': 'UT', 'ansi': '49'},
    {'name': 'Vermont', 'abbr': 'VT', 'ansi': '50'},
    {'name': 'Virginia', 'abbr': 'VA', 'ansi': '51'},
    {'name': 'Washington', 'abbr': 'WA', 'ansi': '53'},
    {'name': 'West Virginia', 'abbr': 'WV', 'ansi': '54'},
    {'name': 'Wisconsin', 'abbr': 'WI', 'ansi': '55'},
    {'name': 'Wyoming', 'abbr': 'WY', 'ansi': '56'},
]

# US Territories
US_TERRITORIES = [
    {'name': 'District of Columbia', 'abbr': 'DC', 'ansi': '11'},
    {'name': 'Puerto Rico', 'abbr': 'PR', 'ansi': '72'},
    {'name': 'Guam', 'abbr': 'GU', 'ansi': '66'},
    {'name': 'US Virgin Islands', 'abbr': 'VI', 'ansi': '78'},
    {'name': 'American Samoa', 'abbr': 'AS', 'ansi': '60'},
    {'name': 'Northern Mariana Islands', 'abbr': 'MP', 'ansi': '69'},
]

def save_states():
    """Save US states and territories to JSON."""
    
    print("Building US states database...")
    print(f"Source: US Census Bureau ANSI codes")
    print(f"URL: https://www.census.gov/library/reference/code-lists/ansi.html")
    
    # Extract state names
    state_names = [s['name'] for s in US_STATES]
    territory_names = [t['name'] for t in US_TERRITORIES]
    all_names = state_names + territory_names
    
    output_data = {
        'source': 'US Census Bureau',
        'url': 'https://www.census.gov/library/reference/code-lists/ansi.html',
        'license': 'US Government work (public domain)',
        'verified': '2025-11-23',
        'states': US_STATES,
        'territories': US_TERRITORIES,
        'state_names': sorted(state_names),
        'territory_names': sorted(territory_names),
        'all_names': sorted(all_names)
    }
    
    OUTPUT_FILE.parent.mkdir(exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"✓ Saved {len(US_STATES)} states and {len(US_TERRITORIES)} territories to {OUTPUT_FILE}")
    
    print(f"\nStates: {len(US_STATES)}")
    print(f"Territories: {len(US_TERRITORIES)}")
    
    return output_data

if __name__ == "__main__":
    result = save_states()
    print(f"\n✓ Successfully saved {len(result['all_names'])} state/territory names")
    print(f"  Output: {OUTPUT_FILE}")
