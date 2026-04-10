import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache file location
const CACHE_DIR = join(__dirname, '../.local');
const CACHE_FILE = join(CACHE_DIR, 'trends-cache.json');

// Cache TTL: 7 days
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Load trends cache from disk
 * @returns {Object} Cache object
 */
export function loadCache() {
  if (!existsSync(CACHE_FILE)) {
    return {};
  }

  try {
    const content = readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn('Failed to load trends cache:', err.message);
    return {};
  }
}

/**
 * Save trends cache to disk
 * @param {Object} cache - Cache object to save
 */
export function saveCache(cache) {
  try {
    // Ensure directory exists
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }

    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save trends cache:', err.message);
  }
}

/**
 * Check if a cached entry is still valid
 * @param {Object} entry - Cache entry
 * @returns {boolean} True if valid
 */
export function isCacheValid(entry) {
  if (!entry || !entry.fetchedAt) {
    return false;
  }

  const fetchedAt = new Date(entry.fetchedAt);
  const expiresAt = new Date(fetchedAt.getTime() + CACHE_TTL_MS);

  return new Date() < expiresAt;
}

/**
 * Select which keywords to fetch (max N oldest/missing)
 * @param {Array<string>} allKeywords - All seed keywords
 * @param {Object} cache - Current cache
 * @param {number} maxToFetch - Max keywords to fetch (default: 3)
 * @returns {Array<string>} Keywords to fetch
 */
export function selectKeywordsToFetch(allKeywords, cache, maxToFetch = 3) {
  // Group keywords by cache status
  const missing = [];
  const expired = [];
  const valid = [];

  for (const keyword of allKeywords) {
    const entry = cache[keyword];

    if (!entry) {
      missing.push({ keyword, priority: 3 });
    } else if (!isCacheValid(entry)) {
      expired.push({
        keyword,
        priority: 2,
        fetchedAt: new Date(entry.fetchedAt)
      });
    } else {
      valid.push({
        keyword,
        priority: 1,
        fetchedAt: new Date(entry.fetchedAt)
      });
    }
  }

  // Sort: missing first, then expired (oldest first)
  const toFetch = [
    ...missing,
    ...expired.sort((a, b) => a.fetchedAt - b.fetchedAt)
  ];

  // Return max N keywords
  return toFetch.slice(0, maxToFetch).map(item => item.keyword);
}

/**
 * Get all valid topics from cache
 * @param {Object} cache - Current cache
 * @returns {Array<Object>} All valid cached topics
 */
export function getAllCachedTopics(cache) {
  const allTopics = [];

  for (const [keyword, entry] of Object.entries(cache)) {
    if (isCacheValid(entry) && entry.topics) {
      allTopics.push(...entry.topics);
    }
  }

  return allTopics;
}

/**
 * Update cache with new topics for a keyword
 * @param {Object} cache - Current cache
 * @param {string} keyword - Keyword
 * @param {Array<Object>} topics - Topics to cache
 * @returns {Object} Updated cache
 */
export function updateCache(cache, keyword, topics) {
  const now = new Date().toISOString();

  cache[keyword] = {
    topics,
    fetchedAt: now,
    expiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString()
  };

  return cache;
}
