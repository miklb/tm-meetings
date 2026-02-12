# Workflow Improvements Plan

## Current State Analysis

**Current workflow requires 4-5 manual commands:**

```bash
python src/scraper.py 2645 2025-11-13
python capitalize_transcript.py data/transcripts/... data/processed/...
python src/youtube_fetcher.py 2025-11-13 --meeting-type CRA
python scripts/build/match_whisper_to_transcript.py video_id transcript.json --video-mapping ...
python src/html_generator.py  # (presumably, to build static file)
```

**Problems:**

1. User must know meeting ID, date, and meeting type separately
2. Manual path construction for each command
3. No single entry point
4. Easy to skip steps or run them out of order
5. Can't easily batch-process a week's meetings
6. **Meeting type (CRA vs City Council) must be specified manually** ⚠️ CRITICAL ISSUE

### Critical Issue: Meeting Type Detection

**Problem:** On 11-13-25 there were 3 videos but meeting type must be specified manually:

- **CRA AM** (meeting 2645): 2 videos - SocxtU6vTKc (Part 1), oCSGYDZXHbk (Part 2)
- **City Council PM** (meeting 2644): 1 video - Y4gKHr6J5mU

When running `save_video_mapping()` without `meeting_type='Community Redevelopment'`, it defaults to "City Council" and finds the wrong video.

**Current Workaround:**

```bash
# Must manually specify meeting type
python src/youtube_fetcher.py 2025-11-13 --meeting-type CRA
```

**Root Cause:**

1. Scraper doesn't extract meeting type from transcript
2. Video fetcher can't auto-detect which meeting type to search for
3. Multiple meetings can occur on same date with different types

**Evidence in Data:**

- Transcript 2645 first speaker says: "WELCOME TO THE CRA MEETING"
- `meetings_metadata.json` contains `meetingType` field but not for recent meetings
- No automatic detection logic exists

**SOLUTION FOUND:** ✅ The main transcript listing page has all the data we need!

**Source:** `https://apps.tampagov.net/cttv_cc_webapp/`

**Available Data:**

```
Meeting 2646: 11/20/2025 - Tampa City Council Meeting
Meeting 2645: 11/13/2025 - Tampa City Council CRA Meeting
Meeting 2644: 11/13/2025 - Tampa City Council Evening Meeting
Meeting 2643: 11/6/2025 - Tampa City Council Meeting
Meeting 2641: 10/30/2025 - Tampa City Council Workshop
Meeting 2640: 10/30/2025 - Tampa City Council Evening Meeting
```

**Implementation:**

1. ✅ **Scrape meeting listing table** - Extract pkey, date, and meeting type from main page
2. **Map meeting types to YouTube search terms:**
   - "Tampa City Council CRA Meeting" → `meeting_type='Community Redevelopment'`
   - "Tampa City Council Evening Meeting" → `meeting_type='City Council'`
   - "Tampa City Council Meeting" → `meeting_type='City Council'`
   - "Tampa City Council Workshop" → `meeting_type='Workshop'`
3. **Cache meeting metadata** - Store in JSON for quick lookup
4. **Auto-lookup during video search** - Query by meeting ID to get correct type

**Priority:** HIGH - Now we have a definitive data source!

## Proposed Solution: Single Weekly Workflow Script

### Goal

```bash
# Process all meetings for a specific week
python process_weekly_meetings.py --week 2025-11-18

# Or process a specific date
python process_weekly_meetings.py --date 2025-11-13

# Or process a date range
python process_weekly_meetings.py --start 2025-11-13 --end 2025-11-20
```

**Output:**

- All transcripts scraped, capitalized, and saved
- All videos found with chapters and offsets calculated
- All HTML static files generated
- Summary report of what was processed

### Implementation Plan

#### Phase 1: Meeting Discovery Service

**File:** `src/meeting_discovery.py`

**Purpose:** Automatically discover what meetings happened on given dates

**Data Source:** `https://apps.tampagov.net/cttv_cc_webapp/` (main transcript listing page)

