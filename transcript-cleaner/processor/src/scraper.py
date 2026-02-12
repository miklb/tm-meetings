"""
Scraper

Web scraper for fetching transcripts from Tampa City Council website.
"""

import requests
from bs4 import BeautifulSoup
from pathlib import Path
import logging
from typing import Optional, Dict, Any
import time
import re
import json
from datetime import datetime

logger = logging.getLogger(__name__)


class TranscriptScraper:
    """Scrape transcripts from Tampa Gov website."""
    
    BASE_URL = "https://apps.tampagov.net/cttv_cc_webapp"
    
    def __init__(self, output_dir: Path = None):
        """
        Initialize the scraper.
        
        Args:
            output_dir: Directory to save scraped transcripts
        """
        self.output_dir = output_dir or Path("data/transcripts")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.session = requests.Session()
        logger.info("TranscriptScraper initialized")
    
    def fetch_transcript(self, meeting_id: str) -> Optional[Dict[str, Any]]:
        """
        Fetch and parse transcript for a specific meeting.
        
        Args:
            meeting_id: Meeting ID (e.g., "2639")
            
        Returns:
            Dictionary with meeting info and transcript segments
        """
        url = f"{self.BASE_URL}/Agenda.aspx?pkey={meeting_id}"
        
        try:
            response = self.session.get(url, timeout=30)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.content, 'html.parser')
            
            # Extract all text
            all_text = soup.get_text()
            lines = [l.strip() for l in all_text.split('\n') if l.strip()]
            
            # Parse transcript
            result = self._parse_transcript_lines(lines, meeting_id, url)
            
            logger.info(f"Fetched transcript for meeting {meeting_id}: {len(result['segments'])} segments")
            return result
            
        except requests.RequestException as e:
            logger.error(f"Failed to fetch transcript {meeting_id}: {e}")
            return None
    
    def _parse_transcript_lines(self, lines: list, meeting_id: str, url: str) -> Dict[str, Any]:
        """
        Parse transcript lines into structured data.
        
        Args:
            lines: List of text lines from the page
            meeting_id: Meeting ID
            url: Source URL
            
        Returns:
            Dictionary with meeting info and segments
        """
        # Extract meeting header (usually lines 4-6)
        meeting_title = None
        meeting_date_time = None
        disclaimer = None
        
        for i, line in enumerate(lines[:20]):
            if 'TAMPA CITY COUNCIL' in line:
                meeting_title = line
            elif re.match(r'[A-Z]+DAY,', line):  # THURSDAY, OCTOBER 23, 2025...
                meeting_date_time = line
            elif 'DISCLAIMER:' in line:
                # Collect disclaimer text
                disclaimer_lines = []
                for j in range(i+1, min(i+10, len(lines))):
                    if re.match(r'\d{1,2}:\d{2}:\d{2}[AP]M', lines[j]):
                        break
                    disclaimer_lines.append(lines[j])
                disclaimer = ' '.join(disclaimer_lines)
                break
        
        # Parse transcript segments
        segments = []
        current_timestamp = None
        current_speaker = None
        current_text = []
        
        # Pattern: HH:MM:SSAM   >>SPEAKER NAME:
        timestamp_speaker_pattern = re.compile(r'^(\d{1,2}:\d{2}:\d{2}[AP]M)\s+>>([^:]+):')
        # Pattern to detect timestamp continuation without speaker
        timestamp_only_pattern = re.compile(r'^\d{1,2}:\d{2}:\d{2}[AP]M\s+>>')
        
        for line in lines:
            match = timestamp_speaker_pattern.match(line)
            
            if match:
                # Save previous segment
                if current_speaker and current_text:
                    segments.append({
                        'timestamp': current_timestamp,
                        'speaker': current_speaker,
                        'text': ' '.join(current_text)
                    })
                
                # Start new segment
                current_timestamp = match.group(1)
                current_speaker = match.group(2).strip()
                current_text = []
            
            elif current_speaker:
                # Skip lines that start with timestamp continuation (no speaker change)
                if timestamp_only_pattern.match(line):
                    continue
                
                # Skip lines that are clearly not transcript content
                if line and not line.startswith('Tampa City Council') and not line.startswith('Skip to'):
                    current_text.append(line)
        
        # Add final segment
        if current_speaker and current_text:
            segments.append({
                'timestamp': current_timestamp,
                'speaker': current_speaker,
                'text': ' '.join(current_text)
            })
        
        return {
            'meeting_id': meeting_id,
            'url': url,
            'meeting_title': meeting_title,
            'meeting_date_time': meeting_date_time,
            'disclaimer': disclaimer,
            'segments': segments,
            'segment_count': len(segments)
        }
    
    def save_transcript(self, transcript_data: Dict[str, Any], 
                       meeting_date: Optional[str] = None) -> Path:
        """
        Save transcript to JSON file.
        
        Args:
            transcript_data: Transcript dictionary from fetch_transcript
            meeting_date: Optional date in YYYY-MM-DD format (for filename)
            
        Returns:
            Path to saved file
        """
        meeting_id = transcript_data['meeting_id']
        
        # Use provided date or extract from meeting_date_time
        if meeting_date:
            date_str = meeting_date
        else:
            date_str = "unknown_date"
        
        filename = f"transcript_{meeting_id}_{date_str}.json"
        output_path = self.output_dir / filename
        
        # Add metadata
        transcript_data['scraped_at'] = datetime.now().isoformat()
        
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(transcript_data, f, indent=2, ensure_ascii=False)
        
        logger.info(f"Saved transcript to {output_path}")
        return output_path
    
    def fetch_and_save(self, meeting_id: str, meeting_date: Optional[str] = None) -> Optional[Path]:
        """
        Fetch and save transcript in one operation.
        
        Args:
            meeting_id: Meeting ID
            meeting_date: Optional date in YYYY-MM-DD format (for filename)
            
        Returns:
            Path to saved file or None if failed
        """
        transcript_data = self.fetch_transcript(meeting_id)
        
        if transcript_data:
            return self.save_transcript(transcript_data, meeting_date)
        
        return None
    
    def list_available_meetings(self) -> list:
        """
        Scrape the main transcript page to get list of available meetings.
        
        Returns:
            List of dictionaries with meeting info (pkey, date, title)
        """
        try:
            logger.info("Fetching list of available meetings")
            response = self.session.get(self.BASE_URL, timeout=30)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.content, 'html.parser')
            meetings = []
            
            # Find all links to transcript pages
            # Pattern: Agenda.aspx?pkey=####
            for link in soup.find_all('a', href=True):
                href = link['href']
                if 'pkey=' in href:
                    # Extract pkey
                    match = re.search(r'pkey=(\d+)', href)
                    if match:
                        pkey = match.group(1)
                        # Get link text (usually contains date/title)
                        title = link.get_text(strip=True)
                        meetings.append({
                            'pkey': pkey,
                            'title': title,
                            'url': f"{self.BASE_URL}/Agenda.aspx?pkey={pkey}"
                        })
            
            logger.info(f"Found {len(meetings)} available meetings")
            return meetings
            
        except requests.RequestException as e:
            logger.error(f"Failed to list meetings: {e}")
            return []
    
    def batch_fetch(self, meetings: list, delay: float = 2.0) -> list:
        """
        Fetch multiple transcripts with rate limiting.
        
        Args:
            meetings: List of meeting_id strings or (meeting_id, meeting_date) tuples
            delay: Seconds to wait between requests
            
        Returns:
            List of successfully saved file paths
        """
        results = []
        
        for i, meeting in enumerate(meetings):
            # Handle both formats: "meeting_id" or ("meeting_id", "date")
            if isinstance(meeting, tuple):
                meeting_id, meeting_date = meeting
            else:
                meeting_id = meeting
                meeting_date = None
            
            logger.info(f"Fetching {i+1}/{len(meetings)}: {meeting_id}")
            
            path = self.fetch_and_save(meeting_id, meeting_date)
            if path:
                results.append(path)
            
            # Rate limiting
            if i < len(meetings) - 1:
                time.sleep(delay)
        
        logger.info(f"Successfully fetched {len(results)}/{len(meetings)} transcripts")
        return results


if __name__ == "__main__":
    # Example usage
    import sys
    
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )
    
    scraper = TranscriptScraper()
    
    if len(sys.argv) > 1:
        meeting_id = sys.argv[1]
        meeting_date = sys.argv[2] if len(sys.argv) > 2 else None
        
        print(f"Fetching transcript for meeting {meeting_id}...")
        path = scraper.fetch_and_save(meeting_id, meeting_date)
        
        if path:
            print(f"✅ Saved to {path}")
            
            # Show summary
            with open(path) as f:
                data = json.load(f)
                print(f"\nMeeting: {data.get('meeting_title', 'N/A')}")
                print(f"Date/Time: {data.get('meeting_date_time', 'N/A')}")
                print(f"Segments: {data.get('segment_count', 0)}")
                print(f"\nSample speakers:")
                speakers = set(s['speaker'] for s in data['segments'][:20])
                for speaker in sorted(speakers)[:5]:
                    print(f"  - {speaker}")
        else:
            print("❌ Failed to fetch transcript")
            sys.exit(1)
    else:
        print("Usage: python scraper.py <meeting_id> [meeting_date]")
        print("Example: python scraper.py 2639 2025-10-23")
