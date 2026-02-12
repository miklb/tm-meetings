#!/usr/bin/env python3
"""
Clean the hybrid entity database:
1. Remove non-person entries from people (roles, titles, plurals)
2. Deduplicate people (merge variants like "Brad Baird" / "Brad L. Baird")
3. Fix hyphenated name casing (Johnson-velez → Johnson-Velez)
4. Move misplaced business names from people to organizations
"""

import json
import re
from pathlib import Path
from collections import defaultdict

# Patterns that indicate a non-person entry
NOT_PERSON_PATTERNS = [
    r'^(city|county|state|federal)\s',
    r'\b(director|supervisor|administrator|clerk|officer|coordinator)\b',
    r'\b(owner|designee|resources|zoning|purchasing)\b',
    r'\b(police officers|school resources|property owner)\b',
    r'\b(inc\.|llc|corp\.|p\.c\.|l\.p\.|p\.a\.)\s*$',
    r'\b(inc|llc|corp|services|enterprises|industries|associates|consultants)\s*$',
    r'^(the|a|an)\s',
    r'\bmayor of\b',
    r'\bcouncilmember\b',
]

NOT_PERSON_EXACT = {
    'city clerk', 'director of purchasing', 'property owner(s)',
    'zoning administrator', 'supervisor of elections',
    'school resources officers', 'police officers',
    'local hearing officer', 'zoning administrator or designee',
}


def is_non_person(name: str) -> bool:
    """Check if a name is actually a role/title/business, not a person."""
    lower = name.lower()
    
    if lower in NOT_PERSON_EXACT:
        return True
    
    for pattern in NOT_PERSON_PATTERNS:
        if re.search(pattern, lower):
            return True
    
    return False


def is_business(name: str) -> bool:
    """Check if a name is a business entity."""
    lower = name.lower()
    business_indicators = ['inc.', 'inc', 'llc', 'corp.', 'corp', 'p.c.', 'l.p.',
                           'p.a.', 'services', 'enterprises', 'industries',
                           'associates', 'consultants', 'group', 'partners']
    return any(lower.endswith(b) or f' {b} ' in f' {lower} ' for b in business_indicators)


def fix_hyphenated(name: str) -> str:
    """Fix hyphenated name casing: Johnson-velez → Johnson-Velez."""
    if '-' not in name:
        return name
    parts = name.split('-')
    return '-'.join(
        p[0].upper() + p[1:] if p and p[0].islower() else p
        for p in parts
    )


def normalize_name(name: str) -> str:
    """Normalize a name for deduplication comparison."""
    # Remove titles
    name = re.sub(r'^(Chief|Councilmember|Mayor|Detective|Dr\.|Mr\.|Ms\.|Mrs\.)\s+', '', name)
    # Remove middle initials and suffixes
    name = re.sub(r'\s+[A-Z]\.\s+', ' ', name)
    name = re.sub(r',?\s+(P\.E\.|Jr\.|Sr\.|III|II|IV)$', '', name)
    # Strip and collapse whitespace
    return ' '.join(name.split()).strip()


def deduplicate_people(people: dict) -> dict:
    """Merge duplicate people entries, keeping the highest-scoring variant."""
    
    # Group by normalized name
    groups = defaultdict(list)
    for name, stats in people.items():
        normalized = normalize_name(name)
        groups[normalized].append((name, stats))
    
    result = {}
    merged_count = 0
    
    for normalized, variants in groups.items():
        if len(variants) == 1:
            name, stats = variants[0]
            result[fix_hyphenated(name)] = stats
            continue
        
        # Multiple variants — pick the best canonical name
        # Prefer: shortest unambiguous name without title prefix
        # But with highest score
        merged_count += len(variants) - 1
        
        # Find the canonical name (no title, no middle initial, highest score)
        best_name = None
        best_score = -1
        total_freq = 0
        total_score = 0
        all_agendas = 0
        all_transcripts = 0
        
        for name, stats in variants:
            total_freq += stats.get('frequency', 0)
            total_score += stats.get('score', 0)
            all_agendas += stats.get('agendas', 0)
            all_transcripts += stats.get('transcripts', 0)
            
            # Prefer names without titles
            clean = normalize_name(name)
            # Score: prefer 2-word names over 1-word, penalize titles
            name_quality = len(clean.split()) * 10
            if name.startswith(('Chief ', 'Councilmember ', 'Mayor ', 'Detective ', 'Fire Chief ')):
                name_quality -= 5  # Penalize titled variants
            if stats.get('score', 0) > best_score or name_quality > len(best_name.split()) * 10 if best_name else 0:
                if len(clean.split()) >= 2:  # Must be at least first + last
                    best_name = clean
                    best_score = stats.get('score', 0)
        
        if best_name is None:
            # Fallback to first variant
            best_name = variants[0][0]
        
        result[fix_hyphenated(best_name)] = {
            'frequency': total_freq,
            'confidence': 1.0,
            'score': round(total_score, 2),
            'agendas': all_agendas,
            'transcripts': all_transcripts,
        }
    
    return result, merged_count


def clean_database(input_path: Path, output_path: Path):
    """Clean and deduplicate the entity database."""
    
    with open(input_path, 'r') as f:
        db = json.load(f)
    
    print(f"Input: {len(db['people'])} people, {len(db['organizations'])} orgs")
    print("=" * 60)
    
    # 1. Remove non-person entries
    removed_roles = []
    moved_to_orgs = []
    clean_people = {}
    
    for name, stats in db['people'].items():
        if is_non_person(name):
            removed_roles.append(name)
        elif is_business(name):
            moved_to_orgs.append(name)
            db['organizations'][name] = stats
        else:
            clean_people[name] = stats
    
    print(f"\nRemoved {len(removed_roles)} non-person entries:")
    for r in removed_roles:
        print(f"  - {r}")
    
    print(f"\nMoved {len(moved_to_orgs)} businesses to organizations:")
    for m in moved_to_orgs:
        print(f"  → {m}")
    
    # 2. Deduplicate
    deduped_people, merged_count = deduplicate_people(clean_people)
    print(f"\nMerged {merged_count} duplicate entries")
    
    # 3. Fix hyphenated names in final output
    final_people = {}
    for name, stats in deduped_people.items():
        final_people[fix_hyphenated(name)] = stats
    
    # Sort by score
    final_people = dict(sorted(final_people.items(), key=lambda x: x[1].get('score', 0), reverse=True))
    
    db['people'] = final_people
    db['metadata']['cleaned'] = True
    db['metadata']['cleaning_stats'] = {
        'roles_removed': len(removed_roles),
        'businesses_moved': len(moved_to_orgs),
        'duplicates_merged': merged_count,
    }
    
    print(f"\nOutput: {len(db['people'])} people, {len(db['organizations'])} orgs")
    
    with open(output_path, 'w') as f:
        json.dump(db, f, indent=2, ensure_ascii=False)
    
    print(f"Saved to: {output_path}")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Clean hybrid entity database')
    parser.add_argument('--input', type=Path, default=Path('data/hybrid_entity_database.json'))
    parser.add_argument('--output', type=Path, default=Path('data/hybrid_entity_database.json'))
    args = parser.parse_args()
    
    clean_database(args.input, args.output)
