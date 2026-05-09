import { semanticCompare, checkTopicRelevance } from '../lib/codex.mjs';

/**
 * Check if a topic is a duplicate of existing content
 * @param {Object} topic - Topic object with { topic, score }
 * @param {Array<Object>} existingArticles - Existing article metadata
 * @param {Array<Object>} existingDrafts - Existing draft objects
 * @returns {Promise<Object>} { isDuplicate, reasoning, similarity }
 */
export async function checkDuplicate(topic, existingArticles, existingDrafts) {
  const deterministicHit = findDeterministicDuplicate(topic, existingArticles, existingDrafts);
  if (deterministicHit) {
    return deterministicHit;
  }

  // Combine articles and drafts for comparison
  const allContent = [
    ...existingArticles.map(a => ({
      slug: a.slug,
      title: a.title,
      tags: a.tags,
      description: a.description,
      body: a.body,
    })),
    ...existingDrafts
      .map(d => ({
        title: d.title,
        tags: d.tags,
        status: d.status,
        trendTopic: d.trendTopic,
        preferredKeyword: d.preferredKeyword,
        suggestedAngle: d.suggestedAngle,
        body: typeof d.body === 'string' ? d.body.slice(0, 500) : '',
      }))
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

function normalizeKeyword(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9åäö\s-]+/gi, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findDeterministicDuplicate(topic, existingArticles, existingDrafts) {
  const topicText = normalizeKeyword([
    topic.topic,
    topic.preferredKeyword,
    topic.slug,
    topic.suggestedAngle
  ].filter(Boolean).join(' '));

  if (!topicText) return null;

  const topicTerms = new Set(topicText.split(' ').filter((term) => term.length > 2));
  const content = [
    ...existingArticles.map((item) => ({ ...item, sourceType: 'published article' })),
    ...existingDrafts.map((item) => ({ ...item, sourceType: 'draft' }))
  ];

  for (const item of content) {
    const haystack = normalizeKeyword([
      item.slug,
      item.filename,
      item.title,
      Array.isArray(item.tags) ? item.tags.join(' ') : '',
      item.description,
      item.trendTopic,
      item.preferredKeyword,
      item.suggestedAngle,
      item.body
    ].filter(Boolean).join(' '));

    if (!haystack) continue;

    const exactPhrase = topicText.length > 4 && haystack.includes(topicText);
    const slugPhrase = item.slug && topicText.includes(normalizeKeyword(item.slug));
    const overlap = [...topicTerms].filter((term) => haystack.split(' ').includes(term)).length;
    const similarity = Math.round((overlap / Math.max(1, topicTerms.size)) * 100);

    if (exactPhrase || slugPhrase || similarity >= 80) {
      return {
        isDuplicate: true,
        reasoning: `Deterministic duplicate match against existing ${item.sourceType}: "${item.title || item.slug}".`,
        similarity: Math.max(similarity, exactPhrase || slugPhrase ? 95 : similarity)
      };
    }
  }

  return null;
}

/**
 * Filter topics to remove duplicates and irrelevant topics
 * @param {Array<Object>} topics - Array of topic objects
 * @param {Array<Object>} existingArticles - Existing article metadata
 * @param {Array<Object>} existingDrafts - Existing draft objects
 * @param {string} niche - Site niche for relevance checking
 * @returns {Promise<Array<Object>>} Filtered topics (non-duplicates + relevant)
 */
export async function filterDuplicates(topics, existingArticles, existingDrafts, niche, seedKeywords = [], options = {}) {
  const validTopics = [];
  const sourceStage = options.sourceStage || 'unknown';
  const onDecision = typeof options.onDecision === 'function' ? options.onDecision : null;

  for (const topic of topics) {
    // First check relevance
    console.log(`\nChecking relevance for "${topic.topic}"...`);
    const relevanceCheck = await checkTopicRelevance(topic.topic, niche, seedKeywords);
    const relevanceScore = relevanceCheck.relevanceScore ?? relevanceCheck.score ?? 0;
    const preferredKeyword = (relevanceCheck.closestSeedKeyword || topic.preferredKeyword || '').trim();

    if (!relevanceCheck.isRelevant || relevanceScore < 70) {
      console.log(`Skipping irrelevant topic: "${topic.topic}" - ${relevanceCheck.reasoning} (score: ${relevanceScore})`);
      onDecision?.({
        sourceStage,
        decision: 'rejected',
        topic: topic.topic,
        source: topic.source || '',
        score: topic.score ?? null,
        reason: relevanceCheck.reasoning || 'Not relevant enough',
        relevanceScore,
        relevanceCheck
      });
      continue;
    }

    if (!preferredKeyword) {
      console.log(`Skipping weak-fit topic: "${topic.topic}" - no matching seed keyword selected`);
      onDecision?.({
        sourceStage,
        decision: 'rejected',
        topic: topic.topic,
        source: topic.source || '',
        score: topic.score ?? null,
        reason: 'No matching seed keyword selected',
        relevanceScore,
        relevanceCheck
      });
      continue;
    }

    console.log(`Topic is relevant (score: ${relevanceScore})`);

    // Then check for duplicates
    const duplicateCheck = await checkDuplicate(topic, existingArticles, existingDrafts);

    if (!duplicateCheck.isDuplicate) {
      const validTopic = {
        ...topic,
        preferredKeyword,
        suggestedAngle: relevanceCheck.suggestedAngle || topic.suggestedAngle || '',
        topicType: relevanceCheck.topicType || topic.topicType || 'narrow_practical',
        duplicateCheck,
        relevanceCheck: {
          ...relevanceCheck,
          relevanceScore,
        }
      };
      validTopics.push(validTopic);
      onDecision?.({
        sourceStage,
        decision: 'selected',
        topic: topic.topic,
        source: topic.source || '',
        score: topic.score ?? null,
        reason: relevanceCheck.reasoning || 'Relevant and unique',
        relevanceScore,
        preferredKeyword,
        suggestedAngle: validTopic.suggestedAngle,
        topicType: validTopic.topicType,
        relevanceCheck,
        duplicateCheck
      });
    } else {
      console.log(`Skipping duplicate topic: "${topic.topic}" - ${duplicateCheck.reasoning}`);
      onDecision?.({
        sourceStage,
        decision: 'duplicate',
        topic: topic.topic,
        source: topic.source || '',
        score: topic.score ?? null,
        reason: duplicateCheck.reasoning || 'Duplicate topic',
        relevanceScore,
        preferredKeyword,
        relevanceCheck,
        duplicateCheck
      });
    }
  }

  return validTopics;
}
