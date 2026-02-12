#!/usr/bin/env python3
"""
Generate metadata file for all agenda JSON files.
"""

import json
from pathlib import Path
from datetime import datetime
from typing import List, Dict
import re

def parse_filename(filename: str) -> tuple:
    """Extract meeting ID and date from filename."""
    # Format: meeting_2665_2025-10-23.json
    match = re.match(r'meeting_(\d+)_(\d{4}-\d{2}-\d{2})\.json', filename)
    if match:
        return match.group(1), match.group(2)
    return None, None

def load_agenda_metadata(filepath: Path) -> Dict:
    """Load basic metadata from agenda JSON."""
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    return {
        'meetingId': data.get('meetingId'),
        'meetingType': data.get('meetingType'),
        'meetingDate': data.get('meetingDate'),
        'sourceUrl': data.get('sourceUrl'),
        'agendaItemCount': len(data.get('agendaItems', []))
    }

def generate_metadata(agendas_dir: Path) -> List[Dict]:
    """Generate metadata for all agenda files."""
    metadata_list = []
    
    agenda_files = sorted(agendas_dir.glob('meeting_*.json'))
    
    for filepath in agenda_files:
        meeting_id, date_str = parse_filename(filepath.name)
        
        if not meeting_id or not date_str:
            print(f"Warning: Could not parse filename: {filepath.name}")
            continue
        
        try:
            agenda_meta = load_agenda_metadata(filepath)
            
            metadata = {
                'filename': filepath.name,
                'meetingId': meeting_id,
                'date': date_str,
                'meetingType': agenda_meta.get('meetingType', 'unknown'),
                'meetingDateFull': agenda_meta.get('meetingDate'),
                'agendaItemCount': agenda_meta.get('agendaItemCount', 0),
                'sourceUrl': agenda_meta.get('sourceUrl'),
                'filepath': f'processor/data/agendas/{filepath.name}'
            }
            
            metadata_list.append(metadata)
            print(f"✓ Processed: {filepath.name}")
            
        except Exception as e:
            print(f"✗ Error processing {filepath.name}: {e}")
    
    return metadata_list

def analyze_coverage(metadata_list: List[Dict]) -> Dict:
    """Analyze date coverage and identify gaps."""
    dates = sorted([item['date'] for item in metadata_list])
    
    if not dates:
        return {}
    
    start_date = datetime.strptime(dates[0], '%Y-%m-%d')
    end_date = datetime.strptime(dates[-1], '%Y-%m-%d')
    total_days = (end_date - start_date).days
    
    # Group by month
    by_month = {}
    for item in metadata_list:
        month = item['date'][:7]  # YYYY-MM
        if month not in by_month:
            by_month[month] = []
        by_month[month].append(item)
    
    return {
        'totalMeetings': len(metadata_list),
        'dateRange': {
            'start': dates[0],
            'end': dates[-1],
            'totalDays': total_days
        },
        'byMonth': {
            month: len(items) for month, items in sorted(by_month.items())
        },
        'meetingTypes': {
            mtype: len([m for m in metadata_list if m['meetingType'] == mtype])
            for mtype in set(m['meetingType'] for m in metadata_list)
        }
    }

def main():
    """Main function."""
    # Get agendas directory
    script_dir = Path(__file__).parent
    agendas_dir = script_dir / 'data' / 'agendas'
    
    if not agendas_dir.exists():
        print(f"Error: Agendas directory not found: {agendas_dir}")
        return
    
    print(f"\nScanning agenda files in: {agendas_dir}")
    print("=" * 60)
    
    # Generate metadata
    metadata_list = generate_metadata(agendas_dir)
    
    # Analyze coverage
    coverage = analyze_coverage(metadata_list)
    
    # Create output structure
    output = {
        'generated': datetime.now().isoformat(),
        'coverage': coverage,
        'meetings': metadata_list
    }
    
    # Write metadata file
    output_file = script_dir / 'data' / 'meetings_metadata.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print("\n" + "=" * 60)
    print(f"✓ Metadata file created: {output_file}")
    print(f"\nSummary:")
    print(f"  Total meetings: {coverage['totalMeetings']}")
    print(f"  Date range: {coverage['dateRange']['start']} to {coverage['dateRange']['end']}")
    print(f"  Total days: {coverage['dateRange']['totalDays']}")
    print(f"\n  Meetings by month:")
    for month, count in coverage['byMonth'].items():
        print(f"    {month}: {count} meetings")
    print(f"\n  Meeting types:")
    for mtype, count in coverage['meetingTypes'].items():
        print(f"    {mtype}: {count} meetings")

if __name__ == '__main__':
    main()
