#!/usr/bin/env python3
"""
Test capitalization on raw ALL CAPS transcript using our new entity databases.

NO comparison to old processed transcripts.
Just: ALL CAPS → New capitalizer → See what we get
"""

import json
from pathlib import Path

def test_new_capitalizer():
    """Test the new capitalizer on raw ALL CAPS input."""
    
    print("=" * 80)
    print("FRESH TEST: ALL CAPS → New Capitalizer")
    print("=" * 80)
    print()
    
    # Load the ALL CAPS test we created
    with open('data/test_transcript_2640_ALL_CAPS.json', 'r') as f:
        all_caps = json.load(f)
    
    print(f"Input: {len(all_caps['segments'])} ALL CAPS segments")
    print()
    
    # Run through new capitalizer
    print("Running capitalizer...")
    import subprocess
    
    result = subprocess.run([
        './venv/bin/python3',
        'capitalize_transcript.py',
        'data/test_transcript_2640_ALL_CAPS.json',
        'data/test_NEW_OUTPUT.json'
    ], capture_output=True, text=True)
    
    if result.returncode != 0:
        print("ERROR:")
        print(result.stderr)
        return
    
    print(result.stdout)
    
    # Load the output
    with open('data/test_NEW_OUTPUT.json', 'r') as f:
        new_output = json.load(f)
    
    # Write detailed report
    report = []
    report.append("=" * 80)
    report.append("NEW CAPITALIZER OUTPUT ANALYSIS")
    report.append("=" * 80)
    report.append("")
    report.append(f"Segments processed: {len(new_output['segments'])}")
    report.append("")
    
    # Show first 10 segments in detail
    report.append("=" * 80)
    report.append("FIRST 10 SEGMENTS")
    report.append("=" * 80)
    report.append("")
    
    for i, seg in enumerate(new_output['segments'][:10], 1):
        report.append(f"Segment {i}:")
        if 'speaker' in seg:
            report.append(f"  Speaker: {seg['speaker']}")
        if 'timestamp' in seg:
            report.append(f"  Time: {seg['timestamp']}")
        if 'text' in seg:
            report.append(f"  Text: {seg['text']}")
        report.append("")
    
    # Check specific test terms in the output
    report.append("=" * 80)
    report.append("SPECIFIC TERM CHECKS")
    report.append("=" * 80)
    report.append("")
    
    test_terms = [
        'Tyler Wilcox',
        'World War II',
        'African American',
        'Christmas',
        'MacDill Air Force Base',
        'Mussolini',
        'Italy',
        'Vietnam',
        'God',
        'Tampa City Council',
        'Brandon Campbell',
    ]
    
    # Get all text
    all_text = ' '.join(s.get('text', '') for s in new_output['segments'])
    
    import re
    for term in test_terms:
        pattern = re.compile(r'.{50}' + re.escape(term) + r'.{50}', re.IGNORECASE)
        matches = pattern.findall(all_text)
        
        if matches:
            report.append(f"✓ FOUND: {term}")
            report.append(f"  Context: ...{matches[0]}...")
        else:
            # Try to find lowercase version
            lower_pattern = re.compile(r'.{50}' + re.escape(term.lower()) + r'.{50}', re.IGNORECASE)
            lower_matches = lower_pattern.findall(all_text)
            if lower_matches:
                report.append(f"✗ MISSED: {term} (found as lowercase)")
                report.append(f"  Context: ...{lower_matches[0]}...")
            else:
                report.append(f"- NOT IN TEXT: {term}")
        report.append("")
    
    # Write report
    output_file = Path("new_capitalizer_test_report.txt")
    with open(output_file, 'w') as f:
        f.write('\n'.join(report))
    
    print(f"\n✓ Report written to: {output_file}")
    print(f"\nOutput transcript: data/test_NEW_OUTPUT.json")

if __name__ == "__main__":
    test_new_capitalizer()
