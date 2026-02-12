#!/usr/bin/env python3
"""
HTML Generator for Tampa City Council Transcripts

Generates static HTML pages from processed transcripts with:
- Multi-video support (automatic detection and tabbed interface)
- Clickable timestamps that seek video to correct position
- Video sync highlighting (transcript follows playback)
- Responsive design (mobile-friendly)
- Accessibility features (ARIA labels, keyboard navigation)
"""

import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from jinja2 import Environment, FileSystemLoader
import logging

logger = logging.getLogger(__name__)


class HTMLGenerator:
    """Generates HTML pages from processed transcripts"""
    
    def __init__(self, 
                 templates_dir: str = "templates",
                 output_dir: str = "output/site",
                 processed_dir: str = "data/processed",
                 video_mapping_dir: str = "data",
                 meetings_metadata_file: str = "data/meetings_metadata.json"):
        """
        Initialize HTML generator
        
        Args:
            templates_dir: Directory containing Jinja2 templates
            output_dir: Output directory for generated HTML
            processed_dir: Directory containing processed transcripts
            video_mapping_dir: Directory containing video mapping JSON files
            meetings_metadata_file: Path to meetings metadata JSON file
        """
        self.templates_dir = Path(templates_dir)
        self.output_dir = Path(output_dir)
        self.processed_dir = Path(processed_dir)
        self.video_mapping_dir = Path(video_mapping_dir)
        self.meetings_metadata_file = Path(meetings_metadata_file)
        
        # Create output directory if needed
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Load meetings metadata
        self.meetings_metadata = self._load_meetings_metadata()
        
        # Set up Jinja2 environment
        self.jinja_env = Environment(
            loader=FileSystemLoader(str(self.templates_dir)),
            autoescape=True
        )
        
        logger.info("HTMLGenerator initialized")
    
    def _load_meetings_metadata(self) -> Dict:
        """
        Load meetings metadata from JSON file
        
        Returns:
            Dict with two lookups: by meeting_id and by date
        """
        if not self.meetings_metadata_file.exists():
            logger.warning(f"Meetings metadata file not found: {self.meetings_metadata_file}")
            return {'by_id': {}, 'by_date': {}}
        
        try:
            with open(self.meetings_metadata_file, 'r') as f:
                data = json.load(f)
                # Create lookup dicts by meeting ID AND by date (since IDs don't match between sources)
                metadata_by_id = {}
                metadata_by_date = {}
                for meeting in data.get('meetings', []):
                    meeting_id = meeting.get('meetingId')
                    meeting_date = meeting.get('date')
                    if meeting_id:
                        metadata_by_id[str(meeting_id)] = meeting
                    if meeting_date:
                        metadata_by_date[meeting_date] = meeting
                return {'by_id': metadata_by_id, 'by_date': metadata_by_date}
        except Exception as e:
            logger.error(f"Error loading meetings metadata: {e}")
            return {'by_id': {}, 'by_date': {}}
    
    def parse_iso_duration(self, duration_str: str) -> int:
        """
        Parse ISO 8601 duration to seconds
        
        Args:
            duration_str: ISO duration (e.g., "PT2H54M15S")
            
        Returns:
            Duration in seconds
        """
        if not duration_str or not duration_str.startswith('PT'):
            return 0
        
        # Remove PT prefix
        duration_str = duration_str[2:]
        
        hours = 0
        minutes = 0
        seconds = 0
        
        # Parse hours
        if 'H' in duration_str:
            hours_match = re.search(r'(\d+)H', duration_str)
            if hours_match:
                hours = int(hours_match.group(1))
        
        # Parse minutes
        if 'M' in duration_str:
            minutes_match = re.search(r'(\d+)M', duration_str)
            if minutes_match:
                minutes = int(minutes_match.group(1))
        
        # Parse seconds
        if 'S' in duration_str:
            seconds_match = re.search(r'(\d+)S', duration_str)
            if seconds_match:
                seconds = int(seconds_match.group(1))
        
        return hours * 3600 + minutes * 60 + seconds
    
    def format_duration(self, seconds: int) -> str:
        """
        Format seconds as HH:MM:SS or MM:SS
        
        Args:
            seconds: Duration in seconds
            
        Returns:
            Formatted duration string
        """
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60
        
        if hours > 0:
            return f"{hours}h {minutes}m"
        else:
            return f"{minutes}m {secs}s"
    
    def timestamp_to_seconds(self, timestamp: str, meeting_start_time: Optional[str] = None) -> int:
        """
        Convert timestamp to seconds relative to meeting start
        
        Args:
            timestamp: Time string (HH:MM:SS or MM:SS, with optional AM/PM)
            meeting_start_time: Meeting start time (HH:MM:SS AM/PM). If provided,
                              returns seconds elapsed since meeting start.
            
        Returns:
            Seconds as integer
        """
        def parse_time_to_seconds(time_str: str) -> int:
            """Parse a time string to absolute seconds since midnight"""
            time_clean = time_str.strip().upper()
            is_pm = 'PM' in time_clean
            is_am = 'AM' in time_clean
            time_clean = time_clean.replace(' AM', '').replace('AM', '')
            time_clean = time_clean.replace(' PM', '').replace('PM', '')
            
            parts = time_clean.split(':')
            
            if len(parts) == 3:
                hours, minutes, seconds = map(int, parts)
                # Convert 12-hour to 24-hour if needed
                if is_pm and hours != 12:
                    hours += 12
                elif is_am and hours == 12:
                    hours = 0
                return hours * 3600 + minutes * 60 + seconds
            elif len(parts) == 2:
                minutes, seconds = map(int, parts)
                return minutes * 60 + seconds
            return 0
        
        try:
            timestamp_seconds = parse_time_to_seconds(timestamp)
            
            # If meeting start time provided, calculate relative seconds
            if meeting_start_time:
                start_seconds = parse_time_to_seconds(meeting_start_time)
                relative_seconds = timestamp_seconds - start_seconds
                
                # Handle case where meeting crosses midnight (unlikely but possible)
                if relative_seconds < 0:
                    relative_seconds += 24 * 3600
                    
                return relative_seconds
            
            return timestamp_seconds
            
        except ValueError as e:
            logger.warning(f"Failed to parse timestamp '{timestamp}': {e}")
            return 0
    
    def map_timestamp_to_video_part(self, 
                                     timestamp_seconds: int, 
                                     video_start_times: List[int]) -> Tuple[int, int]:
        """
        Determine which video part contains a timestamp
        
        Args:
            timestamp_seconds: Timestamp in seconds from meeting start (first segment)
            video_start_times: List of video start times in seconds from meeting start
            
        Returns:
            Tuple of (video_part_index, timestamp_within_video)
        """
        # Find which video part this timestamp belongs to
        # video_start_times are sorted, e.g. [0, 4381, 10000] for 3 parts
        for i in range(len(video_start_times) - 1, -1, -1):
            if timestamp_seconds >= video_start_times[i]:
                # This timestamp belongs to part i+1
                timestamp_within_video = timestamp_seconds - video_start_times[i]
                return i + 1, timestamp_within_video  # Part numbers are 1-indexed
        
        # Default to first video if timestamp is before all start times
        return 1, 0
    
    def load_video_mapping(self, meeting_id: int) -> Optional[Dict]:
        """
        Load video mapping for a meeting
        
        Args:
            meeting_id: Meeting ID
            
        Returns:
            Video mapping dict or None if not found
        """
        mapping_file = self.video_mapping_dir / f"video_mapping_{meeting_id}.json"
        
        if not mapping_file.exists():
            logger.warning(f"No video mapping found for meeting {meeting_id}")
            return None
        
        with open(mapping_file, 'r') as f:
            return json.load(f)
    
    def load_processed_transcript(self, meeting_id: int) -> Optional[Dict]:
        """
        Load processed transcript for a meeting
        
        Args:
            meeting_id: Meeting ID
            
        Returns:
            Processed transcript dict or None if not found
        """
        # Try different filename patterns
        patterns = [
            f"{meeting_id}_processed.json",
            f"processed_transcript_{meeting_id}_*.json"
        ]
        
        transcript_file = None
        for pattern in patterns:
            matches = list(self.processed_dir.glob(pattern))
            if matches:
                transcript_file = matches[0]
                break
        
        if not transcript_file or not transcript_file.exists():
            logger.error(f"No processed transcript found for meeting {meeting_id}")
            return None
        
        with open(transcript_file, 'r') as f:
            return json.load(f)
    
    def generate_transcript_page(self, meeting_id: int) -> bool:
        """
        Generate HTML page for a single meeting
        
        Args:
            meeting_id: Meeting ID
            
        Returns:
            True if successful, False otherwise
        """
        # Load transcript
        transcript = self.load_processed_transcript(meeting_id)
        if not transcript:
            return False
        
        # Load video mapping
        video_mapping = self.load_video_mapping(meeting_id)
        
        # Get meeting date from video mapping (most reliable source)
        if video_mapping and 'meeting_date' in video_mapping:
            meeting_date_iso = video_mapping['meeting_date']  # e.g., "2025-10-09"
            # Format as "October 9, 2025"
            try:
                from datetime import datetime
                date_obj = datetime.strptime(meeting_date_iso, '%Y-%m-%d')
                meeting_date = date_obj.strftime('%B %d, %Y')
            except:
                meeting_date = meeting_date_iso
        else:
            meeting_date_iso = None
            meeting_date = 'Unknown'
        
        # Get meeting type from transcript's own meeting_title field (most reliable)
        transcript_title = transcript.get('meeting_title', '')
        meeting_type = None
        
        if transcript_title:
            # Use the transcript's title directly (e.g., "TAMPA CITY COUNCIL WORKSHOPS")
            meeting_type = transcript_title.title()
        
        # If no transcript title, try to extract from video title
        if not meeting_type and video_mapping and 'videos' in video_mapping:
            first_video_title = video_mapping['videos'][0].get('title', '')
            # Extract type from title like "Tampa City Council - 10/09/25" or "CRA Board - 10/09/25"
            if 'CRA' in first_video_title.upper():
                meeting_type = 'CRA Meeting'
            elif 'EVENING' in first_video_title.upper():
                meeting_type = 'Evening Session'
            elif 'WORKSHOP' in first_video_title.upper():
                meeting_type = 'Workshop'
            else:
                meeting_type = 'City Council Meeting'
        
        if not meeting_type:
            meeting_type = 'City Council Meeting'
        
        # Extract meeting metadata
        meeting_title = f"{meeting_type} - {meeting_date}"
        
        # Get processed segments (processed files only contain cleaned segments now)
        segments = transcript.get('segments', [])
        
        # Use the FIRST timestamp as the reference point (video start)
        meeting_start_time = None
        if segments and len(segments) > 0:
            first_timestamp = segments[0].get('timestamp', '')
            if first_timestamp:
                meeting_start_time = first_timestamp
                logger.info(f"Using first transcript timestamp as reference: {meeting_start_time}")
        
        
        # Process videos
        videos = []
        video_offsets = []  # Store offset for each video part
        video_start_times = []  # Store transcript start time for each video part (in seconds from meeting start)
        total_duration_seconds = 0
        
        if video_mapping and 'videos' in video_mapping:
            for video in video_mapping['videos']:
                duration_seconds = self.parse_iso_duration(video.get('duration', ''))
                duration_formatted = self.format_duration(duration_seconds)
                offset_seconds = video.get('offset_seconds', 0)
                transcript_start_time = video.get('transcript_start_time')
                
                # Convert transcript start time to seconds from meeting start
                if transcript_start_time and meeting_start_time:
                    start_seconds = self.timestamp_to_seconds(transcript_start_time, meeting_start_time)
                else:
                    start_seconds = 0  # Default to start of meeting
                
                videos.append({
                    'video_id': video['video_id'],
                    'title': video['title'],
                    'part': video.get('part', 1),
                    'duration': video.get('duration', ''),
                    'duration_formatted': duration_formatted,
                    'duration_seconds': duration_seconds,
                    'offset_seconds': offset_seconds,
                    'transcript_start_time': transcript_start_time,
                    'transcript_start_seconds': start_seconds,
                    'chapters': video.get('chapters', [])  # Include chapters from video mapping
                })
                
                video_start_times.append(start_seconds)
                video_offsets.append(offset_seconds)
                total_duration_seconds += duration_seconds
        else:
            logger.warning(f"No videos found for meeting {meeting_id}")
        
        # Process segments and map to video parts
        processed_segments = []
        
        for i, segment in enumerate(segments):
            timestamp = segment.get('timestamp', '00:00:00')
            timestamp_seconds = self.timestamp_to_seconds(timestamp, meeting_start_time)
            
            # Determine which video part this segment belongs to
            if video_start_times:
                video_part, timestamp_in_video = self.map_timestamp_to_video_part(
                    timestamp_seconds, 
                    video_start_times
                )
                
                # Add the offset for this video part
                video_index = video_part - 1
                if video_index < len(video_offsets):
                    timestamp_in_video += video_offsets[video_index]
                
                # Debug first few segments
                if i < 5 or timestamp == '9:11:14AM':
                    logger.info(f"Segment {i}: {timestamp} = {timestamp_seconds}s -> Part {video_part}, offset {timestamp_in_video}s")
            else:
                video_part = 1
                timestamp_in_video = timestamp_seconds
            
            # Get text (already cleaned by TranscriptProcessor)
            text = segment.get('text', '')
            
            processed_segments.append({
                'speaker': segment.get('speaker', 'Unknown'),
                'timestamp': timestamp,
                'timestamp_seconds': timestamp_in_video,  # Time within the specific video
                'video_part': video_part,
                'text': text
            })
        
        # Calculate video part ranges for JavaScript (not used anymore but kept for compatibility)
        video_part_ranges = []
        for i, video in enumerate(videos):
            video_part_ranges.append({
                'part': i + 1,
                'start': video['transcript_start_seconds'],
                'end': video['transcript_start_seconds'] + video['duration_seconds']
            })
        
        # Render template
        template = self.jinja_env.get_template('transcript.html')
        html = template.render(
            meeting_title=meeting_title,
            meeting_date=meeting_date,
            meeting_id=meeting_id,
            total_duration=self.format_duration(total_duration_seconds),
            video_count=len(videos),
            segment_count=len(processed_segments),
            videos=videos,
            segments=processed_segments,
            video_part_ranges=video_part_ranges
        )
        
        # Write output
        output_file = self.output_dir / f"{meeting_id}.html"
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(html)
        
        logger.info(f"Generated: {output_file} (Videos: {len(videos)}, Segments: {len(processed_segments)})")
        
        return True
    
    def generate_index_page(self, meeting_ids: List[int]) -> bool:
        """
        Generate index page listing all meetings
        
        Args:
            meeting_ids: List of meeting IDs to include
            
        Returns:
            True if successful
        """
        meetings = []
        
        for meeting_id in meeting_ids:
            transcript = self.load_processed_transcript(meeting_id)
            if not transcript:
                continue
            
            video_mapping = self.load_video_mapping(meeting_id)
            
            # Count videos
            video_count = 0
            total_duration = 0
            thumbnail_url = None
            
            if video_mapping and 'videos' in video_mapping:
                video_count = len(video_mapping['videos'])
                for video in video_mapping['videos']:
                    total_duration += self.parse_iso_duration(video.get('duration', ''))
                # Use first video's thumbnail
                if video_mapping['videos']:
                    first_video_id = video_mapping['videos'][0].get('video_id')
                    if first_video_id:
                        # YouTube standard thumbnail (medium quality: 320x180)
                        thumbnail_url = f"https://img.youtube.com/vi/{first_video_id}/mqdefault.jpg"
            
            # Extract date from meeting_date_time
            date_str = 'Unknown'
            sort_date = '0000-00-00'  # Default for unknown dates
            meeting_date_time = transcript.get('meeting_date_time', '')
            if meeting_date_time:
                # Parse "THURSDAY, OCTOBER 30, 2025, 9:00 A.M." -> "Oct 30, 2025"
                import re
                date_match = re.search(r'(\w+)\s+(\d+),\s+(\d{4})', meeting_date_time)
                if date_match:
                    month = date_match.group(1)
                    day = date_match.group(2)
                    year = date_match.group(3)
                    date_str = f"{month[:3].upper()} {day}, {year}"
                    
                    # Create sortable date (YYYY-MM-DD format)
                    month_map = {
                        'JANUARY': '01', 'FEBRUARY': '02', 'MARCH': '03', 'APRIL': '04',
                        'MAY': '05', 'JUNE': '06', 'JULY': '07', 'AUGUST': '08',
                        'SEPTEMBER': '09', 'OCTOBER': '10', 'NOVEMBER': '11', 'DECEMBER': '12'
                    }
                    month_num = month_map.get(month.upper(), '00')
                    sort_date = f"{year}-{month_num}-{day.zfill(2)}"
            
            # Get meeting type from title
            meeting_title = transcript.get('meeting_title', 'Tampa City Council')
            
            meetings.append({
                'meeting_id': meeting_id,
                'meeting_date': date_str,
                'sort_date': sort_date,
                'meeting_title': meeting_title,
                'segment_count': len(transcript.get('segments', [])),
                'video_count': video_count,
                'total_duration': self.format_duration(total_duration),
                'thumbnail_url': thumbnail_url,
                'url': f"{meeting_id}.html"
            })
        
        # Sort by date (newest first)
        meetings.sort(key=lambda x: x['sort_date'], reverse=True)
        
        # Render template
        template = self.jinja_env.get_template('index.html')
        html = template.render(
            meetings=meetings,
            total_meetings=len(meetings)
        )
        
        # Write output
        output_file = self.output_dir / "index.html"
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(html)
        
        logger.info(f"Generated index: {output_file} (Listed {len(meetings)} meeting(s))")
        
        return True
    
    def generate_all(self) -> int:
        """
        Generate HTML for all processed transcripts
        
        Returns:
            Number of pages generated
        """
        # Find all processed transcripts
        processed_files = list(self.processed_dir.glob("*processed*.json"))
        
        if not processed_files:
            logger.error("No processed transcripts found")
            return 0
        
        meeting_ids = []
        success_count = 0
        
        for file in processed_files:
            # Extract meeting ID from filename (supports multiple patterns)
            match = re.search(r'(\d+)', file.name)
            if not match:
                continue
            
            meeting_id = int(match.group(1))
            if meeting_id in meeting_ids:
                continue  # Skip duplicates
            meeting_ids.append(meeting_id)
            
            # Generate transcript page
            if self.generate_transcript_page(meeting_id):
                success_count += 1
        
        # Generate index page
        if meeting_ids:
            self.generate_index_page(meeting_ids)
            success_count += 1
        
        logger.info(f"Generated {success_count} HTML page(s) in {self.output_dir}")
        
        return success_count


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Generate HTML from processed transcripts')
    parser.add_argument('--meeting-id', type=int, help='Generate single meeting by ID')
    parser.add_argument('--output', default='output/site', help='Output directory')
    parser.add_argument('--all', action='store_true', help='Generate all meetings')
    
    args = parser.parse_args()
    
    # Set up logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(levelname)s: %(message)s'
    )
    
    generator = HTMLGenerator(output_dir=args.output)
    
    if args.meeting_id:
        success = generator.generate_transcript_page(args.meeting_id)
        print(f"\n{'✅' if success else '❌'} Meeting {args.meeting_id}")
    elif args.all:
        count = generator.generate_all()
        print(f"\n✨ Generated {count} HTML page(s)")
        print(f"📂 Output directory: {generator.output_dir}")
    else:
        print("Please specify --meeting-id or --all")
        return 1
    
    return 0


if __name__ == '__main__':
    exit(main())
