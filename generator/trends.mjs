import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  loadCache,
  saveCache,
  selectKeywordsToFetch,
  getAllCachedTopics,
  updateCache
} from './trends-cache.mjs';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get trending topics using pytrends with smart caching and rotation
 * @param {Array<string>} keywords - Seed keywords to search for
 * @param {string} region - Region code (default: SE)
 * @returns {Promise<Array<Object>>} Array of trending topics
 */
export async function getTrendingTopics(keywords, region = 'SE') {
  if (!keywords || keywords.length === 0) {
    console.warn('No keywords provided for trends search');
    return [];
  }

  // Load cache
  let cache = loadCache();

  // Select max 3 keywords to fetch (oldest/missing first)
  const keywordsToFetch = selectKeywordsToFetch(keywords, cache, 3);

  console.log(`Cache status: ${keywords.length} total keywords`);
  console.log(`Fetching fresh data for: ${keywordsToFetch.length} keywords`);
  if (keywordsToFetch.length > 0) {
    console.log(`  - ${keywordsToFetch.join(', ')}`);
  }

  // Fetch fresh data for selected keywords
  if (keywordsToFetch.length > 0) {
    const freshTopics = await fetchFromPytrends(keywordsToFetch, region);

    // Group topics by keyword and update cache
    for (const keyword of keywordsToFetch) {
      const keywordTopics = freshTopics.filter(t => t.relatedTo === keyword);
      cache = updateCache(cache, keyword, keywordTopics);
    }

    // Save updated cache
    saveCache(cache);
  }

  // Get all valid cached topics
  const allTopics = getAllCachedTopics(cache);
  console.log(`Total topics available: ${allTopics.length} (from cache + fresh data)`);

  return allTopics;
}

/**
 * Fetch topics from pytrends Python script
 * @param {Array<string>} keywords - Keywords to fetch
 * @param {string} region - Region code
 * @returns {Promise<Array<Object>>} Fetched topics
 */
async function fetchFromPytrends(keywords, region) {
  const pythonScript = join(__dirname, 'trends.py');
  const keywordsStr = keywords.join(',');

  try {
    const command = `python3 "${pythonScript}" "${keywordsStr}" "${region}"`;
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 1024 * 1024 * 5, // 5MB buffer
    });

    if (stderr) {
      console.warn('Trends stderr:', stderr);
    }

    const topics = JSON.parse(stdout);
    console.log(`Fetched ${topics.length} fresh topics from Google Trends`);

    return topics;
  } catch (err) {
    console.error('Failed to fetch trends:', err.message);
    return [];
  }
}

/**
 * Setup pytrends (check if installed)
 * @returns {Promise<boolean>} True if pytrends is available
 */
export async function checkPytrends() {
  try {
    await execAsync('python3 -c "import pytrends"');
    return true;
  } catch (err) {
    console.error('pytrends not installed. Run: npm run setup');
    return false;
  }
}
