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
import logging
import re
from pathlib import Path
from typing import Dict, List, Set, Tuple

logger = logging.getLogger(__name__)

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
# Derived from the raw transcripts (2,958 "MAY"s): the date uses sit after
# in/on/until/…; the modal sits after a pronoun ("I may", "you may", "that
# may"). "this" is deliberately absent — "this may be" outnumbers "this May".
_MONTH_CONTEXT_PREV = frozenset({
    'in', 'on', 'by', 'since', 'until', 'of', 'through', 'before', 'after',
    'early', 'late', 'mid', 'last', 'next',
})
# Tokens that follow the modal "may", never the month (top "MAY <next>"
# counts in the corpus: be 500, have 285, not 255, need 175, want 45, …).
_MONTH_NOT_NEXT = frozenset({
    'be', 'have', 'not', 'need', 'want', 'also', 'know', 'come', 'ask',
    'remember', 'exist', 'only', 'get', 'go', 'say', 'see', 'do', 'make',
    'take', 'find', 'give', 'think', 'feel', 'seem', 'look', 'help', 'still',
    'never', 'just', 'even', 'well', 'actually', 'already', 'very', 'or',
    'and', 'i', 'you', 'he', 'she', 'it', 'they', 'as', 'if', 'sound', 'recall',
})
# Courtesy titles: always capitalized, and never end a sentence when
# abbreviated ("Ms. Bennett" is one name, not two sentences).
_TITLE_ABBREVS = frozenset({'mr', 'ms', 'mrs', 'dr', 'miss'})
# Role words that are capitalized when they directly precede a known name.
_ROLE_TITLES = frozenset({
    'councilman', 'councilwoman', 'councilmember', 'chairman', 'chairwoman',
    'chair', 'mayor', 'commissioner', 'senator', 'representative', 'judge',
    'pastor', 'reverend', 'father', 'sister', 'brother', 'bishop', 'rabbi',
    'chief', 'captain', 'lieutenant', 'sergeant', 'officer', 'detective',
    'doctor', 'professor', 'dean', 'president', 'governor', 'secretary',
    'attorney', 'director', 'administrator', 'coach', 'madam', 'sir',
})
_DIRECTIONS = frozenset({'north', 'south', 'east', 'west', 'n', 's', 'e', 'w'})
# Abbreviations whose trailing period is not a sentence boundary.
_NO_BOUNDARY_ABBREVS = frozenset({
    'mr', 'ms', 'mrs', 'dr', 'jr', 'sr', 'st', 'ave', 'blvd', 'vs', 'etc',
    'e.g', 'i.e', 'inc', 'no', 'u.s', 'a.m', 'p.m', 'p.a', 'llc',
})
# Words that never form part of a street name (so "walk across the street"
# is left alone). Applied to the name words in front of a street suffix.
_STREET_STOP = frozenset({
    'the', 'a', 'an', 'on', 'at', 'to', 'from', 'by', 'of', 'in', 'for', 'and',
    'or', 'with', 'about', 'across', 'down', 'up', 'along', 'this', 'that',
    'these', 'those', 'our', 'your', 'my', 'their', 'his', 'her', 'its',
    'same', 'whole', 'entire', 'next', 'other', 'every', 'each', 'one', 'any',
    'some', 'all', 'both', 'main', 'side', 'dead', 'end', 'two', 'wrong',
    'right', 'left', 'is', 'was', 'be', 'it', 'we', 'you', 'they', 'i',
    'went', 'go', 'going', 'walk', 'walking', 'drive', 'driving', 'live',
    'living', 'lives', 'lived', 'work', 'working', 'here', 'there', 'over',
    'near', 'around', 'off', 'into', 'onto', 'through', 'just', 'not', 'no',
    'what', 'which', 'where', 'when', 'have', 'has', 'had', 'get', 'got',
    'new', 'old', 'big', 'little', 'small', 'busy', 'quiet', 'residential',
    'public', 'private', 'city', 'county', 'state', 'local', 'first',
})