**Key Features:**

- Scrape meeting listing table to get meeting ID, date, and type
- Parse meeting type strings to standard format
- Cache meeting metadata for quick lookup
- Query by date or meeting ID
- Return list of meetings with complete metadata

**API:**

```python
class MeetingDiscovery:
    """Discover and lookup meeting metadata from Tampa Gov website."""

    MEETING_TYPE_MAP = {
        'CRA Meeting': 'Community Redevelopment',
        'Evening Meeting': 'City Council',
        'Meeting': 'City Council',
        'Workshop': 'Workshop',
        'Special Discussion': 'City Council'
    }

    def refresh_meeting_cache(self) -> List[Meeting]:
        """
        Scrape main listing page and update meeting cache.

        Returns:
            List of all available meetings
        """
        url = 'https://apps.tampagov.net/cttv_cc_webapp/'
        # Parse: Meeting 2645: 11/13/2025 - Tampa City Council CRA Meeting
        # Extract: pkey, date, type
        # Map type to standard YouTube search term
        pass

    def get_meeting_by_id(self, meeting_id: int) -> Optional[Meeting]:
        """Get meeting metadata by ID."""
        pass

    def find_meetings_by_date(self, date: str) -> List[Meeting]:
        """Find all meetings for a specific date."""
        pass

    def find_meetings_by_week(self, week_start: str) -> List[Meeting]:
        """Find all meetings for a week (Monday-Sunday)."""
        pass

    def find_meetings_by_range(self, start: str, end: str) -> List[Meeting]:
        """Find all meetings in date range."""
        pass

# Returns:
Meeting(
    id=2645,
    date='2025-11-13',
    type='Community Redevelopment',  # Mapped from "CRA Meeting"
    title='Tampa City Council CRA Meeting',
    url='https://apps.tampagov.net/cttv_cc_webapp/Agenda.aspx?pkey=2645'
)
```

**Implementation Details:**

````python
def _scrape_meeting_listing(self) -> List[Dict]:
    """Scrape meeting data from main listing page."""
    import requests
    from bs4 import BeautifulSoup
    import re

    url = 'https://apps.tampagov.net/cttv_cc_webapp/'
    response = requests.get(url, timeout=30)
    soup = BeautifulSoup(response.content, 'html.parser')

    # Get pkeys from links
    pkey_links = {}
    for link in soup.find_all('a', href=True):
        if 'pkey=' in link['href']:
            match = re.search(r'pkey=(\d+)', link['href'])
            if match:
                pkey_links[match.group(1)] = link['href']

    # Extract meeting data from text
    text = soup.get_text()
    pattern = r'View\s*(\d{1,2}/\d{1,2}/\d{4})\s*(Tampa City Council[^\n]*)'
    matches = re.findall(pattern, text)

    # Correlate pkeys with meeting data (sorted in same order)
    pkeys = sorted(pkey_links.keys(), reverse=True)[:len(matches)]

    meetings = []
    for pkey, (date, title) in zip(pkeys, matches):
        # Parse meeting type from title
        # "Tampa City Council CRA Meeting" -> "CRA Meeting"
        meeting_type = title.replace('Tampa City Council ', '').strip()

        meetings.append({
            'id': int(pkey),
            'date': datetime.strptime(date, '%m/%d/%Y').strftime('%Y-%m-%d'),
            'title': title.strip(),
            'type': self._map_meeting_type(meeting_type),
            'url': f'https://apps.tampagov.net/cttv_cc_webapp/Agenda.aspx?pkey={pkey}'
        })

    return meetings

def _map_meeting_type(self, type_str: str) -> str:
    """Map meeting type string to YouTube search term."""
    for key, value in self.MEETING_TYPE_MAP.items():
        if key in type_str:
            return value
    return 'City Council'  # default
