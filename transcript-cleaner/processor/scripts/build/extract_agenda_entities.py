#!/usr/bin/env python3
"""
Hybrid Entity Extraction: Combines rule-based patterns + GLiNER ML model

APPROACH:
1. Use regex patterns for high-precision entities (departments, file numbers, titles)
2. Use GLiNER for hard-to-pattern entities (person names, new orgs)
3. Cross-validate: If both methods agree, high confidence
4. Frequency filtering: Entities in multiple agendas = more reliable
5. Context validation: Check if entity makes sense in context

BENEFITS:
- Catches edge cases that regex misses (unusual names, new organizations)
- Filters out GLiNER false positives using rule-based validation
- Frequency scoring improves over time with more agendas
"""

import json
import re
from pathlib import Path
from collections import defaultdict, Counter
from typing import Dict, List, Set, Tuple

try:
    from gliner import GLiNER
    HAS_GLINER = True
except ImportError:
    HAS_GLINER = False
    print("GLiNER not available - using rule-based only")


class HybridEntityExtractor:
    """Combines rule-based patterns with GLiNER ML model"""
    
    def __init__(self, use_gliner=True):
        self.use_gliner = use_gliner and HAS_GLINER
        
        if self.use_gliner:
            print("Loading GLiNER model...")
            self.model = GLiNER.from_pretrained("urchade/gliner_small-v2.1")
            print("✓ GLiNER loaded\n")
        else:
            self.model = None
            print("Using rule-based extraction only\n")
    
    # =========================================================================
    # RULE-BASED EXTRACTION (High Precision)
    # =========================================================================
    
    def extract_people_rules(self, text: str) -> Set[str]:
        """Extract person names using reliable patterns"""
        names = set()
        
        # False positive keywords
        NOT_PERSON = {
            'file', 'no', 'the', 'city', 'clerk', 'department', 'resolution',
            'county', 'ordinance', 'section', 'chapter', 'code', 'tampa',
            'business', 'contract', 'equal', 'opportunity', 'mobility', 'solid',
            'waste', 'fire', 'rescue', 'police', 'water', 'special', 'event',
            'permit', 'community', 'engagement', 'quality', 'assurance', 'cost',
            'monitoring', 'environmental', 'program', 'management', 'change',
            'order', 'office', 'florida', 'statutes', 'hillsborough', 'district',
            'officer', 'ave', 'blvd', 'st', 'street', 'road', 'properties',
            'services', 'inc', 'llc', 'corporation', 'company', 'industrial',
            'zoning', 'mixed', 'use', 'system', 'technologies', 'solutions'
        }
        
        # High-confidence patterns
        patterns = [
            # Title + Name (e.g., "Chief Barbara Tripp")
            r'\b(?:Mr\.|Ms\.|Mrs\.|Dr\.|Detective|Officer|Chief|Director|Coordinator|Chair|Vice Chair|Councilman|Councilwoman|Mayor)\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b',
            
            # "Memorandum from NAME"
            r'\bMemorandum from\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b',
            
            # "initiated by NAME"
            r'\binitiated by\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\b',
            
            # "Chair, NAME"
            r'\bChair,\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b',
        ]
        
        for pattern in patterns:
            for match in re.finditer(pattern, text):
                name = match.group(1).strip()
                # Validate
                if not any(word.lower() in NOT_PERSON for word in name.split()):
                    if 2 <= len(name.split()) <= 4:  # Reasonable name length
                        names.add(name)
        
        return names
    
    def extract_organizations_rules(self, text: str) -> Set[str]:
        """Extract organizations using reliable patterns"""
        orgs = set()
        
        patterns = [
            r'\b(Tampa (?:Police|Fire|Water|Parks and Recreation|Convention|Housing) Department)\b',
            r'\b(Department of (?:Housing|Transportation|Solid Waste|Financial Services|Law|Homeland Security|Interior|Environmental Protection|Justice|Health|Veterans Affairs|Defense)(?:\s+and\s+[A-Z][a-zA-Z\s]+)?)\b',
            r'\b(Community Redevelopment Agency(?:\s+of\s+the\s+City\s+of\s+Tampa)?)\b',
            r'\b(City Council(?:\s+of\s+the\s+City\s+of\s+Tampa)?)\b',
            r'\b(Law Firm of [A-Z][a-z,\s&\.]+(?:P\.A\.|LLC|Inc\.)?)\b',
            r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\s+(?:Church|School|Center|Hospital|Foundation|Association|Institute|Academy|College|University))\b',
        ]
        
        for pattern in patterns:
            for match in re.finditer(pattern, text):
                org = match.group(1).strip()
                word_count = len(org.split())
                if 2 <= word_count <= 10:
                    orgs.add(org)
        
        return orgs
    
    # =========================================================================
    # GLINER ML EXTRACTION (High Recall)
    # =========================================================================
    
    def extract_people_gliner(self, text: str, threshold=0.6) -> Set[str]:
        """Extract person names using GLiNER"""
        if not self.model:
            return set()
        
        names = set()
        # Process in chunks to avoid truncation (GLiNER has 384 token limit)
        # Using 250 words per chunk to be conservative (tokens < words)
        chunk_size = 250
        words = text.split()
        
        for i in range(0, len(words), chunk_size):
            chunk = ' '.join(words[i:i+chunk_size])
            entities = self.model.predict_entities(chunk, ["person"], threshold=threshold)
            
            for e in entities:
                name = e['text'].strip()
                # Basic validation
                if len(name.split()) >= 2 and len(name.split()) <= 4:
                    # Filter obvious false positives
                    if not name.lower().startswith('the '):
                        names.add(name)
        
        return names
    
    def extract_organizations_gliner(self, text: str, threshold=0.5) -> Set[str]:
        """Extract organizations using GLiNER"""
        if not self.model:
            return set()
        
        orgs = set()
        # Process in chunks to avoid truncation (GLiNER has 384 token limit)
        # Using 250 words per chunk to be conservative (tokens < words)
        chunk_size = 250
        words = text.split()
        
        for i in range(0, len(words), chunk_size):
            chunk = ' '.join(words[i:i+chunk_size])
            entities = self.model.predict_entities(
                chunk, 
                ["organization", "company", "department"], 
                threshold=threshold
            )
            
            for e in entities:
                org = e['text'].strip()
                word_count = len(org.split())
                if 2 <= word_count <= 10:
                    if not org.lower().startswith('the '):
                        orgs.add(org)
        
        return orgs
    
    # =========================================================================
    # HYBRID COMBINATION
    # =========================================================================
    
    def extract_entities_hybrid(self, text: str) -> Dict[str, Dict[str, any]]:
        """
        Extract entities using both methods and combine with confidence scores
        
        Returns:
            {
                'people': {name: {'confidence': score, 'sources': [methods]}},
                'organizations': {...}
            }
        """
        result = {
            'people': {},
            'organizations': {}
        }
        
        # Extract with rules
        people_rules = self.extract_people_rules(text)
        orgs_rules = self.extract_organizations_rules(text)
        
        # Extract with GLiNER if available
        if self.use_gliner:
            people_gliner = self.extract_people_gliner(text)
            orgs_gliner = self.extract_organizations_gliner(text)
        else:
            people_gliner = set()
            orgs_gliner = set()
        
        # Combine with confidence scoring
        # Both methods agree = 1.0 confidence
        # Only rules = 0.9 confidence (high precision)
        # Only GLiNER = 0.5 confidence (needs validation)
        
        for name in people_rules:
            sources = ['rules']
            confidence = 0.9
            if name in people_gliner:
                sources.append('gliner')
                confidence = 1.0
            result['people'][name] = {'confidence': confidence, 'sources': sources}
        
        for name in people_gliner:
            if name not in result['people']:
                result['people'][name] = {'confidence': 0.5, 'sources': ['gliner']}
        
        for org in orgs_rules:
            sources = ['rules']
            confidence = 0.9
            if org in orgs_gliner:
                sources.append('gliner')
                confidence = 1.0
            result['organizations'][org] = {'confidence': confidence, 'sources': sources}
        
        for org in orgs_gliner:
            if org not in result['organizations']:
                result['organizations'][org] = {'confidence': 0.5, 'sources': ['gliner']}
        
        return result
    
    # =========================================================================
    # MULTI-AGENDA PROCESSING
    # =========================================================================
    
    def build_database_from_agendas(self, agenda_dir: Path) -> Dict:
        """Process all agendas and build frequency-weighted database"""
        
        entity_tracker = {
            'people': defaultdict(lambda: {'count': 0, 'confidence_sum': 0.0, 'agendas': set()}),
            'organizations': defaultdict(lambda: {'count': 0, 'confidence_sum': 0.0, 'agendas': set()}),
        }
        
        agenda_files = sorted(agenda_dir.glob('*.json'))
        print(f"Processing {len(agenda_files)} agenda files...")
        print("=" * 80)
        
        for idx, agenda_file in enumerate(agenda_files, 1):
            print(f"[{idx}/{len(agenda_files)}] Processing {agenda_file.name}...")
            
            with open(agenda_file) as f:
                data = json.load(f)
            
            # Extract from all text fields
            texts = []
            texts.append(data.get('meetingType', ''))
            for item in data.get('agendaItems', []):
                texts.append(item.get('title', ''))
                texts.append(item.get('background', ''))
            
            full_text = ' '.join(texts)
            
            # Extract entities
            entities = self.extract_entities_hybrid(full_text)
            
            # Track entities
            for name, info in entities['people'].items():
                entity_tracker['people'][name]['count'] += 1
                entity_tracker['people'][name]['confidence_sum'] += info['confidence']
                entity_tracker['people'][name]['agendas'].add(agenda_file.stem)
            
            for org, info in entities['organizations'].items():
                entity_tracker['organizations'][org]['count'] += 1
                entity_tracker['organizations'][org]['confidence_sum'] += info['confidence']
                entity_tracker['organizations'][org]['agendas'].add(agenda_file.stem)
        
        # Calculate final scores: (frequency * avg_confidence)
        final_db = {
            'people': {},
            'organizations': {},
            'metadata': {
                'total_agendas': len(agenda_files),
                'extraction_method': 'hybrid' if self.use_gliner else 'rules_only'
            }
        }
        
        for name, stats in entity_tracker['people'].items():
            avg_confidence = stats['confidence_sum'] / stats['count']
            final_score = stats['count'] * avg_confidence
            final_db['people'][name] = {
                'frequency': stats['count'],
                'confidence': round(avg_confidence, 2),
                'score': round(final_score, 2),
                'agendas': len(stats['agendas'])
            }
        
        for org, stats in entity_tracker['organizations'].items():
            avg_confidence = stats['confidence_sum'] / stats['count']
            final_score = stats['count'] * avg_confidence
            final_db['organizations'][org] = {
                'frequency': stats['count'],
                'confidence': round(avg_confidence, 2),
                'score': round(final_score, 2),
                'agendas': len(stats['agendas'])
            }
        
        # Sort by score
        final_db['people'] = dict(sorted(
            final_db['people'].items(), 
            key=lambda x: x[1]['score'], 
            reverse=True
        ))
        final_db['organizations'] = dict(sorted(
            final_db['organizations'].items(), 
            key=lambda x: x[1]['score'], 
            reverse=True
        ))
        
        return final_db
    
    def extract_speakers_from_transcripts(self, transcript_dir: Path) -> Dict[str, dict]:
        """
        Extract speaker names from transcript files.
        These are the most reliable names (council members, city staff who speak).
        
        Args:
            transcript_dir: Directory containing transcript JSON files
            
        Returns:
            Dict mapping speaker name to metadata
        """
        speakers = defaultdict(lambda: {'frequency': 0, 'confidence': 1.0, 'files': set()})
        
        # Find all transcript files
        transcript_files = sorted(transcript_dir.glob('transcript_*.json'))
        
        if not transcript_files:
            print(f"No transcript files found in {transcript_dir}")
            return {}
        
        print(f"Extracting speakers from {len(transcript_files)} transcript files...")
        
        for idx, transcript_file in enumerate(transcript_files, 1):
            # Skip test files
            if 'transcript-id' in transcript_file.name:
                continue
            
            print(f"  [{idx}/{len(transcript_files)}] {transcript_file.name}...", end='')
                
            try:
                with open(transcript_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                
                # Extract speaker names from segments
                for segment in data.get('segments', []):
                    speaker = segment.get('speaker', '').strip()
                    
                    if not speaker:
                        continue
                    
                    # Convert from ALL CAPS to Title Case
                    speaker_proper = ' '.join(word.capitalize() for word in speaker.split())
                    
                    # Skip generic labels
                    if speaker_proper.lower() in ['the clerk', 'clerk', 'speaker', 'unknown']:
                        continue
                    
                    # Validate it looks like a real name (2-4 words, capitalized)
                    words = speaker_proper.split()
                    if len(words) < 2 or len(words) > 4:
                        continue
                    
                    speakers[speaker_proper]['frequency'] += 1
                    speakers[speaker_proper]['files'].add(transcript_file.name)
                
                print(f" ✓ {len([s for s in data['segments'] if s.get('speaker')])} segments")
                    
            except Exception as e:
                print(f" ✗ Error: {e}")
                continue
        
        # Convert to final format
        speaker_db = {}
        for name, stats in speakers.items():
            # Calculate score: frequency * num_files (speakers in multiple meetings are more important)
            score = stats['frequency'] * len(stats['files'])
            speaker_db[name] = {
                'frequency': stats['frequency'],
                'confidence': 1.0,  # High confidence - these are explicitly labeled
                'score': round(score, 2),
                'files': len(stats['files'])
            }
        
        # Sort by score
        speaker_db = dict(sorted(speaker_db.items(), key=lambda x: x[1]['score'], reverse=True))
        
        print(f"  ✓ Found {len(speaker_db)} unique speakers")
        
        return speaker_db
    
    def build_database_with_speakers(self, agenda_dir: Path, transcript_dir: Path) -> Dict:
        """
        Build entity database combining agendas AND transcript speakers.
        
        Args:
            agenda_dir: Directory with agenda JSON files
            transcript_dir: Directory with transcript JSON files
            
        Returns:
            Combined entity database
        """
        # Extract from agendas
        agenda_db = self.build_database_from_agendas(agenda_dir)
        
        # Extract from transcripts
        speaker_db = self.extract_speakers_from_transcripts(transcript_dir)
        
        # Merge speakers into people
        # Speakers get priority - they're explicitly labeled
        for speaker, stats in speaker_db.items():
            speaker_lower = speaker.lower()
            
            # Check if already in agenda database
            existing = None
            for name in agenda_db['people'].keys():
                if name.lower() == speaker_lower:
                    existing = name
                    break
            
            if existing:
                # Merge: use speaker capitalization, sum scores
                old_stats = agenda_db['people'].pop(existing)
                agenda_db['people'][speaker] = {
                    'frequency': stats['frequency'] + old_stats['frequency'],
                    'confidence': 1.0,  # Upgrade to high confidence
                    'score': stats['score'] + old_stats['score'],
                    'agendas': old_stats.get('agendas', 0),
                    'transcripts': stats['files']
                }
            else:
                # New speaker not in agendas
                agenda_db['people'][speaker] = {
                    'frequency': stats['frequency'],
                    'confidence': 1.0,
                    'score': stats['score'],
                    'agendas': 0,
                    'transcripts': stats['files']
                }
        
        # Re-sort by score
        agenda_db['people'] = dict(sorted(
            agenda_db['people'].items(),
            key=lambda x: x[1]['score'],
            reverse=True
        ))
        
        return agenda_db


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Build hybrid entity database from agendas and transcripts')
    parser.add_argument('--agenda-dir', type=Path, default=Path('data/agendas'),
                        help='Directory containing agenda JSON files')
    parser.add_argument('--transcript-dir', type=Path, default=Path('data/transcripts'),
                        help='Directory containing transcript JSON files')
    parser.add_argument('--output', type=Path, default=Path('data/hybrid_entity_database.json'),
                        help='Output file for hybrid entity database')
    args = parser.parse_args()
    
    extractor = HybridEntityExtractor(use_gliner=HAS_GLINER)
    
    # Build database from both agendas and transcripts
    db = extractor.build_database_with_speakers(args.agenda_dir, args.transcript_dir)
    
    # Save
    with open(args.output, 'w') as f:
        json.dump(db, f, indent=2, default=str)
    
    print(f"\n{'=' * 80}")
    print("HYBRID DATABASE BUILT")
    print("=" * 80)
    print(f"Method: {db['metadata']['extraction_method']}")
    print(f"Total agendas: {db['metadata']['total_agendas']}")
    print(f"People: {len(db['people'])} unique names")
    print(f"Organizations: {len(db['organizations'])} unique orgs")
    print(f"\nSaved to: {args.output}")
    
    # Show top entities with scores
    print(f"\n{'=' * 80}")
    print("TOP PEOPLE (by score = frequency × confidence):")
    print("=" * 80)
    print(f"{'Name':<35s} {'Freq':<6s} {'Conf':<6s} {'Score':<8s} {'Agendas'}")
    print("-" * 80)
    for name, stats in list(db['people'].items())[:20]:
        print(f"{name:<35s} {stats['frequency']:<6d} {stats['confidence']:<6.2f} {stats['score']:<8.2f} {stats['agendas']}")
    
    print(f"\n{'=' * 80}")
    print("TOP ORGANIZATIONS:")
    print("=" * 80)
    print(f"{'Organization':<50s} {'Freq':<6s} {'Conf':<6s} {'Score':<8s}")
    print("-" * 80)
    for org, stats in list(db['organizations'].items())[:20]:
        print(f"{org:<50s} {stats['frequency']:<6d} {stats['confidence']:<6.2f} {stats['score']:<8.2f}")
