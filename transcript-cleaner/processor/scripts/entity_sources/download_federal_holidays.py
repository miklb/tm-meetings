#!/usr/bin/env python3
"""
Download US Federal Holidays from authoritative source.

Source: US Office of Personnel Management (OPM)
License: US Government work (public domain)
URL: https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/
"""

import json
from pathlib import Path

# Federal holidays are relatively stable, so we'll use a curated list
# verified against OPM source as of 2025-11-23

OUTPUT_FILE = Path(__file__).parent / "data" / "federal_holidays.json"

# Federal holidays per OPM
# Source: https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/
FEDERAL_HOLIDAYS = [
    {
        'name': 'New Year\'s Day',
        'date': 'January 1',
        'notes': 'First day of the year'
    },
    {
        'name': 'Birthday of Martin Luther King, Jr.',
        'common_names': ['Martin Luther King Jr. Day', 'MLK Day'],
        'date': 'Third Monday in January',
        'notes': 'Honors civil rights leader Martin Luther King Jr.'
    },
    {
        'name': 'Washington\'s Birthday',
        'common_names': ['Presidents\' Day', 'Presidents Day'],
        'date': 'Third Monday in February',
        'notes': 'Honors all US presidents, especially George Washington'
    },
    {
        'name': 'Memorial Day',
        'date': 'Last Monday in May',
        'notes': 'Honors military personnel who died in service'
    },
    {
        'name': 'Juneteenth National Independence Day',
        'common_names': ['Juneteenth'],
        'date': 'June 19',
        'notes': 'Commemorates end of slavery in the United States'
    },
    {
        'name': 'Independence Day',
        'common_names': ['Fourth of July'],
        'date': 'July 4',
        'notes': 'Commemorates Declaration of Independence'
    },
    {
        'name': 'Labor Day',
        'date': 'First Monday in September',
        'notes': 'Honors American workers'
    },
    {
        'name': 'Columbus Day',
        'common_names': ['Indigenous Peoples\' Day'],
        'date': 'Second Monday in October',
        'notes': 'Some jurisdictions observe as Indigenous Peoples\' Day'
    },
    {
        'name': 'Veterans Day',
        'date': 'November 11',
        'notes': 'Honors military veterans'
    },
    {
        'name': 'Thanksgiving Day',
        'common_names': ['Thanksgiving'],
        'date': 'Fourth Thursday in November',
        'notes': 'Traditional harvest celebration'
    },
    {
        'name': 'Christmas Day',
        'common_names': ['Christmas'],
        'date': 'December 25',
        'notes': 'Christian holiday celebrating birth of Jesus'
    }
]

# Additional common holidays (not federal but widely recognized)
COMMON_HOLIDAYS = [
    'Easter',
    'Easter Sunday',
    'Good Friday',
    'Halloween',
    'Hanukkah',
    'Kwanzaa',
    'Passover',
    'Ramadan',
    'Rosh Hashanah',
    'Yom Kippur',
    'Diwali',
    'Chinese New Year',
    'Cinco de Mayo',
    'St. Patrick\'s Day',
    'Valentine\'s Day',
    'Mother\'s Day',
    'Father\'s Day'
]

def save_holidays():
    """Save federal holidays to JSON."""
    
    print("Building federal holidays database...")
    print(f"Source: US Office of Personnel Management")
    print(f"URL: https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/")
    
    # Extract all holiday names
    holiday_names = set()
    for holiday in FEDERAL_HOLIDAYS:
        holiday_names.add(holiday['name'])
        if 'common_names' in holiday:
            holiday_names.update(holiday['common_names'])
    
    # Add common holidays
    holiday_names.update(COMMON_HOLIDAYS)
    
    output_data = {
        'source': 'US Office of Personnel Management',
        'url': 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/',
        'license': 'US Government work (public domain)',
        'verified': '2025-11-23',
        'federal_holidays': FEDERAL_HOLIDAYS,
        'common_holidays': COMMON_HOLIDAYS,
        'all_holiday_names': sorted(holiday_names)
    }
    
    OUTPUT_FILE.parent.mkdir(exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"✓ Saved {len(holiday_names)} holiday names to {OUTPUT_FILE}")
    
    print("\nFederal holidays:")
    for holiday in FEDERAL_HOLIDAYS:
        print(f"  - {holiday['name']}")
    
    print(f"\nAdditional common holidays: {len(COMMON_HOLIDAYS)}")
    
    return output_data

if __name__ == "__main__":
    result = save_holidays()
    print(f"\n✓ Successfully saved {len(result['all_holiday_names'])} holiday names")
    print(f"  Output: {OUTPUT_FILE}")