```#### Phase 2: Unified Processing Pipeline

**File:** `src/processing_pipeline.py`

**Purpose:** Orchestrate all processing steps for a single meeting

**Key Features:**

- Check if transcript already processed (skip if exists)
- Handle errors gracefully (log and continue to next meeting)
- Cache results at each step
- Report progress

**API:**

```python
class ProcessingPipeline:
    def process_meeting(self, meeting: Meeting, force: bool = False) -> ProcessingResult:
        """
        Process single meeting through entire pipeline.

        Steps:
        1. Scrape transcript (if not exists)
        2. Capitalize transcript (if not exists)
        3. Find YouTube videos
        4. Calculate offsets for all video parts
        5. Generate HTML static file

        Args:
            meeting: Meeting metadata
            force: Re-process even if outputs exist

        Returns:
            ProcessingResult with paths, status, errors
        """
        pass
````

**Internal Flow:**

```python
def process_meeting(self, meeting: Meeting, force: bool = False):
    result = ProcessingResult(meeting=meeting)

    # Step 1: Scrape transcript
    transcript_path = self._scrape_or_load(meeting, force)
    if not transcript_path:
        result.status = 'failed'
        result.error = 'Could not scrape transcript'
        return result

    # Step 2: Capitalize
    processed_path = self._capitalize_or_load(transcript_path, force)
    if not processed_path:
        result.status = 'failed'
        result.error = 'Capitalization failed'
        return result

    # Step 3: Find videos
    video_mapping = self._find_videos(meeting, force)
    if not video_mapping or not video_mapping.videos:
        result.status = 'failed'
        result.error = 'No videos found'
        return result

    # Step 4: Calculate offsets for all video parts
    for video in video_mapping.videos:
        # Determine optimal Whisper sample duration
        if video.part == 1:
            whisper_duration = 600  # 10 minutes standard
        else:
            # For Part 2+, check for long intros using chapter data
            if len(video.chapters) > 1 and video.chapters[1].seconds > 600:
                # Extend sample to capture speech after intro
                whisper_duration = video.chapters[1].seconds + 120
            else:
                whisper_duration = 600

        offset = self._calculate_offset(video, processed_path, whisper_duration, force)
        if offset is not None:
            video.offset_seconds = offset

    # Save updated video mapping with offsets
    self._save_video_mapping(video_mapping)

    # Step 5: Generate HTML
    html_path = self._generate_html(meeting, processed_path, video_mapping)

    result.status = 'success'
    result.transcript_path = processed_path
    result.video_mapping_path = video_mapping.path
    result.html_path = html_path
    return result
```

#### Phase 3: Weekly Batch Script

**File:** `process_weekly_meetings.py`

**Purpose:** Main entry point for weekly workflow

**Features:**

- Process multiple meetings in sequence
- Generate summary report
- Handle partial failures gracefully
- Optional dry-run mode

**Usage:**

```bash
# Standard weekly run (process last week)
python process_weekly_meetings.py --week 2025-11-18

# Dry run (show what would be processed)
python process_weekly_meetings.py --week 2025-11-18 --dry-run

# Force re-process even if exists
python process_weekly_meetings.py --week 2025-11-18 --force

# Specific date
python process_weekly_meetings.py --date 2025-11-13

# Date range
python process_weekly_meetings.py --start 2025-11-13 --end 2025-11-20

# Verbose output
python process_weekly_meetings.py --week 2025-11-18 --verbose
```

**Output Example:**

