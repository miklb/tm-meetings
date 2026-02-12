# YouTube Video Integration

## Getting a YouTube API Key

To automatically fetch YouTube videos for meetings, you need a YouTube Data API v3 key.

### Steps:

1. **Go to Google Cloud Console**: https://console.cloud.google.com/

2. **Create a new project** (or select existing):

   - Click "Select a project" dropdown
   - Click "NEW PROJECT"
   - Name it "Tampa Transcript Cleaner"
   - Click "CREATE"

3. **Enable YouTube Data API v3**:

   - Go to "APIs & Services" > "Library"
   - Search for "YouTube Data API v3"
   - Click on it
   - Click "ENABLE"

4. **Create API credentials**:

   - Go to "APIs & Services" > "Credentials"
   - Click "+ CREATE CREDENTIALS"
   - Select "API key"
   - Copy the generated API key
   - (Optional but recommended) Click "RESTRICT KEY":
     - Under "API restrictions", select "Restrict key"
     - Check only "YouTube Data API v3"
     - Click "SAVE"

5. **Set the environment variable**:

   ```bash
   export YOUTUBE_API_KEY="your-api-key-here"
   ```

   Or add to `.env` file:

   ```
   YOUTUBE_API_KEY=your-api-key-here
   ```

## Usage

### Find videos for a specific meeting date:

```bash
cd processor
source venv/bin/activate
python src/youtube_fetcher.py "2025-10-23"
```

### Example output:

```
Found 3 video(s) for 2025-10-23:

Part 1:
  Title: Tampa City Council 10/23/2025 - Part 1
  Video ID: abc123xyz
  URL: https://www.youtube.com/watch?v=abc123xyz
  Duration: PT2H15M30S

Part 2:
  Title: Tampa City Council 10/23/2025 - Part 2
  Video ID: def456uvw
  URL: https://www.youtube.com/watch?v=def456uvw
  Duration: PT1H45M20S

Part 3:
  Title: Tampa City Council 10/23/2025 - Part 3
  Video ID: ghi789rst
  URL: https://www.youtube.com/watch?v=ghi789rst
  Duration: PT0H30M10S
```

## Video Naming Patterns

The fetcher automatically detects these patterns:

- **Morning/Afternoon split**: "Tampa City Council 10/23/2025 - Morning Session"
- **Part numbers**: "Tampa City Council 10/23/2025 - Part 1", "Part 2", "Part 3"
- **Single video**: Just the date

## How It Works

1. **Search by date**: Queries YouTube for videos published around the meeting date
2. **Filter by channel**: Only considers videos from @cityoftampameetings
3. **Match titles**: Looks for meeting date in video titles
4. **Parse parts**: Detects "Part 1/2/3" or "Morning/Afternoon" in titles
5. **Sort videos**: Orders videos by part number and session

## Transcript Timestamp Mapping

When a meeting has multiple videos, timestamps need to know which video they belong to:

- Part 1 (Morning): `09:00:00AM` - `11:59:59AM`
- Part 2 (Afternoon): `12:00:00PM` - `05:59:59PM`
- Part 3 (Evening/Continuation): `06:00:00PM+`

The HTML generator will:

1. Detect which video part contains each timestamp
2. Embed the appropriate video player
3. Calculate timestamp offsets for seeking

## API Quotas

YouTube Data API v3 has a quota of 10,000 units/day (free tier).

**Cost per operation**:

- Search: 100 units
- Video details: 1 unit

**Typical usage**:

- Finding videos for one meeting: ~105 units (1 search + 5 video details)
- Processing 90 meetings: ~9,450 units (within daily quota)

If you hit quota limits:

1. Request quota increase in Google Cloud Console
2. Or manually specify video IDs in a config file

## Fallback: Manual Video IDs

If API key is not available, create `video_mappings.json`:

```json
{
  "2639": {
    "meeting_id": 2639,
    "meeting_date": "2025-10-23",
    "videos": [
      {
        "video_id": "abc123xyz",
        "title": "Tampa City Council 10/23/2025 - Part 1",
        "part": 1,
        "session": null
      },
      {
        "video_id": "def456uvw",
        "title": "Tampa City Council 10/23/2025 - Part 2",
        "part": 2,
        "session": null
      }
    ]
  }
}
```

## Next Steps

1. Get YouTube API key
2. Run `youtube_fetcher.py` for meeting 2639
3. Integrate video IDs into HTML generator
4. Test video sync with multiple parts
