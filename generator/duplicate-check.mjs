import { semanticCompare, checkTopicRelevance } from '../lib/codex.mjs';

/**
 * Check if a topic is a duplicate of existing content
 * @param {Object} topic - Topic object with { topic, score }
 * @param {Array<Object>} existingArticles - Existing article metadata
 * @param {Array<Object>} existingDrafts - Existing draft objects
 * @returns {Promise<Object>} { isDuplicate, reasoning, similarity }
 */
export async function checkDuplicate(topic, existingArticles, existingDrafts) {
  // Combine articles and drafts for comparison
  const allContent = [
    ...existingArticles.map(a => ({ title: a.title, tags: a.tags })),
    ...existingDrafts
      .filter(d => d.status === 'pending' || d.status === 'approved')
      .map(d => ({ title: d.title, tags: d.tags }))
  ];

  if (allContent.length === 0) {
    // No existing content, so definitely not a duplicate
    return {
      isDuplicate: false,
      reasoning: 'No existing content to compare against',
      similarity: 0
    };
  }

  // Use Codex to perform semantic comparison
  const result = await semanticCompare(topic.topic, allContent);

  console.log(`Duplicate check for "${topic.topic}": ${result.isDuplicate ? 'DUPLICATE' : 'UNIQUE'} (${result.similarity}% similar)`);

  return result;
}

/**
 * Filter topics to remove duplicates and irrelevant topics
 * @param {Array<Object>} topics - Array of topic objects
 * @param {Array<Object>} existingArticles - Existing article metadata
 * @param {Array<Object>} existingDrafts - Existing draft objects
 * @param {string} niche - Site niche for relevance checking
 * @returns {Promise<Array<Object>>} Filtered topics (non-duplicates + relevant)
 */
export async function filterDuplicates(topics, existingArticles, existingDrafts, niche, seedKeywords = []) {
  const validTopics = [];

  for (const topic of topics) {
    // First check relevance
    console.log(`\nChecking relevance for "${topic.topic}"...`);
    const relevanceCheck = await checkTopicRelevance(topic.topic, niche, seedKeywords);
    const relevanceScore = relevanceCheck.relevanceScore ?? relevanceCheck.score ?? 0;
    const preferredKeyword = (relevanceCheck.closestSeedKeyword || topic.preferredKeyword || '').trim();

    if (!relevanceCheck.isRelevant || relevanceScore < 70) {
      console.log(`Skipping irrelevant topic: "${topic.topic}" - ${relevanceCheck.reasoning} (score: ${relevanceScore})`);
      continue;
    }

    if (!preferredKeyword) {
      console.log(`Skipping weak-fit topic: "${topic.topic}" - no matching seed keyword selected`);
      continue;
    }

    console.log(`Topic is relevant (score: ${relevanceScore})`);

    // Then check for duplicates
    const duplicateCheck = await checkDuplicate(topic, existingArticles, existingDrafts);

    if (!duplicateCheck.isDuplicate) {
      validTopics.push({
        ...topic,
        preferredKeyword,
        suggestedAngle: relevanceCheck.suggestedAngle || topic.suggestedAngle || '',
        topicType: relevanceCheck.topicType || topic.topicType || 'narrow_practical',
        duplicateCheck,
        relevanceCheck: {
          ...relevanceCheck,
          relevanceScore,
        }
      });
    } else {
      console.log(`Skipping duplicate topic: "${topic.topic}" - ${duplicateCheck.reasoning}`);
    }
  }

  return validTopics;
}