```
=============================================================
WEEKLY MEETING PROCESSOR
=============================================================
Week: 2025-11-18 to 2025-11-24
Found 3 meetings to process:

[1/3] Processing Meeting 2645 (CRA, 2025-11-13, AM)
  ✓ Transcript scraped: 651 segments
  ✓ Capitalized: data/processed/processed_transcript_2645_2025-11-13.json
  ✓ Found 2 videos (Part 1, Part 2)
  ✓ Offset calculated for Part 1: 480s (8:00)
  ✓ Offset calculated for Part 2: 0s (0:00)
  ✓ Video mapping saved: data/video_mapping_2645.json
  ✓ HTML generated: output/site/2645.html
  Status: SUCCESS (completed in 8m 23s)

[2/3] Processing Meeting 2644 (City Council PM, 2025-11-13, PM)
  ✓ Transcript scraped: 423 segments
  ✓ Capitalized: data/processed/processed_transcript_2644_2025-11-13.json
  ✓ Found 1 video
  ✓ Offset calculated: 30s (0:30)
  ✓ Video mapping saved: data/video_mapping_2644.json
  ✓ HTML generated: output/site/2644.html
  Status: SUCCESS (completed in 5m 12s)

[3/3] Processing Meeting 2646 (City Council PM, 2025-11-20, PM)
  ✓ Transcript scraped: 512 segments
  ✓ Capitalized: data/processed/processed_transcript_2646_2025-11-20.json
  ⚠ No videos found (may not be published yet)
  Status: PARTIAL (transcript ready, waiting for video)

=============================================================
SUMMARY
=============================================================
Total meetings: 3
Successful: 2
Partial: 1 (waiting for videos)
Failed: 0
Total time: 13m 35s

Generated files:
  - 3 processed transcripts
  - 2 video mappings
  - 2 HTML files

Next steps:
  - Review output/site/ for generated HTML
  - Re-run for meeting 2646 once video is published
=============================================================
```

## Detailed Implementation Steps

### Step 1: Create Meeting Discovery Service

**Subtasks:**

1. **Implement meeting listing scraper**

   - Parse `https://apps.tampagov.net/cttv_cc_webapp/` main page
   - Extract meeting ID (pkey), date, and type from table
   - Handle pagination if needed (currently shows 15 items per page)
   - Map meeting type strings to YouTube search terms

2. **Implement `MeetingDiscovery` class**

   - `refresh_meeting_cache()` - scrape and cache all meetings
   - `get_meeting_by_id(meeting_id)` - lookup by ID
   - `find_meetings_by_date(date)` - find all meetings on date
   - `find_meetings_by_week(week_start)` - get week's meetings
   - `find_meetings_by_range(start, end)` - date range query

3. **Add caching**

   - Save scraped data to `data/meeting_cache.json`
   - Auto-refresh if cache older than 24 hours
   - Manual refresh with `--refresh-cache` flag

4. **Update video_mapping with calculated offsets**

   - After calculating offset, update the video_mapping JSON file
   - Add `offset_seconds` field to each video object
   - Save updated mapping for HTML generation to use

   ```python
   # After calculating offset for a video
   video['offset_seconds'] = calculated_offset
   with open(video_mapping_path, 'w') as f:
       json.dump(mapping, f, indent=2)
   ```

5. **Add meeting type mapping**
   ```python
   MEETING_TYPE_MAP = {
       'CRA Meeting': 'Community Redevelopment',
       'Evening Meeting': 'City Council',
       'Meeting': 'City Council',
       'Workshop': 'Workshop',
       'Special Discussion': 'City Council'
   }
   ```

**Test Cases:**

- Verify meeting 2645 = CRA Meeting on 11/13/2025
- Verify meeting 2644 = Evening Meeting on 11/13/2025
- Verify meeting 2640 = Workshop on 10/30/2025
- Test date with multiple meetings (11/13/2025 should return 2 meetings)
- Test week range (should return all meetings in that week)

**Expected Output:**

```python
discovery = MeetingDiscovery()
meeting = discovery.get_meeting_by_id(2645)
# Returns: Meeting(id=2645, date='2025-11-13', type='Community Redevelopment',
#                  title='Tampa City Council CRA Meeting')

meetings = discovery.find_meetings_by_date('2025-11-13')
# Returns: [Meeting(2645, CRA), Meeting(2644, Evening)]
```

**Estimated Time:** 2-3 hours (reduced from 4-6 hours due to clear data source)

### Step 1.5: Add Meeting Type Detection (CRITICAL)

**Priority:** Must be done BEFORE Step 2 to avoid incorrect video mappings

