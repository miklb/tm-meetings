#!/usr/bin/env python3
"""
Comprehensive transcript capitalizer using three sources:
1. Standard entities (countries, holidays, historical events, etc.)
2. Hybrid agenda entities (Tampa-specific people and organizations)
3. Heuristic rules (sentence starts, acronyms, pronoun "I")

Usage:
    python capitalize_transcript.py input.json output.json
    
Input format: ALL CAPS transcript with speaker IDs and timestamps
Output format: Properly capitalized transcript preserving structure
"""

import json
import re
from pathlib import Path
from typing import Dict, List, Set, Tuple

# Words that are both common English words AND acronyms in city council context.
# These need context to determine whether to uppercase.
_CONTEXT_SENSITIVE = frozenset({'it', 'us'})

# Next-word signals that 'it' is the IT acronym (Information Technology).
# In council speech, IT as an acronym is almost always followed by a noun
# describing a technical department or system.  Everything else defaults to
# the pronoun 'it', matching the user preference for lowercase bias.
_IT_ACRONYM_NEXT = frozenset({
    'department', 'dept', 'staff', 'team', 'director', 'manager',
    'systems', 'system', 'infrastructure', 'services', 'service',
    'support', 'budget', 'office', 'division', 'personnel',
})

# Determiners that signal "us" is the country abbreviation US, not the pronoun.
# In council speech, country references almost exclusively appear as "the US".
_US_COUNTRY_PREV = frozenset({'the'})

# Role/title words that get harvested from multi-word names like "Chair Clendenin"
# or "Board Member Maniscalco".  They must never be treated as surnames on their
# own, or single-word lookup would capitalize every "board"/"chair"/"member".
_NON_SURNAME_WORDS = frozenset({
    'chair', 'vice', 'board', 'member', 'mayor', 'council', 'councilman',
    'councilwoman', 'commissioner', 'director', 'attorney', 'officer',
    'captain', 'chief', 'reverend', 'doctor', 'judge', 'president',
    'secretary', 'treasurer', 'clerk', 'sergeant', 'lieutenant', 'grant',
})

# Month names that are also common English words ("may"/"march"/"august").
# Only capitalize these when they appear in a date-like context.
_AMBIGUOUS_MONTHS = frozenset({'may', 'march', 'august'})

# Tokens preceding an ambiguous month that signal a real date reference.
_MONTH_CONTEXT_PREV = frozenset({
    'in', 'on', 'by', 'since', 'until', 'of', 'through', 'before', 'after',
    'early', 'late', 'mid', 'this', 'last', 'next',
})


_COMMON_WORDS_PATH = "/usr/share/dict/words"


def _load_common_words() -> set:
    """Lowercase English words, used to keep common-word surnames ("Young",
    "Dock", "Pope", "Steady") out of the standalone surname index — they would
    otherwise capitalize every occurrence of the common word. Falls back to an
    empty set (no filtering) if the system word list is unavailable."""
    try:
        with open(_COMMON_WORDS_PATH, 'r', encoding='utf-8', errors='ignore') as f:
            return {w.strip().lower() for w in f if w.strip().isalpha()}
    except OSError:
        return set()


def _load_config(config_file: str = "data/capitalization_config.json") -> dict:
    """Load acronyms, neighborhoods, and street suffixes from config file."""
    config_path = Path(config_file)
    if config_path.exists():
        with open(config_path, 'r') as f:
            return json.load(f)
    # Fallback defaults if config file is missing
    return {"acronyms": ["i"], "neighborhoods": [], "street_suffixes": []}


