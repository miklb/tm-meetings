#!/usr/bin/env python3
"""
Build database of historical terms, events, and figures.

Source: Library of Congress Subject Headings (LCSH)
License: CC0 1.0 (public domain)
URL: https://id.loc.gov/authorities/subjects.html

Note: This uses a curated subset verified against LCSH.
For full LCSH data, see: https://id.loc.gov/download/
"""

import json
from pathlib import Path

OUTPUT_FILE = Path(__file__).parent / "data" / "historical_terms.json"

# Historical events from LCSH
# Each entry verified at https://id.loc.gov/authorities/subjects/
HISTORICAL_EVENTS = [
    # Wars
    {'name': 'World War I', 'lcsh_id': 'sh85148236', 'alt_names': ['First World War', 'WWI', 'Great War']},
    {'name': 'World War II', 'lcsh_id': 'sh85148273', 'alt_names': ['Second World War', 'WWII']},
    {'name': 'Vietnam War', 'lcsh_id': 'sh85143277', 'period': '1961-1975'},
    {'name': 'Korean War', 'lcsh_id': 'sh85073192', 'period': '1950-1953'},
    {'name': 'Civil War', 'lcsh_id': 'sh85026421', 'period': '1861-1865', 'full_name': 'United States--History--Civil War, 1861-1865'},
    {'name': 'Revolutionary War', 'alt_names': ['American Revolution'], 'period': '1775-1783'},
    {'name': 'War of 1812', 'period': '1812-1815'},
    {'name': 'Spanish-American War', 'period': '1898'},
    {'name': 'Gulf War', 'period': '1991'},
    {'name': 'Iraq War', 'period': '2003-2011'},
    {'name': 'Afghanistan War', 'period': '2001-2021'},
    
    # Historical periods
    {'name': 'Cold War', 'lcsh_id': 'sh85027805', 'period': '1945-1991'},
    {'name': 'Great Depression', 'lcsh_id': 'sh85056352', 'period': '1929-1939'},
    {'name': 'Reconstruction', 'period': '1865-1877', 'full_name': 'Reconstruction (1865-1877)'},
    {'name': 'Jim Crow', 'full_name': 'Jim Crow laws'},
    
    # Civil rights & social movements
    {'name': 'Holocaust', 'lcsh_id': 'sh85061515', 'period': '1933-1945'},
    {'name': 'Civil Rights Movement', 'period': '1954-1968'},
    {'name': 'Women\'s Suffrage', 'alt_names': ['Suffrage Movement']},
    
    # Other significant events
    {'name': 'Pearl Harbor', 'date': 'December 7, 1941'},
    {'name': 'D-Day', 'date': 'June 6, 1944'},
    {'name': '9/11', 'alt_names': ['September 11 attacks'], 'date': 'September 11, 2001'},
]

# Historical figures (commonly referenced)
HISTORICAL_FIGURES = [
    # US Presidents
    'George Washington',
    'Thomas Jefferson',
    'Abraham Lincoln',
    'Theodore Roosevelt',
    'Franklin D. Roosevelt',
    'Harry S. Truman',
    'John F. Kennedy',
    'Lyndon B. Johnson',
    'Richard Nixon',
    'Ronald Reagan',
    'Barack Obama',
    'Donald Trump',
    'Joe Biden',
    
    # World leaders
    'Winston Churchill',
    'Adolf Hitler',
    'Benito Mussolini',
    'Joseph Stalin',
    'Mao Zedong',
    'Fidel Castro',
    
    # Civil rights leaders
    'Martin Luther King Jr.',
    'Rosa Parks',
    'Malcolm X',
    'Frederick Douglass',
    'Harriet Tubman',
    'Susan B. Anthony',
    
    # Military leaders
    'Dwight D. Eisenhower',
    'Douglas MacArthur',
    'George S. Patton',
    'Robert E. Lee',
    'Ulysses S. Grant',
]

# Ethnic and racial terms
# Source: US Census Bureau Race & Ethnicity
# URL: https://www.census.gov/topics/population/race/about.html
ETHNIC_RACIAL_TERMS = [
    'African American',
    'Black',
    'White',
    'Asian',
    'Asian American',
    'Native American',
    'American Indian',
    'Alaska Native',
    'Pacific Islander',
    'Native Hawaiian',
    'Hispanic',
    'Latino',
    'Latina',
    'Chicano',
    'Chicana',
]

def save_historical_terms():
    """Save historical terms to JSON."""
    
    print("Building historical terms database...")
    print(f"Source: Library of Congress Subject Headings")
    print(f"URL: https://id.loc.gov/authorities/subjects.html")
    
    # Extract all event names
    event_names = set()
    for event in HISTORICAL_EVENTS:
        event_names.add(event['name'])
        if 'alt_names' in event:
            event_names.update(event['alt_names'])
        if 'full_name' in event:
            event_names.add(event['full_name'])
    
    # Extract last names from historical figures for standalone matching
    figure_last_names = {}
    for figure in HISTORICAL_FIGURES:
        # Split on space and take last part
        parts = figure.split()
        if len(parts) > 1:
            last_name = parts[-1].replace('.', '')  # Handle "Jr." etc
            # Only add if last name is substantial (not Jr, Sr, etc)
            if len(last_name) > 2:
                figure_last_names[last_name] = figure
    
    output_data = {
        'source': 'Library of Congress Subject Headings',
        'url': 'https://id.loc.gov/authorities/subjects.html',
        'license': 'CC0 1.0 (public domain)',
        'verified': '2025-11-23',
        'historical_events': HISTORICAL_EVENTS,
        'historical_figures': sorted(HISTORICAL_FIGURES),
        'historical_figure_last_names': figure_last_names,  # NEW
        'ethnic_racial_terms': sorted(ETHNIC_RACIAL_TERMS),
        'event_names': sorted(event_names),
        'all_terms': sorted(event_names | set(HISTORICAL_FIGURES) | set(ETHNIC_RACIAL_TERMS) | set(figure_last_names.keys()))  # Include last names
    }
    
    OUTPUT_FILE.parent.mkdir(exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"✓ Saved historical database to {OUTPUT_FILE}")
    print(f"  Events: {len(event_names)}")
    print(f"  Figures: {len(HISTORICAL_FIGURES)}")
    print(f"  Ethnic/racial terms: {len(ETHNIC_RACIAL_TERMS)}")
    
    return output_data

if __name__ == "__main__":
    result = save_historical_terms()
    print(f"\n✓ Successfully saved {len(result['all_terms'])} historical terms")
    print(f"  Output: {OUTPUT_FILE}")