**Subtasks:**

1. **Enhance scraper to detect meeting type**

   - Parse first 3-5 transcript segments for keywords
   - Keywords: "CRA MEETING", "COMMUNITY REDEVELOPMENT", "CITY COUNCIL", "WORKSHOP"
   - Add `meeting_type` field to transcript JSON
   - Map detected keywords to standard types:
     - "CRA" / "Community Redevelopment" → `"Community Redevelopment"`
     - "CITY COUNCIL" → `"City Council"`
     - "WORKSHOP" → `"Workshop"`
   - Default to `"City Council"` if no keywords found

2. **Update video fetcher to read meeting type**

   - Add method `get_meeting_type_from_transcript(transcript_path)`
   - If `meeting_type` parameter not provided, read from transcript
   - Fallback chain: parameter → transcript file → default "City Council"

3. **Add detection utility**

   ```python
   # src/meeting_type_detector.py
   class MeetingTypeDetector:
       PATTERNS = {
           'Community Redevelopment': [
               r'CRA\s+MEETING',
               r'COMMUNITY\s+REDEVELOPMENT',
               r'REDEVELOPMENT\s+AGENCY'
           ],
           'City Council': [
               r'CITY\s+COUNCIL',
               r'COUNCIL\s+MEETING'
           ],
           'Workshop': [
               r'WORKSHOP'
           ]
       }

       def detect_from_text(self, text: str) -> str:
           """Detect meeting type from transcript text."""
           for meeting_type, patterns in self.PATTERNS.items():
               for pattern in patterns:
                   if re.search(pattern, text, re.IGNORECASE):
                       return meeting_type
           return 'City Council'  # default

       def detect_from_transcript_file(self, path: str) -> str:
           """Read transcript and detect meeting type."""
           with open(path) as f:
               data = json.load(f)
               # Check first 5 segments
               for segment in data.get('segments', [])[:5]:
                   detected = self.detect_from_text(segment.get('text', ''))
                   if detected != 'City Council':  # Found specific type
                       return detected
           return 'City Council'
   ```

4. **Update existing scraped transcripts**

   - Run detection on all existing transcript files
   - Add `meeting_type` field retroactively
   - Create migration script: `scripts/add_meeting_types.py`

5. **Add validation**
   - Log detected meeting type during scraping
   - Warn if video search finds different type than detected
   - Add `--meeting-type` override flag for corrections

**Expected Results:**

- Transcript 2645 would have `"meeting_type": "Community Redevelopment"`
- Transcript 2644 would have `"meeting_type": "City Council"`
- Video fetcher would automatically use correct type
- No more manual specification needed for standard workflow

**Estimated Time:** 3-4 hours

### Step 2: Refactor Existing Scripts into Pipeline

**Subtasks:**

1. Create `ProcessingPipeline` class

   - Wrap existing scraper.py functionality
   - Wrap capitalize_transcript.py functionality
   - Wrap youtube_fetcher.py functionality
   - Wrap match_whisper_to_transcript.py functionality
   - Wrap html_generator.py functionality

2. Add "smart skip" logic

   - Check if output exists before running
   - Add `--force` flag to override
   - Log what was skipped vs processed

3. Add error handling

   - Try/except around each step
   - Log errors but continue processing
   - Return detailed status for each step

4. Add progress reporting
   - Log each step as it starts
   - Show estimated time remaining
   - Report success/failure with details

**Estimated Time:** 6-8 hours

### Step 3: Create Weekly Batch Script

**Subtasks:**

1. Implement CLI interface

   - argparse for --week, --date, --start/--end
   - Add --dry-run, --force, --verbose flags
   - Add --meeting-type filter (optional)

2. Implement date range logic

   - Convert week to start/end dates
   - Validate date formats
   - Handle single date vs range

3. Implement batch processing

   - Loop through discovered meetings
   - Call pipeline for each
   - Collect results

4. Implement summary report
   - Count successes/failures/partials
   - List generated files
   - Suggest next steps

