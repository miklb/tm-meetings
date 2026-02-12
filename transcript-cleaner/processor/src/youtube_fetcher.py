"""
YouTube Video Fetcher

Fetches YouTube video IDs for Tampa City Council meetings using YouTube Data API v3.
Handles meetings split into multiple parts (morning/afternoon, Part 1/2/3).
"""

import os
import json
import re
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import logging
from pathlib import Path

from src.meeting_type_detector import detect_meeting_type, get_legacy_search_terms, MeetingType

# Load environment variables from .env file
from dotenv import load_dotenv
load_dotenv()

# Will need to install google-api-python-client
# pip install google-api-python-client

try:
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    YOUTUBE_API_AVAILABLE = True
except ImportError:
    YOUTUBE_API_AVAILABLE = False
    logging.warning("google-api-python-client not installed. Install with: pip install google-api-python-client")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class YouTubeFetcher:
    """Fetch YouTube videos for Tampa City Council meetings."""
    
    # Tampa City Council official channel
    CHANNEL_ID = "UCLzohJmEgvfJOEd4YJNIHbg"  # City Of Tampa Meetings
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize YouTube fetcher.
        
        Args:
            api_key: YouTube Data API v3 key. If not provided, reads from
                    YOUTUBE_API_KEY environment variable.
        """
        self.api_key = api_key or os.getenv('YOUTUBE_API_KEY')
        
        if not self.api_key:
            logger.warning(
                "No YouTube API key provided. Set YOUTUBE_API_KEY environment variable "
                "or pass api_key parameter. Get key from: "
                "https://console.cloud.google.com/apis/credentials"
            )
            self.youtube = None
        elif not YOUTUBE_API_AVAILABLE:
            logger.error("google-api-python-client not installed")
            self.youtube = None
        else:
            self.youtube = build('youtube', 'v3', developerKey=self.api_key)
    
    def find_videos_for_meeting(
        self,
        meeting_date: str,
        meeting_type: str = "City Council",
        try_legacy_fallback: bool = True,
        meeting_type_label: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """
        Find YouTube videos for a specific meeting date.
        
        Args:
            meeting_date: Meeting date in format "YYYY-MM-DD" or "Month DD, YYYY"
            meeting_type: Type of meeting. Can be a youtube_search_term like
                         "City Council" or "Community Redevelopment".
            try_legacy_fallback: If True and no videos found, retry with
                                legacy search terms (e.g., "TCC") for older videos.
            
        Returns:
            List of dicts with video info:
            [
                {
                    'video_id': 'abc123',
                    'title': 'Tampa City Council 10/23/2025 - Morning Session',
                    'part': 1,
                    'session': 'morning' or 'afternoon' or None,
                    'published_at': '2025-10-23T09:00:00Z',
                    'duration': 'PT2H30M15S'
                }
            ]
        """
        if not self.youtube:
            logger.error("YouTube API not initialized")
            return []
        
        # Parse meeting date
        try:
            if '-' in meeting_date:
                date_obj = datetime.strptime(meeting_date, '%Y-%m-%d')
            else:
                date_obj = datetime.strptime(meeting_date, '%B %d, %Y')
        except ValueError:
            logger.error(f"Invalid date format: {meeting_date}")
            return []
        
        # Search for videos around this date
        videos = self._search_videos_by_date(date_obj, meeting_type)
        
        # Legacy fallback for older videos with abbreviated titles
        if not videos and try_legacy_fallback:
            # Build a MeetingType to get legacy terms
            detected = MeetingType(label=meeting_type, youtube_search_term=meeting_type)
            for legacy_term in get_legacy_search_terms(detected):
                if legacy_term.lower() != meeting_type.lower():
                    logger.info(f"Trying legacy search term: '{legacy_term}'")
                    videos = self._search_videos_by_date(date_obj, legacy_term)
                    if videos:
                        break
        
        if not videos:
            logger.warning(f"No videos found for {meeting_date}")
            return []

        # Filter by session (AM/PM) when meeting type label is known
        if meeting_type_label:
            videos = self._filter_by_session(videos, meeting_type_label)

        # Sort by part number and session
        videos = self._sort_video_parts(videos)
        
        logger.info(f"Found {len(videos)} video(s) for {meeting_date}")
        for i, video in enumerate(videos, 1):
            logger.info(f"  Part {i}: {video['title']} ({video['video_id']})")
        
        return videos
    
    def _search_videos_by_date(self, date_obj: datetime, meeting_type: str) -> List[Dict[str, str]]:
        """
        Search for videos published around the meeting date.
        
        Args:
            date_obj: Meeting date as datetime object
            meeting_type: Type of meeting to search for
            
        Returns:
            List of video info dicts
        """
        # Search window: day before to 3 days after (to handle late uploads)
        start_date = (date_obj - timedelta(days=1)).strftime('%Y-%m-%dT00:00:00Z')
        end_date = (date_obj + timedelta(days=4)).strftime('%Y-%m-%dT23:59:59Z')
        
        try:
            # Search for videos
            search_request = self.youtube.search().list(
                part='snippet',
                channelId=self.CHANNEL_ID,
                publishedAfter=start_date,
                publishedBefore=end_date,
                type='video',
                maxResults=50,  # Should be enough for one day's meetings
                order='date'
            )
            search_response = search_request.execute()
            
            videos = []
            # Multiple date formats used in video titles
            date_str = date_obj.strftime('%m/%d/%Y')  # 10/23/2025
            date_str_alt = date_obj.strftime('%-m/%-d/%Y')  # 10/23/2025 without leading zeros
            date_str_short = date_obj.strftime('%m/%d/%y')  # 10/23/25 (SHORT YEAR)
            date_str_short_alt = date_obj.strftime('%-m/%-d/%y')  # 10/23/25 without leading zeros
            
            for item in search_response.get('items', []):
                title = item['snippet']['title']
                
                # Check if title matches this meeting date (try all formats)
                if any(d in title for d in [date_str, date_str_alt, date_str_short, date_str_short_alt]):
                    if meeting_type.lower() in title.lower():
                        video_id = item['id']['videoId']
                        
                        # Get video duration and description (for chapters)
                        video_details = self.youtube.videos().list(
                            part='contentDetails,snippet',
                            id=video_id
                        ).execute()
                        
                        duration = None
                        chapters = []
                        if video_details['items']:
                            duration = video_details['items'][0]['contentDetails']['duration']
                            description = video_details['items'][0]['snippet'].get('description', '')
                            chapters = self._parse_chapters_from_description(description)
                        
                        # Parse part number and session from title
                        part_info = self._parse_video_title(title)
                        
                        videos.append({
                            'video_id': video_id,
                            'title': title,
                            'part': part_info['part'],
                            'session': part_info['session'],
                            'published_at': item['snippet']['publishedAt'],
                            'duration': duration,
                            'chapters': chapters
                        })
            
            return videos
            
        except HttpError as e:
            logger.error(f"YouTube API error: {e}")
            return []
    
    def _parse_chapters_from_description(self, description: str) -> List[Dict[str, any]]:
        """
        Parse YouTube chapters from video description.
        
        YouTube chapters format:
        0:00 Intro
        1:23 Main content
        10:45 Conclusion
        
        Args:
            description: Video description text
            
        Returns:
            List of chapter dicts: [{'title': 'Intro', 'timestamp': '0:00', 'seconds': 0}, ...]
        """
        chapters = []
        
        # Match timestamp patterns: 0:00, 1:23, 10:45, 1:23:45
        timestamp_pattern = r'^(\d+(?::\d+)+)\s+(.+)$'
        
        for line in description.split('\n'):
            match = re.match(timestamp_pattern, line.strip())
            if match:
                timestamp_str = match.group(1)
                title = match.group(2).strip()
                
                # Convert timestamp to seconds
                parts = timestamp_str.split(':')
                seconds = 0
                if len(parts) == 2:  # MM:SS
                    seconds = int(parts[0]) * 60 + int(parts[1])
                elif len(parts) == 3:  # HH:MM:SS
                    seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                
                chapters.append({
                    'title': title,
                    'timestamp': timestamp_str,
                    'seconds': seconds
                })
        
        return chapters
    
    def _parse_video_title(self, title: str) -> Dict[str, Optional[any]]:
        """
        Parse video title to extract part number and session type.
        
        Examples:
            "Tampa City Council 10/23/2025 - Morning Session" -> part=1, session='morning'
            "Tampa City Council 10/23/2025 - Afternoon" -> part=2, session='afternoon'
            "Tampa City Council 10/23/2025 - Part 1" -> part=1, session=None
            "Tampa City Council 10/23/2025 - Part 2" -> part=2, session=None
            "Tampa City Council 10/23/2025 - Part 3" -> part=3, session=None
            
        Returns:
            Dict with 'part' (int) and 'session' (str or None)
        """
        title_lower = title.lower()
        
        # Check for explicit part numbers
        part_match = re.search(r'part\s+(\d+)', title_lower)
        if part_match:
            return {
                'part': int(part_match.group(1)),
                'session': None
            }
        
        # Check for morning/afternoon/evening keywords
        if 'morning' in title_lower:
            return {'part': 1, 'session': 'morning'}
        elif 'afternoon' in title_lower:
            return {'part': 2, 'session': 'afternoon'}
        elif 'evening' in title_lower:
            return {'part': 3, 'session': 'evening'}

        # Channel convention: "Tampa City Council PM 01/29/26" = evening session
        if re.search(r'\bpm\b', title_lower):
            return {'part': 1, 'session': 'evening'}
        elif re.search(r'\bam\b', title_lower):
            return {'part': 1, 'session': 'morning'}
        elif 'workshop' in title_lower:
            return {'part': 1, 'session': 'morning'}

        # Default: single video
        return {'part': 1, 'session': None}
    
    def _filter_by_session(
        self,
        videos: List[Dict[str, str]],
        meeting_type_label: str,
    ) -> List[Dict[str, str]]:
        """Exclude videos from the wrong session on the same day.

        Tampa channel conventions:
          - "PM" in title → evening/PM session
          - "Workshop" in title → morning workshop
          - No AM/PM marker → morning/regular session

        Rules:
          - Evening: keep only videos with session='evening'
          - Workshop / City Council: exclude videos with session='evening'
          - CRA / Special: no filtering (different search term scopes them)
        """
        if meeting_type_label in ("CRA", "Special", None):
            return videos

        filtered = []
        for v in videos:
            session = v.get('session')
            if meeting_type_label == "Evening":
                if session == 'evening':
                    filtered.append(v)
                else:
                    logger.info(
                        f"Excluding non-PM video for Evening meeting: {v['title']}"
                    )
            else:
                # Workshop / regular City Council — exclude PM videos
                if session == 'evening':
                    logger.info(
                        f"Excluding PM video for {meeting_type_label} meeting: {v['title']}"
                    )
                else:
                    filtered.append(v)

        # Fallback: if filter removed everything, keep all (avoid empty result)
        return filtered if filtered else videos

    def _sort_video_parts(self, videos: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """Sort videos by part number and session."""
        def sort_key(video):
            # Sort by part number, then by session priority
            session_priority = {
                'morning': 1,
                'afternoon': 2,
                'evening': 3,
                None: 99
            }
            return (video['part'], session_priority.get(video['session'], 99))
        
        return sorted(videos, key=sort_key)
    
    def save_video_mapping(
        self,
        meeting_id: int,
        meeting_date: str,
        output_path: str,
        meeting_type: Optional[str] = None,
        transcript_path: Optional[str] = None,
    ):
        """
        Fetch videos and save to JSON file.
        
        Meeting type is resolved in this order:
        1. Explicit meeting_type parameter
        2. Auto-detected from transcript_path
        3. Falls back to "City Council"
        
        Args:
            meeting_id: Meeting ID number
            meeting_date: Meeting date
            output_path: Path to save JSON mapping
            meeting_type: Override meeting type for YouTube search
            transcript_path: Path to transcript JSON for auto-detection
        """
        # Auto-detect meeting type if not explicitly provided
        detected_type = None
        if meeting_type is None:
            detected_type = detect_meeting_type(
                transcript_path=transcript_path,
                meeting_id=meeting_id,
            )
            search_term = detected_type.youtube_search_term
            logger.info(
                f"Auto-detected meeting type: {detected_type.label} "
                f"(YouTube search: '{search_term}')"
            )
        else:
            search_term = meeting_type
        
        type_label = meeting_type or (detected_type.label if detected_type else None)
        videos = self.find_videos_for_meeting(
            meeting_date,
            meeting_type=search_term,
            meeting_type_label=type_label,
        )
        
        if not videos:
            logger.warning(f"No videos found for meeting {meeting_id} on {meeting_date}")
            return
        
        mapping = {
            'meeting_id': meeting_id,
            'meeting_date': meeting_date,
            'meeting_type': meeting_type or (detected_type.label if detected_type else None),
            'videos': videos,
        }
        
        with open(output_path, 'w') as f:
            json.dump(mapping, f, indent=2)
        
        logger.info(f"Saved video mapping to {output_path}")


def main():
    """Example usage."""
    import sys
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Fetch YouTube videos for Tampa City Council meetings',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Just search for videos by date
  python youtube_fetcher.py 2025-10-23
  
  # Save video mapping for a meeting
  python youtube_fetcher.py --meeting-id 2639 --meeting-date 2025-10-23
  
Note: Set YOUTUBE_API_KEY environment variable first
Get API key from: https://console.cloud.google.com/apis/credentials
        '''
    )
    
    parser.add_argument('meeting_date', nargs='?', help='Meeting date (YYYY-MM-DD)')
    parser.add_argument('--meeting-id', type=int, help='Meeting ID (saves to data/video_mapping_<ID>.json)')
    parser.add_argument('--meeting-date', dest='meeting_date_flag', help='Meeting date (YYYY-MM-DD)')
    parser.add_argument(
        '--meeting-type',
        help='Meeting type for YouTube search (e.g., "CRA", "City Council"). '
             'If omitted, auto-detected from transcript.',
    )
    parser.add_argument(
        '--transcript',
        help='Path to transcript JSON file. Used for auto-detecting meeting type '
             'when --meeting-type is not specified.',
    )
    
    args = parser.parse_args()
    
    # Determine meeting date (positional arg takes precedence)
    meeting_date = args.meeting_date or args.meeting_date_flag
    
    if not meeting_date:
        parser.print_help()
        sys.exit(1)
    
    # Resolve meeting type: explicit flag > auto-detect from transcript > default
    meeting_type_override = args.meeting_type
    transcript_path = args.transcript
    
    # Map short CLI names to YouTube search terms
    cli_type_map = {
        'cra': 'Community Redevelopment',
        'community redevelopment': 'Community Redevelopment',
        'workshop': 'City Council',
        'evening': 'City Council',
        'city council': 'City Council',
    }
    
    if meeting_type_override:
        search_term = cli_type_map.get(
            meeting_type_override.lower(), meeting_type_override
        )
        type_label = meeting_type_override.capitalize()
        print(f"Using meeting type: {meeting_type_override} (search: '{search_term}')")
    elif transcript_path:
        detected = detect_meeting_type(transcript_path=transcript_path, meeting_id=args.meeting_id)
        search_term = detected.youtube_search_term
        type_label = detected.label
        print(f"Auto-detected meeting type: {detected.label} (search: '{search_term}')")
    elif args.meeting_id:
        # Try to find transcript file automatically
        transcript_dir = Path('data/transcripts')
        candidates = list(transcript_dir.glob(f'transcript_{args.meeting_id}_*.json'))
        if not candidates:
            candidates = list(Path('data/processed').glob(f'*{args.meeting_id}*.json'))
        if candidates:
            detected = detect_meeting_type(transcript_path=str(candidates[0]), meeting_id=args.meeting_id)
            search_term = detected.youtube_search_term
            type_label = detected.label
            print(f"Auto-detected meeting type: {detected.label} (from {candidates[0].name})")
        else:
            search_term = 'City Council'
            type_label = None
            print(f"No transcript found for meeting {args.meeting_id}, defaulting to 'City Council'")
    else:
        search_term = 'City Council'
        type_label = None
    
    fetcher = YouTubeFetcher()
    videos = fetcher.find_videos_for_meeting(
        meeting_date,
        meeting_type=search_term,
        meeting_type_label=type_label,
    )
    
    if videos:
        print(f"\nFound {len(videos)} video(s) for {meeting_date}:")
        for i, video in enumerate(videos, 1):
            print(f"\nPart {i}:")
            print(f"  Title: {video['title']}")
            print(f"  Video ID: {video['video_id']}")
            print(f"  URL: https://www.youtube.com/watch?v={video['video_id']}")
            if video['session']:
                print(f"  Session: {video['session']}")
            if video['duration']:
                print(f"  Duration: {video['duration']}")
        
        # If meeting ID provided, save to file
        if args.meeting_id:
            output_path = Path('data') / f'video_mapping_{args.meeting_id}.json'
            mapping = {
                'meeting_id': args.meeting_id,
                'meeting_date': meeting_date,
                'meeting_type': type_label,
                'videos': videos,
            }
            with open(output_path, 'w') as f:
                json.dump(mapping, f, indent=2)
            print(f"\n✅ Saved video mapping to {output_path}")
    else:
        print(f"No videos found for {meeting_date}")
        print("\nTroubleshooting:")
        print("1. Check YOUTUBE_API_KEY environment variable is set")
        print("2. Verify the date format (YYYY-MM-DD)")
        print("3. Make sure videos exist for this date on the channel")
        print("4. Try --meeting-type to specify type explicitly")


if __name__ == '__main__':
    main()
