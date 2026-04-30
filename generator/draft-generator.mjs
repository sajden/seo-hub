import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { generateArticle } from '../lib/codex.mjs';

function normalizeArticleBody(body = '') {
  let normalized = body.replace(/^#\s+.+\n+/, '');

  normalized = normalized.replace(
    '[relevant tjänstesida]',
    '[AI-automatisering](/tjanster/ai-automatisering)',
  );
  normalized = normalized.replace(
    '[relevant tjänstesida]',
    '[Systemintegrationer](/tjanster/integrationer)',
  );
  normalized = normalized.replace(/\[kontakt\]/g, '[Kontakt](/kontakt)');

  return normalized.trim();
}

/**
 * Generate a draft article
 * @param {Object} topic - Topic object with { topic, score }
 * @param {Object} siteConfig - Site configuration
 * @param {string} reasoning - Why this topic was chosen
 * @returns {Promise<Object>} Generated draft object
 */
export async function generateDraft(topic, siteConfig, reasoning = '') {
  console.log(`Generating draft for topic: "${topic.topic}"...`);

  // Generate article using Codex
  const article = await generateArticle({
    topic: topic.topic,
    niche: siteConfig.niche,
    language: siteConfig.targetLanguage || 'sv',
    seedKeywords: siteConfig.seedKeywords || [],
    preferredKeyword: topic.preferredKeyword || '',
    suggestedAngle: topic.suggestedAngle || topic.reasoning || '',
    length: siteConfig.articleLength || { min: 800, max: 1500 }
  });

  // Create draft object
  const draft = {
    siteId: siteConfig.id,
    slug: article.slug,
    title: article.title,
    metaDescription: article.metaDescription,
    body: normalizeArticleBody(article.body),
    tags: article.tags || [],
    trendScore: topic.score || 0,
    trendTopic: topic.topic,
    preferredKeyword: topic.preferredKeyword || '',
    suggestedAngle: topic.suggestedAngle || '',
    reasoning: reasoning || `Topic trending with score ${topic.score}`,
    generatedAt: new Date().toISOString(),
    status: 'pending'
  };

  console.log(`Draft generated: "${draft.title}" (${draft.slug})`);

  return draft;
}

/**
 * Save draft to file
 * @param {Object} draft - Draft object
 * @returns {string} Path to saved draft file
 */
export function saveDraft(draft) {
  const draftsDir = resolve('.local', 'drafts', draft.siteId);

  // Ensure directory exists
  if (!existsSync(draftsDir)) {
    mkdirSync(draftsDir, { recursive: true });
  }

  const filename = `${draft.slug}.json`;
  const filepath = join(draftsDir, filename);

  writeFileSync(filepath, JSON.stringify(draft, null, 2), 'utf-8');

  console.log(`Draft saved: ${filepath}`);

  return filepath;
}

/**
 * Create slug from title
 * @param {string} title - Article title
 * @returns {string} URL-friendly slug
 */
export function createSlug(title) {
  return title
    .toLowerCase()
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