**Estimated Time:** 3-4 hours

### Step 4: Add Configuration File

**File:** `config/processing.yaml`

**Purpose:** Centralize configuration

**Contents:**

```yaml
# Processing settings
cache_whisper: true
whisper_model: small
whisper_duration: 600 # 10 minutes

# File paths
transcript_dir: data/transcripts
processed_dir: data/processed
video_mapping_dir: data
whisper_cache_dir: data/whisper_cache
html_output_dir: output/site

# YouTube settings
youtube_search_window_days: 4 # Search 1 day before to 3 days after
youtube_channel_id: UCLzohJmEgvfJOEd4YJNIHbg

# Meeting type patterns
meeting_types:
  - pattern: "community redevelopment"
    type: CRA
  - pattern: "city council"
    type: City Council
  - pattern: "workshop"
    type: Workshop

# Processing options
skip_existing: true # Skip if output already exists
max_retries: 3
parallel_videos: true # Process multiple video offsets in parallel
```

**Estimated Time:** 1-2 hours

### Step 5: Update Documentation

**Subtasks:**

1. Update WORKFLOW.md

   - Add "Quick Start" section with new script
   - Move current detailed steps to "Manual Processing" section
   - Add troubleshooting for new script

2. Create DEVELOPMENT.md

   - Document architecture
   - Explain each component
   - Add contributing guide

3. Add inline documentation
   - Docstrings for all classes/methods
   - Type hints throughout
   - Examples in docstrings

**Estimated Time:** 2-3 hours

## Benefits of New Workflow

### For Weekly Processing

**Before:**

```bash
# User must manually find meeting IDs and dates
# Then run 4-5 commands per meeting
# Total: ~20 commands for a typical week
```

**After:**

```bash
# Single command processes entire week
python process_weekly_meetings.py --week 2025-11-18
```

**Time Savings:** ~90% reduction in manual steps

### For Development

- Easier to test (mock each component)
- Easier to debug (clear separation of concerns)
- Easier to extend (add new steps to pipeline)
- Better error messages
- Progress visibility

### For Maintenance

- Centralized configuration
- Clear documentation
- Type hints reduce bugs
- Automated tests possible

## Migration Plan

### Phase 1: Meeting Discovery (Week 1)

- Implement `MeetingDiscovery` class
- Test on recent meetings
- Add unit tests

### Phase 2: Pipeline Refactor (Week 2)

- Create `ProcessingPipeline` class
- Refactor existing scripts
- Test on single meeting
- Add integration tests

### Phase 3: Batch Script (Week 3)

- Implement `process_weekly_meetings.py`
- Test on one week
- Add CLI tests

### Phase 4: Polish (Week 4)

- Add configuration file
- Update documentation
- Test end-to-end
- Deploy for production use

## Backward Compatibility

Keep existing scripts working:

- `src/scraper.py` - keep as-is, used internally by pipeline
- `capitalize_transcript.py` - keep as-is, used internally by pipeline
- `src/youtube_fetcher.py` - keep as-is, used internally by pipeline
- `scripts/build/match_whisper_to_transcript.py` - keep as-is, used internally by pipeline

Users can still run individual steps if needed for debugging or special cases.

## Special Cases to Handle

### Historical Transcripts (Older Videos)

```bash
# Override video search date range
python process_weekly_meetings.py --date 2022-11-01 --video-date 2025-10-15

# Or provide video IDs manually
python process_weekly_meetings.py --date 2022-11-01 --video-id abc123,def456
```

### Missing Videos

- Pipeline should handle gracefully
- Mark as "partial" success
- Allow re-run later without re-processing transcript

### Multi-Part Meetings

- Pipeline should automatically detect
- Process all parts
- Calculate offset for each part
- **Challenge discovered:** videos can have long intros (10+ minutes of silence/music)

**Test Results from Meeting 2645 (CRA with 2 parts):**