class TranscriptCapitalizer:
    def __init__(self, 
                 standard_entities_file: str = "data/standard_entities.json",
                 hybrid_entities_file: str = "data/hybrid_entity_database.json",
                 config_file: str = "data/capitalization_config.json",
                 roster_file: str = "data/roster_entities.json",
                 use_gliner: bool = True):
        """Initialize with entity databases and optionally GLiNER model."""
        
        print("Loading entity databases...")
        
        # Load config (acronyms, neighborhoods, street suffixes, skip words)
        config = _load_config(config_file)
        self.acronyms = set(config.get('acronyms', []))
        self.neighborhoods = set(config.get('neighborhoods', []))
        self.street_suffixes = set(config.get('street_suffixes', []))
        self.skip_words = set(config.get('skip_words', []))
        
        # Load standard entities
        with open(standard_entities_file, 'r') as f:
            standard_data = json.load(f)
            self.standard_entities = set(standard_data['all_entities'])
            self.special_rules = standard_data['special_rules']
        
        # Merge acronyms into always_uppercase
        self.special_rules['always_uppercase'] = list(
            set(self.special_rules.get('always_uppercase', [])) | self.acronyms
        )
        
        print(f"  ✓ Loaded {len(self.standard_entities)} standard entities")
        
        # Load hybrid agenda entities
        with open(hybrid_entities_file, 'r') as f:
            hybrid_data = json.load(f)
            
            # Extract people and organizations with their proper casing
            self.agenda_entities = {}
            
            # Hybrid database structure: {name: {frequency, confidence, ...}}
            for name in hybrid_data['people'].keys():
                # Fix hyphenated name casing on load
                fixed = self._fix_hyphenated_name(name)
                self.agenda_entities[fixed.lower()] = fixed
            
            for name in hybrid_data['organizations'].keys():
                self.agenda_entities[name.lower()] = name
        
        # Add Tampa neighborhoods as multi-word entities
        for neighborhood in self.neighborhoods:
            proper = ' '.join(w.capitalize() for w in neighborhood.split())
            self.agenda_entities[neighborhood] = proper
        
        # Build surname index from people names for single-word and hyphenated
        # matching.  Exclude role/title words harvested from names like
        # "Chair Clendenin", anything the config already protects, and ambiguous
        # months, so single-word lookup stays safe.
        _always_lower = set(w.lower() for w in self.special_rules.get('always_lowercase', []))
        self._common_words = _load_common_words()

        def _accept_surname(token: str) -> bool:
            t = token.lower()
            return (len(t) >= 3
                    and t.isalpha()
                    and t not in _NON_SURNAME_WORDS
                    and t not in self.skip_words
                    and t not in _always_lower
                    and t not in _AMBIGUOUS_MONTHS
                    and t not in self._common_words)

        self.known_surnames = {}
        for name in list(hybrid_data['people'].keys()):
            parts = name.split()
            if len(parts) >= 2:
                last = parts[-1]
                if '-' in last:
                    for hp in last.split('-'):
                        if _accept_surname(hp):
                            self.known_surnames[hp.lower()] = hp
                elif _accept_surname(last):
                    self.known_surnames[last.lower()] = last
                # First name too
                if _accept_surname(parts[0]):
                    self.known_surnames[parts[0].lower()] = parts[0]

        # Speaker-label roster: the authoritative list of people who actually
        # spoke in meetings (council/CRA members, staff, recurring guests).
        # Always loaded so their names are never left lowercase, regardless of
        # whether they appear in any agenda. Built by build_speaker_roster.py.
        roster_path = Path(roster_file)
        roster_names = 0
        if roster_path.exists():
            with open(roster_path, 'r') as f:
                roster = json.load(f)
            # Full names -> agenda entities (single- and multi-word matching).
            for key, proper in roster.get('full_names', {}).items():
                self.agenda_entities[key] = proper
            # First/last tokens already filtered to exclude common English words.
            for key, proper in roster.get('single_word_names', {}).items():
                self.known_surnames[key] = proper
            roster_names = len(roster.get('full_names', {}))

        print(f"  ✓ Loaded {len(self.agenda_entities)} agenda entities")
        print(f"  ✓ Built {len(self.known_surnames)} surname index")
        print(f"  ✓ Loaded {roster_names} roster names from speaker labels")
        
        # Load GLiNER for runtime entity detection
        self.use_gliner = use_gliner
        if use_gliner:
            try:
                from gliner import GLiNER
                print("  Loading GLiNER model...")
                self.gliner_model = GLiNER.from_pretrained("urchade/gliner_small-v2.1")
                print(f"  ✓ GLiNER loaded")
            except ImportError:
                print("  ⚠ GLiNER not available - skipping runtime detection")
                self.gliner_model = None
                self.use_gliner = False
        else:
            self.gliner_model = None
        
        # Build lookup indices for fast matching
        self._build_lookup_indices()
        
        print(f"✓ Total entities: {len(self.standard_entities) + len(self.agenda_entities)}")
    
    def _is_common_word_context(self, word: str, idx: int, words: list) -> bool:
        """Return True when a context-sensitive word (it/us) is a pronoun, not an acronym."""
        def _clean(w: str) -> str:
            m = re.match(r"^[^\w]*([\w']+)[^\w]*$", w)
            return m.group(1).lower() if m else ''

        prev_word = _clean(words[idx - 1]) if idx > 0 else ''
        next_word = _clean(words[idx + 1]) if idx + 1 < len(words) else ''

        if word == 'it':
            # Only treat as IT acronym when followed by a tech/department noun.
            # Default to pronoun — matches preference for lowercase bias.
            if next_word not in _IT_ACRONYM_NEXT:
                return True
        elif word == 'us':
            # Treat as the pronoun unless preceded by a determiner like "the".
            # In council transcripts, bare "us" is almost always the pronoun;
            # the country abbreviation almost always appears as "the US".
            if prev_word not in _US_COUNTRY_PREV:
                return True
        return False

    @staticmethod
    def _fix_hyphenated_name(name: str) -> str:
        """Capitalize each part of a hyphenated name: Johnson-velez → Johnson-Velez."""
        if '-' not in name:
            return name
        parts = name.split('-')
        return '-'.join(p.capitalize() if p.islower() or p.isupper() else p for p in parts)
    
    def _build_lookup_indices(self):
        """Build efficient lookup structures."""
        
        # Standard entities: exact match (case-insensitive key -> proper case)
        self.standard_lookup = {e.lower(): e for e in self.standard_entities}
        
        # Multi-word entities: for phrase matching
        self.multiword_standard = {
            e.lower(): e for e in self.standard_entities 
            if ' ' in e or '-' in e
        }
        self.multiword_agenda = {
            k: v for k, v in self.agenda_entities.items() 
            if ' ' in v or '-' in v
        }
        
        # Sort multi-word by length (longest first) for greedy matching
        self.multiword_patterns = sorted(
            list(self.multiword_standard.keys()) + list(self.multiword_agenda.keys()),
            key=len,
            reverse=True
        )
        
        # Build street address regex pattern
        suffix_alts = '|'.join(re.escape(s) for s in sorted(self.street_suffixes, key=len, reverse=True))
        # Matches: "north franklin street", "n. tampa st", "e. twiggs street"
        self.street_pattern = re.compile(
            r'\b((?:north|south|east|west|n\.|s\.|e\.|w\.|n|s|e|w)\s+)?'
            r'(?!the\b|a\b|an\b|on\b|at\b|to\b|from\b|by\b|of\b|in\b|for\b|and\b|or\b|with\b|about\b)'
            r'([a-z][a-z]+(?:\s+[a-z][a-z]+)?)\s+'
            r'(' + suffix_alts + r')\b',
            re.IGNORECASE
        )
    
    def capitalize_text(self, text: str) -> str:
        """
        Capitalize text using entity databases, GLiNER, and heuristic rules.
        
        Args:
            text: ALL CAPS or lowercase text
            
        Returns:
            Properly capitalized text
        """
        
        if not text or not text.strip():
            return text
        
        # Step 1: Convert to lowercase for processing
        text_lower = text.lower()
        
        # Step 1.5: Apply street/address pattern capitalization
        def _capitalize_street_match(m):
            direction = m.group(1) or ''
            name_part = m.group(2)
            suffix = m.group(3)
            # Capitalize direction
            if direction.strip():
                d = direction.strip()
                if len(d) <= 2 and not d.endswith('.'):
                    direction = d.upper() + ' '  # N → N
                else:
                    direction = d.capitalize() + ' '  # north → North, n. → N.
                    if d.endswith('.'):
                        direction = d[0].upper() + d[1:] + ' '
            # Capitalize street name words
            name_cap = ' '.join(w.capitalize() for w in name_part.split())
            # Capitalize suffix
            suffix_cap = suffix.capitalize()
            # Keep short suffixes like St, Ave as-is (already capitalized)
            return f"{direction}{name_cap} {suffix_cap}"
        
        text_lower = self.street_pattern.sub(_capitalize_street_match, text_lower)
        
        # Step 2: Replace multi-word entities first (greedy longest match)
        for pattern in self.multiword_patterns:
            if pattern in text_lower.lower():
                # Get proper casing
                if pattern in self.multiword_standard:
                    proper = self.multiword_standard[pattern]
                else:
                    proper = self.multiword_agenda[pattern]
                
                # Replace all occurrences (case-insensitive)
                # Use word boundaries to avoid partial matches
                text_lower = re.sub(
                    r'\b' + re.escape(pattern) + r'\b',
                    proper,
                    text_lower,
                    flags=re.IGNORECASE
                )
        
        # Step 2.5: Run GLiNER on the text to find additional entities
        gliner_entities = {}
        gliner_multiword = {}
        if self.use_gliner and self.gliner_model:
            try:
                # Extract person and organization names from this text
                # Process in chunks to avoid truncation (GLiNER has 384 token limit)
                # Using 250 words per chunk to be conservative (tokens < words)
                # Only "person" and "organization" — the broader "law"/"document"/
                # "facility" labels caused generic phrases to be title-cased
                # ("Laws in Place", "Required Documents", "Beautiful Park").
                # Real acts/documents should live in the entity database instead.
                labels = ["person", "organization"]
                chunk_size = 250  # words (conservative to stay well under 384 token limit)
                words = text_lower.split()

                for i in range(0, len(words), chunk_size):
                    chunk = ' '.join(words[i:i+chunk_size])
                    entities = self.gliner_model.predict_entities(chunk, labels, threshold=0.55)
                    
                    # Store GLiNER-detected entities with their proper casing
                    for entity in entities:
                        entity_text = entity['text']
                        
                        # Skip known acronyms — our explicit list takes priority
                        if entity_text.lower() in self.acronyms:
                            continue
                        
                        # Skip if it is a substring of any multi-word database entity
                        if any(entity_text.lower() in db_pattern for db_pattern in self.multiword_patterns):
                            continue
                        
                        # Title case the entity (capitalize each word)
                        # Preserve hyphenated name casing, handle acronyms/possessives, and keep common lowercase words lowercase
                        words_in_entity = entity_text.split()
                        proper_parts = []
                        for idx, w in enumerate(words_in_entity):
                            # Separate punctuation/possessive for the word inside the entity
                            match_w = re.match(r'^([^\w]*)(.+?)([^\w]*)$', w)
                            if match_w:
                                lead_w, core_w, trail_w = match_w.groups()
                            else:
                                lead_w = trail_w = ''
                                core_w = w
                            
                            # Check for possessive
                            suffix_w = ''
                            base_w = core_w
                            if len(core_w) > 2 and core_w.lower().endswith("'s"):
                                suffix_w = core_w[-2:]
                                base_w = core_w[:-2]
                            elif len(core_w) > 1 and core_w.endswith("'"):
                                suffix_w = "'"
                                base_w = core_w[:-1]
                            
                            clean_w = re.sub(r'[^\w-]', '', base_w).lower()
                            
                            if clean_w in self.special_rules.get('always_lowercase', []):
                                proper_parts.append(lead_w + clean_w + suffix_w + trail_w)
                            elif clean_w in self.acronyms or clean_w in self.special_rules.get('always_uppercase', []):
                                proper_parts.append(lead_w + base_w.upper() + suffix_w + trail_w)
                            elif '-' in clean_w:
                                proper_parts.append(lead_w + '-'.join(p.capitalize() for p in clean_w.split('-')) + suffix_w + trail_w)
                            else:
                                proper_parts.append(lead_w + base_w.capitalize() + suffix_w + trail_w)
                        proper_case = ' '.join(proper_parts)
                        
                        # Store both single and multi-word entities
                        if ' ' in entity_text:
                            gliner_multiword[entity_text.lower()] = proper_case
                        else:
                            gliner_entities[entity_text.lower()] = proper_case
                    
            except Exception as e:
                # Silently skip GLiNER errors
                pass
        
        # Step 2.6: Replace GLiNER multi-word entities
        for pattern, proper in sorted(gliner_multiword.items(), key=lambda x: len(x[0]), reverse=True):
            if pattern in text_lower.lower():
                text_lower = re.sub(
                    r'\b' + re.escape(pattern) + r'\b',
                    proper,
                    text_lower,
                    flags=re.IGNORECASE
                )
        
        # Step 3: Tokenize and process word by word
        words = text_lower.split()
        capitalized_words = []
        
        for i, word in enumerate(words):
            # Separate punctuation from word
            # Match: leading punct, word, trailing punct
            match = re.match(r'^([^\w]*)(.+?)([^\w]*)$', word)
            if match:
                leading_punct, word_core, trailing_punct = match.groups()
            else:
                leading_punct = trailing_punct = ''
                word_core = word
            
            # Check if already capitalized from multi-word replacement
            if word_core and word_core[0].isupper():
                capitalized_words.append(word)
                continue

            # Check for possessive suffix ('s or ')
            suffix = ''
            base_core = word_core
            
            if len(word_core) > 2 and word_core.lower().endswith("'s"):
                suffix = word_core[-2:]
                base_core = word_core[:-2]
            elif len(word_core) > 1 and word_core.endswith("'"):
                suffix = "'"
                base_core = word_core[:-1]
            
            # Clean base word for lookup (just alphanumeric and hyphens)
            base_clean = re.sub(r'[^\w-]', '', base_core).lower()

            if not base_clean:
                capitalized_words.append(word)
                continue

            # Context-sensitive disambiguation: 'it'/'us' are both common pronouns
            # and acronyms. Only uppercase when context rules out the pronoun reading.
            if base_clean in _CONTEXT_SENSITIVE:
                if self._is_common_word_context(base_clean, i, words):
                    # Treat as pronoun; still respect sentence-start capitalisation
                    if i == 0 or (i > 0 and any(p in words[i - 1] for p in ['.', '!', '?'])):
                        result = base_core[0].upper() + base_core[1:]
                    else:
                        result = base_core
                    capitalized_words.append(leading_punct + result + suffix + trailing_punct)
                    continue
                # Not pronoun context — fall through to normal acronym/entity rules

            # Check if this should be an acronym (override other capitalizations)
            if base_clean in self.acronyms:
                capitalized_words.append(leading_punct + base_core.upper() + suffix + trailing_punct)
                continue

            # Acronym plurals: "cras" -> "CRAs", "cacs" -> "CACs", "rfps" -> "RFPs".
            # Stem must be at least 2 chars so common words ("is"/"as"/"us") are
            # left alone, and the lowercase 's' is preserved as the plural marker.
            if (len(base_clean) > 2 and base_clean.endswith('s')
                    and base_clean[:-1] in self.acronyms):
                capitalized_words.append(
                    leading_punct + base_core[:-1].upper() + 's' + suffix + trailing_punct
                )
                continue

            # Rule 0: Hyphenated words — check early so sentence-start rules don't clobber names
            if '-' in base_clean and len(base_clean) > 2:
                parts = base_clean.split('-')
                is_name_like = any(
                    p.lower() in self.standard_lookup 
                    or p.lower() in self.agenda_entities
                    or p.lower() in self.known_surnames
                    or p.lower() in gliner_entities
                    for p in parts if len(p) > 1
                )
                if is_name_like:
                    fixed_parts = []
                    for p in parts:
                        if p.lower() in self.known_surnames:
                            fixed_parts.append(self.known_surnames[p.lower()])
                        else:
                            fixed_parts.append(p.capitalize())
                    fixed = '-'.join(fixed_parts)
                    capitalized_words.append(leading_punct + fixed + suffix + trailing_punct)
                    continue
            
            # Rule 1: First word of sentence (always capitalize)
            if i == 0:
                capitalized = base_core[0].upper() + base_core[1:]
                capitalized_words.append(leading_punct + capitalized + suffix + trailing_punct)
                continue
            
            # Rule 2: After sentence-ending punctuation
            if i > 0 and any(p in words[i-1] for p in ['.', '!', '?']):
                capitalized = base_core[0].upper() + base_core[1:]
                capitalized_words.append(leading_punct + capitalized + suffix + trailing_punct)
                continue
            
            # Rule 3: Pronoun "I"
            if base_clean == 'i':
                capitalized_words.append(leading_punct + 'I' + suffix + trailing_punct)
                continue
            
            # Rule 4: Always lowercase words
            if base_clean in self.special_rules['always_lowercase']:
                capitalized_words.append(leading_punct + base_core + suffix + trailing_punct)
                continue
            
            # Rule 5: Always uppercase (acronyms)
            if base_clean in self.special_rules['always_uppercase']:
                capitalized_words.append(leading_punct + base_core.upper() + suffix + trailing_punct)
                continue
            
            # Rule 5.5: Detect likely acronyms (2-5 uppercase letters in original)
            # If original text was ALL CAPS, check if the word is a known acronym pattern
            orig_word = text.split()[i] if i < len(text.split()) else ''
            if (len(base_clean) >= 2 and len(base_clean) <= 5 
                    and base_clean.isalpha() 
                    and orig_word.isupper()
                    and base_clean in self.acronyms):
                capitalized_words.append(leading_punct + base_core.upper() + suffix + trailing_punct)
                continue
            
            # Rule 6: Skip ambiguous words (common nouns that match entity names)
            if base_clean in self.skip_words:
                capitalized_words.append(leading_punct + base_core + suffix + trailing_punct)
                continue
            
            # Rule 6.5: Ambiguous month names ("may"/"march"/"august") are stored
            # as standard entities but double as common words. Only let them reach
            # the entity lookup below in a date-like context; otherwise lowercase.
            if base_clean in _AMBIGUOUS_MONTHS:
                def _ctx_token(j):
                    if 0 <= j < len(words):
                        m = re.match(r"^[^\w]*([\w']+)[^\w]*$", words[j])
                        return m.group(1).lower() if m else ''
                    return ''
                nxt, prv = _ctx_token(i + 1), _ctx_token(i - 1)
                date_like = bool(
                    re.match(r'^\d{1,4}(st|nd|rd|th)?$', nxt)
                    or re.match(r'^\d{4}$', prv)
                    or prv in _MONTH_CONTEXT_PREV
                )
                if not date_like:
                    capitalized_words.append(leading_punct + base_core + suffix + trailing_punct)
                    continue
                # date context: fall through to the standard-entity lookup -> "May"

            # Rule 7: Check standard entities
            if base_clean in self.standard_lookup:
                proper = self.standard_lookup[base_clean]
                capitalized_words.append(leading_punct + proper + suffix + trailing_punct)
                continue

            # Rule 7: Check agenda entities
            if base_clean in self.agenda_entities:
                proper = self.agenda_entities[base_clean]
                capitalized_words.append(leading_punct + proper + suffix + trailing_punct)
                continue

            # Rule 7c: Known council/staff surnames used on their own,
            # e.g. "board member clendenin" -> "board member Clendenin".
            if base_clean in self.known_surnames:
                proper = self.known_surnames[base_clean]
                capitalized_words.append(leading_punct + proper + suffix + trailing_punct)
                continue
            
            # Rule 8: Check GLiNER-detected entities
            if base_clean in gliner_entities:
                proper = gliner_entities[base_clean]
                capitalized_words.append(leading_punct + proper + suffix + trailing_punct)
                continue
            
            # Rule 9: Numeric patterns (dates, times, etc.)
            if re.match(r'^\d', base_clean):
                capitalized_words.append(word)
                continue
            
            # Default: Keep lowercase (conservative approach)
            # Only capitalize what we know about
            capitalized_words.append(leading_punct + base_core + suffix + trailing_punct)
        
        return ' '.join(capitalized_words)
    
    def process_transcript(self, transcript_data: Dict) -> Dict:
        """
        Process entire transcript JSON structure.
        
        Args:
            transcript_data: Transcript with structure like:
                {
                    "segments": [
                        {
                            "speaker": "SPEAKER NAME",
                            "timestamp": "9:03 AM",
                            "text": "ALL CAPS TEXT HERE"
                        }
                    ]
                }
        
        Returns:
            Capitalized transcript with same structure
        """
        
        result = transcript_data.copy()
        
        # Process segments
        if 'segments' in result:
            print(f"Processing {len(result['segments'])} segments...")
            
            for i, segment in enumerate(result['segments']):
                # Capitalize speaker name
                if 'speaker' in segment and segment['speaker']:
                    segment['speaker'] = self.capitalize_text(segment['speaker'])
                
                # Capitalize text
                if 'text' in segment and segment['text']:
                    segment['text'] = self.capitalize_text(segment['text'])
                
                # Progress indicator
                if (i + 1) % 100 == 0:
                    print(f"  Processed {i + 1} segments...")
        
        return result


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Capitalize transcript using entity databases'
    )
    parser.add_argument('input', help='Input transcript JSON (ALL CAPS)')
    parser.add_argument('output', help='Output transcript JSON (capitalized)')
    parser.add_argument(
        '--standard-entities',
        default='data/standard_entities.json',
        help='Path to standard entities database'
    )
    parser.add_argument(
        '--hybrid-entities',
        default='data/hybrid_entity_database.json',
        help='Path to hybrid agenda entities database'
    )
    
    args = parser.parse_args()
    
    # Load input
    print(f"Loading input: {args.input}")
    with open(args.input, 'r', encoding='utf-8') as f:
        transcript = json.load(f)
    
    # Initialize capitalizer
    capitalizer = TranscriptCapitalizer(
        args.standard_entities,
        args.hybrid_entities
    )
    
    # Process
    print("\nCapitalizing transcript...")
    result = capitalizer.process_transcript(transcript)
    
    # Save output
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    print(f"\n✓ Saved capitalized transcript to: {args.output}")
    
    # Show sample
    if 'segments' in result and result['segments']:
        print("\nSample output (first segment):")
        print("=" * 60)
        sample = result['segments'][0]
        if 'speaker' in sample:
            print(f"Speaker: {sample['speaker']}")
        if 'timestamp' in sample:
            print(f"Time: {sample['timestamp']}")
        if 'text' in sample:
            print(f"Text: {sample['text']}")


if __name__ == "__main__":
    main()