# Titles/roles that, when they precede a surname, signal name use rather than
# the everyday word. Used to capitalize ambiguous common-word surnames like
# "Young" ("councilwoman young" -> "councilwoman Young"; "young people" stays).
_NAME_TITLE_PREV = frozenset({
    'councilman', 'councilwoman', 'councilmember', 'councilperson', 'council',
    'member', 'chair', 'chairman', 'chairwoman', 'chairperson', 'commissioner',
    'mr', 'mrs', 'ms', 'miss', 'dr', 'doctor', 'vice', 'mayor', 'attorney',
    'director', 'board', 'reverend', 'captain', 'president', 'representative',
    'senator', 'judge', 'officer',
})

_NAME_TITLE_PREV = _NAME_TITLE_PREV | _ROLE_TITLES
# Generic demographic nouns. A GLiNER multi-word "person" ending in one of these
# is a description ("young lady", "young man", "business owners"), not a name.
_GENERIC_PERSON_NOUNS = frozenset({
    'lady', 'ladies', 'man', 'men', 'woman', 'women', 'person', 'persons',
    'people', 'guy', 'guys', 'gentleman', 'gentlemen', 'folks', 'kid', 'kids',
    'child', 'children', 'boy', 'boys', 'girl', 'girls', 'family', 'families',
    'citizen', 'citizens', 'resident', 'residents', 'neighbor', 'neighbors',
    'owner', 'owners', 'student', 'students', 'professional', 'professionals',
})


# Entity/config files live in the processor's data/ directory regardless of
# the caller's working directory.
_DATA_DIR = Path(__file__).resolve().parent.parent / "data"

_COMMON_WORDS_PATH = "/usr/share/dict/words"


def _load_common_words() -> set:
    """Lowercase English words, used to keep common-word surnames ("Young",
    "Dock", "Pope", "Steady") and common-word "entities" ("Mass", "Black")
    out of the unconditional lookups. Only entries the dictionary itself
    lists in lowercase count: "young" is a common word, "Miranda" is not.

    Returns an empty set, with a warning, when no dictionary is installed;
    the capitalizer then trusts only the speaker roster's own classification
    of which single names are safe to capitalize on their own."""
    try:
        with open(_COMMON_WORDS_PATH, 'r', encoding='utf-8', errors='ignore') as f:
            return {w.strip() for w in f if w.strip().isalpha() and w.strip().islower()}
    except OSError:
        logger.warning("%s not found — common-word filtering limited to the speaker "
                       "roster's own classification", _COMMON_WORDS_PATH)
        print(f"  ⚠ {_COMMON_WORDS_PATH} not found — common-word filtering is limited")
        return set()


def _case_name(word: str) -> str:
    """Capitalize an unknown name, keeping the Mc- intercaps ("mccaskill" ->
    "McCaskill"). Other intercaps forms come from the roster's own casing."""
    w = word.lower()
    if w.startswith('mc') and len(w) > 4 and w[2].isalpha():
        return 'Mc' + w[2].upper() + w[3:]
    return word[0].upper() + word[1:]


def _is_sentence_end(prev_word: str) -> bool:
    """True when the previous token closes a sentence.

    Looks at how the token *ends* (so "$1.5 million" is not a boundary) and
    ignores abbreviations that carry a period ("Ms. Bennett", "a.m.")."""
    w = prev_word.rstrip('"\')]')
    if not w or w[-1] not in '.!?':
        return False
    core = w.rstrip('.!?').lower()
    if core in _NO_BOUNDARY_ABBREVS or core in _TITLE_ABBREVS:
        return False
    return True