- ✅ Part 1 (SocxtU6vTKc): 10-minute Whisper sample found match at **552s offset (9:12)**
- ❌ Part 2 (oCSGYDZXHbk): 10-minute sample had **NO SPEECH** - intro is 630s (10:30)
- ✅ Part 2 with 15-minute sample: Found speech at **630s offset (10:30)**

**Key Finding:** Part 1 ends at 12:04 PM, Part 2 resumes at 1:36 PM = **92-minute lunch break** not in videos

**Offset Definition for Multi-Part Videos:**

- Part 1 offset: Dead time before meeting starts (intro music/countdown)
- Part 2+ offset: Dead time before meeting **resumes** in that video part
- Each part has its own independent offset from video start time

**Proposed Solutions:**

1. **Adaptive Whisper duration based on chapter data**

   - Part 1: Use 10 minutes (standard)
   - Part 2+: Check second chapter timestamp
     - If chapter[1].seconds > 600: sample (chapter[1].seconds + 120) seconds
     - Example: Part 2 chapter at 11:12 (672s) → sample 13-14 minutes
   - This ensures we capture speech even with long intros

2. **Use scheduled meeting times as hints**

   - AM meetings scheduled 9:00 AM (allow 10-minute late start buffer)
   - PM meetings scheduled 5:01 PM (allow 10-minute late start buffer)
   - **For multi-part meetings:** Part 2 typically resumes at 1:30 PM after lunch
   - Check for large gaps in transcript timestamps (>60 minutes) to identify lunch breaks
   - Use gap detection to determine which video part covers which transcript sections

3. **Multi-part video strategy (TESTED):**

   ```python
   # Pseudo-code for multi-part offset calculation
   for video_part in videos:
       if video_part.part == 1:
           whisper_duration = 600  # 10 minutes standard
       else:
           # Check if part has long intro using chapters
           if video_part.chapters[1].seconds > 600:
               # Sample past the intro + buffer
               whisper_duration = video_part.chapters[1].seconds + 120
           else:
               whisper_duration = 600  # Standard

       # Transcribe and match
       offset = calculate_offset(video_part, whisper_duration)
       video_part.offset_seconds = offset
   ```

4. **Transcript gap detection for Part 2 start estimation:**

   ```python
   # Find where Part 2 content starts in transcript
   gaps = []
   for i in range(len(segments) - 1):
       time_gap = segments[i+1].time - segments[i].time
       if time_gap > 3600:  # 60 minute gap
           gaps.append({
               'after_segment': i,
               'gap_minutes': time_gap / 60,
               'resume_time': segments[i+1].timestamp
           })

   # Largest gap is likely lunch break
   # Part 2 content starts after this gap
   ```

5. **Chapter-assisted offset calculation**

   - Match chapter titles to transcript text
   - Use chapter timestamp as anchor point
   - More accurate than pure Whisper text matching
   - Example: Find "Item 9: CRA25-18657" in both chapter and transcript

6. **Part 2 estimation from Part 1**
   - Part1_content_duration = Part1_total - Part1_offset
   - Part2_expected_transcript_start ≈ Part1_content_duration
   - Use as hint for where to look in transcript
   - Reduces Whisper search space

**Implementation Priority:** HIGH - Multi-part meetings are common for CRA and long City Council sessions

### Manual Overrides

```bash
# Force specific meeting type
python process_weekly_meetings.py --date 2025-11-13 --meeting-type CRA

# Skip specific steps
python process_weekly_meetings.py --date 2025-11-13 --skip-html

# Specify meeting ID manually (for older transcripts)
python process_weekly_meetings.py --meeting-id 2435 --date 2022-11-01
```

## Success Metrics

- **Time to process one week:** <15 minutes (currently ~1 hour manual)
- **Error rate:** <5% (with graceful handling and clear errors)
- **Lines of code to run weekly:** 1 command (currently 15-20)
- **Documentation clarity:** New users can process meetings in <5 minutes

## Next Steps

1. Review this plan
2. Prioritize phases
3. Set timeline
4. Begin implementation with Phase 1
