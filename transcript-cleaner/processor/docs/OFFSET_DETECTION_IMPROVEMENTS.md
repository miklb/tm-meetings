# Offset Detection Improvements

## Problem Discovered

Meeting 2637 Part 2 had incorrect offset detection:

- **Detected**: 390s (6m30s) - pointing to `[Music]` intro
- **Actual**: 477s (7m57s) - where speech actually starts
- **Root cause**: Algorithm was matching text within `[Music]` captions

## How YouTube Auto-Captions Work

YouTube's auto-generated captions can include:

- `[Music]` - Musical intros, outros, background music
- `[Applause]` - Audience reactions
- **Text overlay on music** - Sometimes captions show meeting text during intro music/graphics

Example from Part 2:

```
390.9s: [Music]  <- Contains "I CALL THIS MEETING TO ORDER..." in caption
476.9s: I call this meeting to order. Roll call,  <- Actual speech starts
```

The old algorithm matched at 390s with 70% confidence because the text was present in the caption metadata, even though it was labeled as `[Music]`.

## Solution Implemented

### 1. Filter Out Non-Speech Captions

Skip `[Music]` and `[Applause]` captions during matching:

```python
# Skip [Music] and [Applause] as starting points
if '[Music]' in caption.text or '[Applause]' in caption.text:
    continue

# Also skip them when building the window
window_text = " ".join([
    self._clean_text(captions_list[j].text)
    for j in range(i, window_end)
    if '[Music]' not in captions_list[j].text
    and '[Applause]' not in captions_list[j].text
])
```

### 2. Add First-Speech Fallback

If no good match is found (< 50% confidence), use the timestamp of the first non-music caption:

```python
# Fallback: Use first speech caption if available
if speech_captions and speech_captions[0].start < max_search_seconds:
    fallback_offset = int(speech_captions[0].start)
    print(f"   💡 FALLBACK: Using first speech caption at {fallback_offset}s")
    return fallback_offset
```

### 3. Better Debugging Output

Added visibility into what's being processed:

- Show first speech caption timestamp
- Report number of speech captions checked (vs total)
- Indicate when fallback strategy is used

## Results

### Before (Old Algorithm)

```
Checked 193 captions
✅ Found match at 390s (confidence: 70.10%)
YouTube: [Music]
```

❌ Wrong - pointed to music intro

### After (Updated Algorithm)

```
🎤 First speech caption at 476.9s: I call this meeting to order...
Checked 192 speech captions
✅ Found match at 476s (confidence: 69.04%)
YouTube: I call this meeting to order. Roll call,
```

✅ Correct - points to actual speech start (only 1s off)

## Benefits

1. **More Accurate**: Finds actual speech start, not pre-roll
2. **Robust Fallback**: Even if matching fails, first-speech detection works
3. **General Solution**: Works for any meeting with music/graphics intro
4. **Better UX**: Users don't have to manually correct as often

## When to Use Each Strategy

### Primary: Text Matching (with [Music] filtering)

- **Best for**: Meetings where transcript matches captions well
- **Confidence threshold**: 50%
- **Handles**: Minor timing differences, caption fragmentation

### Fallback: First Speech Detection

- **Best for**: Meetings with poor caption quality or heavy editing
- **Triggers**: When primary matching < 50% confidence
- **Assumption**: First non-music caption is meeting start

### Manual Entry

- **Last resort**: Both strategies fail
- **Example scenarios**:
  - No auto-captions available
  - Speech starts beyond 15min search window
  - Transcript format completely different from captions

## Testing

Created test scripts:

- `debug_part2_offset.py` - Show first 30 captions and check specific time
- `debug_offset_detection.py` - Detailed analysis of why detection failed
- `test_updated_algorithm.py` - Verify fix works correctly

All tests confirm the updated algorithm correctly identifies offset at 476-477s for Part 2.

## Future Enhancements

1. **Pattern Detection**: Recognize common intro sequences

   - Tampa City Council logo/music typically 5-10 minutes
   - Could pre-populate suggested offset ranges

2. **Multi-Strategy Scoring**: Combine multiple signals

   - First speech timestamp
   - Pattern matching confidence
   - Video chapter markers
   - Weight by reliability

3. **Learning**: Track which strategy works for each meeting type

   - Build database of meeting patterns
   - Suggest most likely strategy first

4. **Video Analysis**: Use video frames (not just audio captions)
   - Detect scene changes (intro → council chamber)
   - OCR on video for "Tampa City Council" graphics
   - Motion detection (static logo vs. people moving)