def _prune_standard_entities(standard_data: dict, common_words: set, keep: set):
    """Standard entities minus single common words.

    The source lists are wholesale downloads (countries, religious terms,
    historical figures…) and carry ordinary words: "Mass", "Black", "Chad",
    "Grant", "Lee". Capitalizing those everywhere is worse than missing the
    rare proper use, so any single-word entry whose lowercase form is a
    dictionary word is dropped. Months and US states are exempt (the
    ambiguous months are gated separately by context). Returns
    (kept_entities, dropped_entities)."""
    exempt = {'days_months', 'us_states'}
    kept, dropped = set(), set()
    categories = standard_data.get('entities') or {}
    if isinstance(categories, dict) and categories:
        items = [(cat, e) for cat, lst in categories.items() for e in lst]
    else:
        items = [('all', e) for e in standard_data.get('all_entities', [])]
    for cat, e in items:
        single = ' ' not in e and '-' not in e
        if (single and cat not in exempt and e.lower() in common_words
                and e.lower() not in keep):
            dropped.add(e)
        else:
            kept.add(e)
    # all_entities can hold entries the categorized lists do not
    for e in standard_data.get('all_entities', []):
        if e not in kept and e not in dropped:
            single = ' ' not in e and '-' not in e
            if single and e.lower() in common_words and e.lower() not in keep:
                dropped.add(e)
            else:
                kept.add(e)
    return kept, dropped


def _load_config(config_file: str = str(_DATA_DIR / "capitalization_config.json")) -> dict:
    """Load acronyms, neighborhoods, and street suffixes from config file."""
    config_path = Path(config_file)
    if config_path.exists():
        with open(config_path, 'r') as f:
            return json.load(f)
    # Fallback defaults if config file is missing
    return {"acronyms": ["i"], "neighborhoods": [], "street_suffixes": []}


