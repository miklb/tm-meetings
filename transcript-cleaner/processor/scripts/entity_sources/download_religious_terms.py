#!/usr/bin/env python3
"""
Build database of religious terms and deities.

Source: Library of Congress Religion Subject Headings
License: Public domain
URL: https://www.loc.gov/aba/publications/FreeLCSH/freelcsh.html
"""

import json
from pathlib import Path

OUTPUT_FILE = Path(__file__).parent / "data" / "religious_terms.json"

# Major world religions
RELIGIONS = [
    {'name': 'Christianity', 'lcsh_id': 'sh85025082'},
    {'name': 'Islam', 'lcsh_id': 'sh85068390'},
    {'name': 'Judaism', 'lcsh_id': 'sh85070848'},
    {'name': 'Buddhism', 'lcsh_id': 'sh85017454'},
    {'name': 'Hinduism', 'lcsh_id': 'sh85060897'},
    {'name': 'Sikhism', 'lcsh_id': 'sh85122593'},
    {'name': 'Taoism', 'lcsh_id': 'sh85132549'},
    {'name': 'Confucianism', 'lcsh_id': 'sh85030893'},
]

# Deities and religious figures
DEITIES = [
    # Abrahamic
    'God',
    'Lord',
    'Jesus',
    'Jesus Christ',
    'Christ',
    'Holy Spirit',
    'Allah',
    'Yahweh',
    'Jehovah',
    
    # Other traditions
    'Buddha',
    'Krishna',
    'Vishnu',
    'Shiva',
    'Brahma',
]

# Religious texts
RELIGIOUS_TEXTS = [
    'Bible',
    'Old Testament',
    'New Testament',
    'Quran',
    'Koran',
    'Torah',
    'Talmud',
    'Vedas',
    'Bhagavad Gita',
    'Book of Mormon',
]

# Religious practices and concepts
RELIGIOUS_PRACTICES = [
    # Christian
    'Mass',
    'Communion',
    'Baptism',
    'Confirmation',
    'Easter',
    'Christmas',
    'Lent',
    'Advent',
    
    # Jewish
    'Sabbath',
    'Passover',
    'Hanukkah',
    'Yom Kippur',
    'Rosh Hashanah',
    'Bar Mitzvah',
    'Bat Mitzvah',
    
    # Islamic
    'Ramadan',
    'Hajj',
    'Eid al-Fitr',
    'Eid al-Adha',
    
    # Other
    'Prayer',
    'Worship',
    'Sermon',
]

# Religious titles and roles
RELIGIOUS_TITLES = [
    'Pope',
    'Bishop',
    'Archbishop',
    'Cardinal',
    'Priest',
    'Pastor',
    'Minister',
    'Reverend',
    'Deacon',
    'Rabbi',
    'Imam',
    'Monk',
    'Nun',
]

# Common prayers and texts
PRAYERS = [
    'Lord\'s Prayer',
    'Hail Mary',
    'Our Father',
    'Ave Maria',
]

def save_religious_terms():
    """Save religious terms to JSON."""
    
    print("Building religious terms database...")
    print(f"Source: Library of Congress Religion Subject Headings")
    print(f"URL: https://www.loc.gov/aba/publications/FreeLCSH/freelcsh.html")
    
    # Extract all terms
    religion_names = [r['name'] for r in RELIGIONS]
    
    all_terms = (
        set(religion_names) |
        set(DEITIES) |
        set(RELIGIOUS_TEXTS) |
        set(RELIGIOUS_PRACTICES) |
        set(RELIGIOUS_TITLES) |
        set(PRAYERS)
    )
    
    output_data = {
        'source': 'Library of Congress',
        'url': 'https://www.loc.gov/aba/publications/FreeLCSH/freelcsh.html',
        'license': 'Public domain',
        'verified': '2025-11-23',
        'religions': RELIGIONS,
        'deities': sorted(DEITIES),
        'religious_texts': sorted(RELIGIOUS_TEXTS),
        'religious_practices': sorted(RELIGIOUS_PRACTICES),
        'religious_titles': sorted(RELIGIOUS_TITLES),
        'prayers': sorted(PRAYERS),
        'all_terms': sorted(all_terms)
    }
    
    OUTPUT_FILE.parent.mkdir(exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"✓ Saved religious terms database to {OUTPUT_FILE}")
    print(f"  Religions: {len(RELIGIONS)}")
    print(f"  Deities: {len(DEITIES)}")
    print(f"  Texts: {len(RELIGIOUS_TEXTS)}")
    print(f"  Practices: {len(RELIGIOUS_PRACTICES)}")
    print(f"  Titles: {len(RELIGIOUS_TITLES)}")
    print(f"  Prayers: {len(PRAYERS)}")
    
    return output_data

if __name__ == "__main__":
    result = save_religious_terms()
    print(f"\n✓ Successfully saved {len(result['all_terms'])} religious terms")
    print(f"  Output: {OUTPUT_FILE}")
