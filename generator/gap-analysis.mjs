import { findContentGaps } from '../lib/codex.mjs';

/**
 * Perform gap analysis to find topics missing from content
 * @param {Array<Object>} existingArticles - Existing article metadata
 * @param {Object} siteConfig - Site configuration
 * @returns {Promise<Array<Object>>} Suggested gap topics
 */
export async function performGapAnalysis(existingArticles, siteConfig) {
  console.log('Analyzing content gaps...');

  const gapTopics = await findContentGaps(
    existingArticles,
    siteConfig
  );

  if (gapTopics.length > 0) {
    console.log(`Found ${gapTopics.length} gap topics:`);
    gapTopics.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.topic} (relevance: ${t.relevanceScore})`);
    });
  } else {
    console.log('No gap topics found.');
  }

  // Convert gap topics to same format as trending topics
  return gapTopics
    .filter(t => (t.closestSeedKeyword || '').trim())
    .map(t => ({
      topic: t.topic,
      score: t.relevanceScore || 50, // Use relevance score as trend score
      source: 'gap-analysis',
      reasoning: t.reasoning,
      preferredKeyword: t.closestSeedKeyword || '',
      suggestedAngle: t.suggestedAngle || '',
      topicType: t.topicType || 'narrow_practical'
    }));
}

/**
 * Select best topic from available topics
 * @param {Array<Object>} topics - Available topics
 * @returns {Object|null} Best topic or null if none available
 */
export function selectBestTopic(topics) {
  if (!topics || topics.length === 0) {
    return null;
  }

  // Sort by score descending
  const sorted = [...topics].sort((a, b) => b.score - a.score);

  // Return top topic
  return sorted[0];
}

/**
 * Select top N topics from available topics with diversity
 * @param {Array<Object>} topics - Available topics
 * @param {number} count - Number of topics to select (default: 2)
 * @returns {Array<Object>} Top N topics (may be fewer if not enough available)
 */
export function selectTopTopics(topics, count = 2) {
  if (!topics || topics.length === 0) {
    return [];
  }

  // Sort by score descending
  const sorted = [...topics].sort((a, b) => b.score - a.score);

  // If only 1 needed or 1 available, return immediately
  if (count === 1 || sorted.length === 1) {
    return sorted.slice(0, count);
  }

  // For multiple topics, ensure diversity
  const selected = [sorted[0]]; // Always take top topic

  for (let i = 1; i < sorted.length && selected.length < count; i++) {
    const candidate = sorted[i];

    // Check if too similar to already selected topics
    const isSimilar = selected.some(s => areSimilarTopics(s.topic, candidate.topic));

    if (!isSimilar) {
      selected.push(candidate);
    }
  }

  return selected;
}

export function selectBalancedTopics(trendingTopics = [], gapTopics = [], count = 2) {
  const combined = [...trendingTopics, ...gapTopics]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (combined.length <= count) {
    return combined;
  }

  const broad = combined.filter((topic) => topic.topicType === 'broad_strategic');
  const narrow = combined.filter((topic) => topic.topicType !== 'broad_strategic');
  const selected = [];

  if (broad.length > 0) {
    selected.push(broad[0]);
  }

  if (narrow.length > 0) {
    const narrowCandidate = narrow.find(
      (topic) => !selected.some((picked) => areSimilarTopics(picked.topic, topic.topic)),
    );
    if (narrowCandidate) {
      selected.push(narrowCandidate);
    }
  }

  if (selected.length >= count) {
    return selected.slice(0, count);
  }

  for (const candidate of combined) {
    if (selected.length >= count) {
      break;
    }

    const alreadySelected = selected.some((picked) => picked.topic === candidate.topic);
    const tooSimilar = selected.some((picked) => areSimilarTopics(picked.topic, candidate.topic));

    if (!alreadySelected && !tooSimilar) {
      selected.push(candidate);
    }
  }

  return selected.slice(0, count);
}

/**
 * Check if two topics are too similar (same main tool/system)
 * @param {string} topic1 - First topic
 * @param {string} topic2 - Second topic
 * @returns {boolean} True if topics are too similar
 */
function areSimilarTopics(topic1, topic2) {
  const t1 = topic1.toLowerCase();
  const t2 = topic2.toLowerCase();

  // List of main tools/systems to check for
  const mainTools = [
    'fortnox', 'visma', 'business central', 'monitor',
    'pipedrive', 'lime crm', 'superoffice', 'dynamics',
    'microsoft 365', 'teams', 'sharepoint', 'power automate',
    'make', 'zapier', 'n8n',
    'shopify', 'woocommerce',
    'sap'
  ];

  // Check if both topics mention the same main tool
  for (const tool of mainTools) {
    if (t1.includes(tool) && t2.includes(tool)) {
      return true; // Too similar - same tool/system
    }
  }

  return false; // Different enough
}
