#!/usr/bin/env python3
"""
Google Trends fetcher using pytrends
"""

import sys
import json
import time
from pytrends.request import TrendReq

def get_trending_topics(keywords, region='SE'):
    """
    Fetch trending topics for given keywords

    Args:
        keywords: List of seed keywords
        region: Region code (default: SE for Sweden)

    Returns:
        List of trending topics with scores
    """
    try:
        # Initialize pytrends
        pytrends = TrendReq(hl='sv-SE', tz=60)

        results = []

        # Get related queries for each keyword (don't use seed keyword itself)
        for i, keyword in enumerate(keywords):
            try:
                # Add delay between requests to avoid rate limiting
                if i > 0:
                    time.sleep(3)

                pytrends.build_payload([keyword], timeframe='now 7-d', geo=region)

                # Get related queries (both rising and top)
                related = pytrends.related_queries()

                if keyword in related:
                    # Add rising queries (fast-growing searches)
                    if related[keyword]['rising'] is not None:
                        rising = related[keyword]['rising']
                        if not rising.empty:
                            for _, row in rising.head(5).iterrows():
                                results.append({
                                    'topic': row['query'],
                                    'score': int(row['value']) if row['value'] != 'Breakout' else 100,
                                    'timeframe': '7d',
                                    'type': 'rising',
                                    'relatedTo': keyword
                                })

                    # Add top queries (most searched related terms)
                    if related[keyword]['top'] is not None:
                        top = related[keyword]['top']
                        if not top.empty:
                            for _, row in top.head(5).iterrows():
                                results.append({
                                    'topic': row['query'],
                                    'score': int(row['value']),
                                    'timeframe': '7d',
                                    'type': 'top',
                                    'relatedTo': keyword
                                })

            except Exception as e:
                print(f"Warning: Failed to fetch trends for '{keyword}': {str(e)}", file=sys.stderr)
                continue

        # Remove duplicates (same topic can appear in both rising and top)
        seen = {}
        unique_results = []
        for item in results:
            topic_lower = item['topic'].lower()
            if topic_lower not in seen:
                seen[topic_lower] = True
                unique_results.append(item)
            else:
                # Keep the one with higher score
                for i, existing in enumerate(unique_results):
                    if existing['topic'].lower() == topic_lower:
                        if item['score'] > existing['score']:
                            unique_results[i] = item
                        break

        # Sort by score descending
        unique_results.sort(key=lambda x: x['score'], reverse=True)

        return unique_results

    except Exception as e:
        print(f"Error in get_trending_topics: {str(e)}", file=sys.stderr)
        return []

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: trends.py <keywords_comma_separated> [region]", file=sys.stderr)
        sys.exit(1)

    keywords_str = sys.argv[1]
    keywords = [k.strip() for k in keywords_str.split(',')]

    region = sys.argv[2] if len(sys.argv) > 2 else 'SE'

    topics = get_trending_topics(keywords, region)

    # Output JSON
    print(json.dumps(topics, ensure_ascii=False, indent=2))