class TranscriptCapitalizer:
    def __init__(self, 
                 standard_entities_file: str = str(_DATA_DIR / "standard_entities.json"),
                 hybrid_entities_file: str = str(_DATA_DIR / "hybrid_entity_database.json"),
                 config_file: str = str(_DATA_DIR / "capitalization_config.json"),
                 roster_file: str = str(_DATA_DIR / "roster_entities.json"),
                 use_gliner: bool = False):
        """Initialize with entity databases and optionally the GLiNER model.

        GLiNER is off by default (2026-09-09): measured on a real meeting it
        mostly title-cased ordinary words ("They", "Business", "Running")
        and one-off public commenters, at 40x the run time. Recurring
        names come from the speaker roster and agenda entities instead."""
        
        print("Loading entity databases...")
        
        # Load config (acronyms, neighborhoods, street suffixes, skip words)
        config = _load_config(config_file)
        self.acronyms = set(config.get('acronyms', []))
        self.neighborhoods = set(config.get('neighborhoods', []))
        self.street_suffixes = set(config.get('street_suffixes', []))
        self.skip_words = set(config.get('skip_words', []))
        # Street names seen in agenda addresses (generated by extract_config.py)
        self.streets = set(w.lower() for w in config.get('streets', []))
        # Surnames that are dictionary words but should still capitalize alone
        # (members/officials whose common-word sense is rare in council speech).
        self.name_allowlist = set(w.lower() for w in config.get('name_allowlist', []))
        
        # Load standard entities
        with open(standard_entities_file, 'r') as f:
            standard_data = json.load(f)
        self.special_rules = standard_data['special_rules']
        self._common_words = _load_common_words()
        self.standard_entities, dropped = _prune_standard_entities(
            standard_data, self._common_words, self.name_allowlist)
        if dropped:
            print(f"  ✓ Dropped {len(dropped)} common-word standard entities "
                  f"(e.g. {', '.join(sorted(dropped)[:5])})")
        
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
                # Fix hyphenated name casing on load. Single-token people
                # ("Young") are not matched here: they go through the surname
                # buckets below, where a common-word name needs a title first.
                fixed = self._fix_hyphenated_name(name)
                if ' ' in fixed:
                    self.agenda_entities[fixed.lower()] = fixed
            
            for name in hybrid_data['organizations'].keys():
                self.agenda_entities[name.lower()] = name
        
        # Add Tampa neighborhoods as multi-word entities
        _lower_glue = set(w.lower() for w in self.special_rules.get('always_lowercase', []))
        for neighborhood in self.neighborhoods:
            words = neighborhood.split()
            proper = ' '.join(w if (i and w in _lower_glue) else w.capitalize()
                              for i, w in enumerate(words))
            self.agenda_entities[neighborhood] = proper
        
        # Build the surname index from people names. Each name token is sorted
        # into one of two buckets:
        #   known_surnames   — capitalized unconditionally (not a common word,
        #                      or explicitly allowlisted).
        #   context_surnames — a common English word that is ALSO a surname
        #                      (e.g. "Young", "Dock"); only capitalized when
        #                      preceded by a title/role, so "councilwoman young"
        #                      becomes "...Young" but "young people" is left alone.
        # Role/title words from names like "Chair Clendenin", config-protected
        # words, and ambiguous months are rejected outright.
        _always_lower = set(w.lower() for w in self.special_rules.get('always_lowercase', []))
        self._always_lower = _always_lower
        self._always_upper = set(w.lower() for w in self.special_rules.get('always_uppercase', []))
        self.known_surnames = {}
        self.context_surnames = {}

        # Speaker-label roster: the authoritative list of people who actually
        # spoke in meetings (council/CRA members, staff, recurring guests).
        # Built by build_speaker_roster.py, which also decides which single
        # names are safe to capitalize on their own (`single_word_names`).
        roster = {}
        roster_path = Path(roster_file)
        if roster_path.exists():
            with open(roster_path, 'r') as f:
                roster = json.load(f)
        roster_standalone = set(k.lower() for k in roster.get('single_word_names', {}))

        def _register_surname(token: str):
            t = token.lower().rstrip('.')
            if (len(t) < 3 or not t.isalpha()
                    or t in _NON_SURNAME_WORDS or t in self.skip_words
                    or t in _always_lower or t in _AMBIGUOUS_MONTHS):
                return
            if self._common_words:
                standalone = t not in self._common_words or t in self.name_allowlist
            else:
                # No dictionary on this machine: only the roster's own
                # classification is trusted for standalone use.
                standalone = t in roster_standalone or t in self.name_allowlist
            if standalone:
                self.known_surnames[t] = token
            elif t not in self.known_surnames:
                self.context_surnames[t] = token

        for name in list(hybrid_data['people'].keys()):
            parts = name.split()
            if len(parts) == 1:
                _register_surname(parts[0])
            elif len(parts) >= 2:
                last = parts[-1]
                if '-' in last:
                    for hp in last.split('-'):
                        _register_surname(hp)
                else:
                    _register_surname(last)
                _register_surname(parts[0])

        for key, proper in roster.get('full_names', {}).items():
            self.agenda_entities[key] = proper
            tokens = proper.split()
            _register_surname(tokens[0])
            _register_surname(tokens[-1])
        roster_names = len(roster.get('full_names', {}))

        print(f"  ✓ Loaded {len(self.agenda_entities)} agenda entities")
        print(f"  ✓ Built {len(self.known_surnames)} surname index "
              f"(+{len(self.context_surnames)} title-gated)")
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
    
    def _is_common_word_context_tokens(self, word: str, prev_word: str, next_word: str) -> bool:
        """Return True when a context-sensitive word (it/us) is a pronoun, not an acronym."""
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
        # Organization names harvested with a leading article ("The Tampa
        # Convention Center") are matched without it, so mid-sentence "the"
        # stays lowercase and the sentence-start rule handles the rest.
        self.multiword_agenda = {}
        for k, v in self.agenda_entities.items():
            if ' ' in v or '-' in v:
                if k.startswith('the ') and len(k.split()) > 2:
                    k, v = k[4:], v[4:]
                self.multiword_agenda[k] = v

        # Sort multi-word by length (longest first) for greedy matching
        self.multiword_patterns = sorted(
            list(self.multiword_standard.keys()) + list(self.multiword_agenda.keys()),
            key=len,
            reverse=True
        )

        # Street address pattern: optional house number, optional direction,
        # one to three name words, a street suffix. Whether a match is
        # capitalized is decided in _capitalize_street_match, which requires a
        # house number, a direction, or a name from the generated street list
        # — a bare "<word> street" ("across the street") is left alone.
        suffix_alts = '|'.join(re.escape(s) for s in sorted(self.street_suffixes, key=len, reverse=True))
        self.street_pattern = re.compile(
            r'(?<![$\d.,])\b(?:(\d+(?:st|nd|rd|th)?)\s+)?'
            r'((?:north|south|east|west|n|s|e|w)\.?\s+)?'
            r"((?:[a-z][a-z']*\s+){0,2}[a-z][a-z']*)\s+"
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
        
        # Step 1.5: Street/address capitalization
        text_lower = self.street_pattern.sub(self._capitalize_street_match, text_lower)
        
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

                        # Skip generic descriptions GLiNER mislabels as people:
                        # a multi-word phrase ending in a common demographic noun
                        # ("young lady", "young man", "young people", "small
                        # business owners"). A real personal name does not end in
                        # one of these words, so genuine names are unaffected.
                        ent_tokens = [re.sub(r"[^\w]", '', w).lower() for w in entity_text.split()]
                        if len(ent_tokens) > 1 and ent_tokens[-1] in _GENERIC_PERSON_NOUNS:
                            continue
                        # An "entity" made only of ordinary words ("they",
                        # "the mayor", "running") is a mislabel unless one of
                        # its words is a name we already know.
                        if (self._common_words
                                and all(t in self._common_words for t in ent_tokens if t)
                                and not any(t in self.known_surnames or t in self.agenda_entities
                                            for t in ent_tokens)):
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
                            elif clean_w in self.known_surnames:
                                # Defer to our authoritative casing so GLiNER does
                                # not flatten intercaps names ("McCray" -> "Mccray").
                                proper_parts.append(lead_w + self.known_surnames[clean_w] + suffix_w + trail_w)
                            elif clean_w in self.context_surnames:
                                proper_parts.append(lead_w + self.context_surnames[clean_w] + suffix_w + trail_w)
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
                    
            except Exception as e:  # noqa: BLE001 — NER is best-effort, but say so
                logger.warning("GLiNER failed on a segment (%s: %s); continuing without it",
                               type(e).__name__, e)
        
        # Step 2.6: Replace GLiNER multi-word entities
        for pattern, proper in sorted(gliner_multiword.items(), key=lambda x: len(x[0]), reverse=True):
            if pattern in text_lower.lower():
                text_lower = re.sub(
                    r'\b' + re.escape(pattern) + r'\b',
                    proper,
                    text_lower,
                    flags=re.IGNORECASE
                )
        
        # Step 3: Tokenize and decide each word. The lookups run first and the
        # sentence-start rule only fills in when nothing knows the word, so a
        # name at the start of a sentence keeps its own casing ("McCray, you
        # have the floor").
        words = text_lower.split()
        capitalized_words = []

        def _tok(j):
            """Bare lowercase token at position j ('' when out of range)."""
            if 0 <= j < len(words):
                m = re.match(r"^[^\w]*([\w']+)[^\w]*$", words[j])
                return m.group(1).lower() if m else ''
            return ''

        for i, word in enumerate(words):
            match = re.match(r'^([^\w]*)(.+?)([^\w]*)$', word)
            if match:
                leading_punct, word_core, trailing_punct = match.groups()
            else:
                leading_punct = trailing_punct = ''
                word_core = word

            # Already cased by a multi-word replacement above
            if word_core and word_core[0].isupper():
                capitalized_words.append(word)
                continue

            # Possessive suffix ('s or ')
            suffix = ''
            base_core = word_core
            if len(word_core) > 2 and word_core.lower().endswith("'s"):
                suffix = word_core[-2:]
                base_core = word_core[:-2]
            elif len(word_core) > 1 and word_core.endswith("'"):
                suffix = "'"
                base_core = word_core[:-1]

            base_clean = re.sub(r'[^\w-]', '', base_core).lower()
            if not base_clean:
                capitalized_words.append(word)
                continue

            sentence_start = i == 0 or _is_sentence_end(words[i - 1])
            proper = self._proper_form(base_core, base_clean, _tok(i - 1), _tok(i + 1),
                                       _tok(i + 2), gliner_entities, prev2_tok=_tok(i - 2))
            if proper is None:
                proper = _case_name(base_core) if sentence_start else base_core
            capitalized_words.append(leading_punct + proper + suffix + trailing_punct)

        return ' '.join(capitalized_words)

    def _capitalize_street_match(self, m) -> str:
        """Case one street-pattern match, or return it untouched.

        Capitalizes when the address carries a house number or a direction,
        or when the name is a known street (agenda addresses) or neighborhood
        ("Bayshore Boulevard"). Leading stop words are not part of the name
        ("on kennedy boulevard" -> "on Kennedy Boulevard")."""
        number, direction, name_part, suffix = m.group(1), m.group(2) or '', m.group(3), m.group(4)
        name_words = name_part.split()
        # Trim stop words off the front; a stop word at the end means this is
        # not an address at all ("walk across the street").
        while name_words and name_words[0].lower() in _STREET_STOP:
            name_words.pop(0)
        if (len(name_words) > 1 and not direction.strip()
                and name_words[0].lower().rstrip('.') in _DIRECTIONS):
            direction = name_words.pop(0) + ' '
        if not name_words or name_words[-1].lower() in _STREET_STOP:
            return m.group(0)
        # The name is the longest trailing run of words that is a listed
        # street or neighborhood; with a house number or direction and no
        # listed name, the whole run counts ("1505 north florida avenue").
        known_len = 0
        for k in range(len(name_words), 0, -1):
            key = ' '.join(w.lower() for w in name_words[-k:])
            if key in self.streets or key in self.neighborhoods:
                known_len = k
                break
        if known_len:
            name_words = name_words[-known_len:]
        elif not (number or direction.strip()):
            return m.group(0)
        # Rebuild: untouched prefix words, then the cased address
        prefix_len = len(name_part.split()) - len(name_words) - (1 if direction and not m.group(2) else 0)
        prefix = ' '.join(name_part.split()[:prefix_len])
        if direction.strip():
            d = direction.strip()
            if len(d.rstrip('.')) == 1:
                direction = d.upper() + ' '
            else:
                direction = d.capitalize() + ' '
        name_cap = ' '.join(self.known_surnames.get(w.lower(), _case_name(w)) for w in name_words)
        out = f"{number + ' ' if number else ''}{direction}{name_cap} {suffix.capitalize()}"
        if prefix:
            # The stop words we trimmed sit between the house number/direction
            # (which only match adjacent to the name) and the name, so a
            # prefix only exists when neither is present.
            out = f"{prefix} {out}"
        return out

    def _name_like(self, tok: str) -> bool:
        """A token that reads as a personal name: a known name, or a word
        the dictionary does not list in lowercase (no dictionary → known only)."""
        if not tok or not tok.isalpha():
            return False
        if tok in self.known_surnames or tok in self.context_surnames or tok in self.agenda_entities:
            return True
        return bool(self._common_words) and tok not in self._common_words

    def _date_like(self, prev_tok: str, next_tok: str, next2_tok: str) -> bool:
        """Is an ambiguous month word ("may") being used as a date here?"""
        if re.match(r'^\d{1,4}(st|nd|rd|th)?$', next_tok):
            return True                       # "May 7", "March 26th"
        if re.match(r'^\d{4}$', prev_tok):
            return True                       # "2026 May"
        if next_tok == 'of' and re.match(r'^\d{4}$', next2_tok):
            return True                       # "May of 2025"
        return prev_tok in _MONTH_CONTEXT_PREV and next_tok not in _MONTH_NOT_NEXT

    def _proper_form(self, base_core: str, base_clean: str, prev_tok: str,
                     next_tok: str, next2_tok: str, gliner_entities: dict, prev2_tok: str = ''):
        """The cased form of one word, or None when nothing knows it (the
        caller then applies the sentence-start rule or leaves it lowercase).

        Order matters: fixed forms (I, acronyms, titles) first, then explicit
        lowercase/skip lists, then the entity lookups from most to least
        authoritative."""
        # "I" and its contractions (the apostrophe is stripped from base_clean)
        if base_clean == 'i':
            return 'I'
        if base_core.lower().startswith("i'") and len(base_core) <= 5:
            return 'I' + base_core[1:]

        # it/us: pronoun unless the context says IT department / the US
        if base_clean in _CONTEXT_SENSITIVE:
            if self._is_common_word_context_tokens(base_clean, prev_tok, next_tok):
                return None
            return base_core.upper()

        if base_clean in self.acronyms or base_clean in self._always_upper:
            return base_core.upper()

        # Acronym plurals: "cras" -> "CRAs". Never when the plural is itself
        # an ordinary word ("its") or the stem is context-sensitive.
        if (len(base_clean) > 2 and base_clean.endswith('s')
                and base_clean[:-1] in self.acronyms
                and base_clean[:-1] not in _CONTEXT_SENSITIVE
                and base_clean not in self._common_words):
            return base_core[:-1].upper() + 's'

        if base_clean in _TITLE_ABBREVS:
            # "miss" is also a verb: only a title when a name follows
            if base_clean == 'miss' and not self._name_like(next_tok):
                return None
            return base_core[0].upper() + base_core[1:]
        if prev_tok in _TITLE_ABBREVS and base_clean not in self._always_lower:
            return self.known_surnames.get(base_clean, _case_name(base_core))
        # A role word in front of a known name is part of the address:
        # "Councilwoman Hurtak", "Chairman Reddick", "Pastor Jones".
        if (base_clean in _ROLE_TITLES and next_tok
                and (next_tok in self.known_surnames or next_tok in self.context_surnames
                     or next_tok in self.agenda_entities)):
            return base_core[0].upper() + base_core[1:]
        # …and the word after that when it is not an ordinary word either
        # ("Ms. Carroll Ann Bennett"; "Mr. Chairman, we" stops at "we").
        if (prev2_tok in _TITLE_ABBREVS and base_clean.isalpha()
                and self._common_words and base_clean not in self._common_words):
            return self.known_surnames.get(base_clean, _case_name(base_core))

        # Hyphenated names: each part cased, known surnames kept intact
        if '-' in base_clean and len(base_clean) > 2:
            parts = base_clean.split('-')
            is_name_like = any(
                p in self.standard_lookup or p in self.agenda_entities
                or p in self.known_surnames or p in gliner_entities
                for p in parts if len(p) > 1
            )
            if is_name_like:
                return '-'.join(self.known_surnames.get(p, p.capitalize()) for p in parts)

        if base_clean in self._always_lower or base_clean in self.skip_words:
            return None

        if base_clean in _AMBIGUOUS_MONTHS and not self._date_like(prev_tok, next_tok, next2_tok):
            return None

        if base_clean in self.standard_lookup:
            return self.standard_lookup[base_clean]
        if base_clean in self.agenda_entities:
            return self.agenda_entities[base_clean]
        if base_clean in self.known_surnames:
            return self.known_surnames[base_clean]
        # Common-word surnames only after a title/role: "councilwoman young"
        if base_clean in self.context_surnames and prev_tok in _NAME_TITLE_PREV:
            return self.context_surnames[base_clean]
        if base_clean in gliner_entities:
            return gliner_entities[base_clean]
        return None
    
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
        default=str(_DATA_DIR / 'standard_entities.json'),
        help='Path to standard entities database'
    )
    parser.add_argument(
        '--hybrid-entities',
        default=str(_DATA_DIR / 'hybrid_entity_database.json'),
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
