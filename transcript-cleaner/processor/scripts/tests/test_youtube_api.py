"""
Test script to debug YouTube API and find the correct channel ID
"""

import os
from dotenv import load_dotenv
from googleapiclient.discovery import build

load_dotenv()

api_key = os.getenv('YOUTUBE_API_KEY')
if not api_key:
    print("ERROR: YOUTUBE_API_KEY not found in environment")
    exit(1)

youtube = build('youtube', 'v3', developerKey=api_key)

print("Testing YouTube API connection...")
print(f"API Key: {api_key[:10]}...{api_key[-4:]}")
print()

# Try to search for Tampa City Council videos
print("Searching for 'Tampa City Council' videos...")
search_request = youtube.search().list(
    part='snippet',
    q='Tampa City Council',
    type='video',
    maxResults=10,
    order='date'
)

try:
    search_response = search_request.execute()
    
    print(f"\nFound {len(search_response.get('items', []))} videos:\n")
    
    for item in search_response['items']:
        title = item['snippet']['title']
        channel = item['snippet']['channelTitle']
        channel_id = item['snippet']['channelId']
        published = item['snippet']['publishedAt'][:10]
        video_id = item['id']['videoId']
        
        print(f"Date: {published}")
        print(f"Title: {title}")
        print(f"Channel: {channel}")
        print(f"Channel ID: {channel_id}")
        print(f"Video ID: {video_id}")
        print(f"URL: https://www.youtube.com/watch?v={video_id}")
        print("-" * 80)
        
except Exception as e:
    print(f"ERROR: {e}")
