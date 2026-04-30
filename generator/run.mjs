#!/usr/bin/env node

import { getSite, getAllSiteIds } from '../lib/config.mjs';
import { readExistingArticles, readExistingDrafts } from '../lib/articles.mjs';
import { getTrendingTopics, checkPytrends } from './trends.mjs';
import { filterDuplicates } from './duplicate-check.mjs';
import { performGapAnalysis, selectBalancedTopics, selectTopTopics } from './gap-analysis.mjs';
import { generateDraft, saveDraft } from './draft-generator.mjs';

/**
 * Main generator workflow
 * @param {string} siteId - Site to generate for
 * @returns {Promise<Array<object>>}
 */
export async function generateForSite(siteId) {
  console.log(`
=== Generating article for site: ${siteId} ===
`);

  try {
    const siteConfig = getSite(siteId);
    console.log(`Site: ${siteConfig.id} - ${siteConfig.niche}`);

    console.log(`
Reading existing articles...`);
    const existingArticles = readExistingArticles(
      siteConfig.targetRepo,
      siteConfig.contentPath,
    );
    console.log(`Found ${existingArticles.length} existing articles`);

    console.log(`
Reading existing drafts...`);
    const existingDrafts = readExistingDrafts(siteConfig.id);
    console.log(`Found ${existingDrafts.length} existing drafts`);

    console.log(`
Fetching trending topics...`);
    const trendingTopics = await getTrendingTopics(
      siteConfig.seedKeywords,
      siteConfig.region || 'SE',
    );

    if (trendingTopics.length === 0) {
      console.log('No trending topics found.');
    } else {
      console.log(`Found ${trendingTopics.length} trending topics:`);
      trendingTopics.slice(0, 5).forEach((topic, index) => {
        console.log(`  ${index + 1}. ${topic.topic} (score: ${topic.score})`);
      });
    }

    console.log(`
Filtering trending topics (relevance + duplicates)...`);
    const uniqueTrendingTopics = await filterDuplicates(
      trendingTopics,
      existingArticles,
      existingDrafts,
      siteConfig.niche,
      siteConfig.seedKeywords || [],
    );
    console.log(`${uniqueTrendingTopics.length} valid trending topics after filtering`);

    console.log(`
Performing gap analysis...`);
    const gapTopics = await performGapAnalysis(existingArticles, siteConfig);
    console.log(`${gapTopics.length} gap topics found`);

    let selectedTopics = [];
    const balancedTopics = selectBalancedTopics(uniqueTrendingTopics, gapTopics, 2);

    if (balancedTopics.length >= 2) {
      console.log(`
Selecting 1 broad strategic + 1 narrow practical topic when possible`);
      selectedTopics = balancedTopics;
    } else if (uniqueTrendingTopics.length >= 2) {
      console.log(`
Selecting 2 trending topics`);
      selectedTopics = selectTopTopics(uniqueTrendingTopics, 2);
    } else if (gapTopics.length >= 2) {
      console.log(`
Selecting 2 gap topics`);
      selectedTopics = selectTopTopics(gapTopics, 2);
    } else if (uniqueTrendingTopics.length === 1 && gapTopics.length === 1) {
      console.log(`
Using 1 trending + 1 gap topic`);
      selectedTopics = [uniqueTrendingTopics[0], gapTopics[0]];
    } else if (uniqueTrendingTopics.length === 1) {
      console.log(`
Using 1 trending topic`);
      selectedTopics = [uniqueTrendingTopics[0]];
    } else if (gapTopics.length === 1) {
      console.log(`
Using 1 gap topic`);
      selectedTopics = [gapTopics[0]];
    }

    if (selectedTopics.length === 0) {
      console.log('No topics selected. Exiting.');
      return [];
    }

    console.log(`
Selected ${selectedTopics.length} topics for generation:`);
    selectedTopics.forEach((topic, index) => {
      console.log(`  ${index + 1}. "${topic.topic}" (score: ${topic.score}, type: ${topic.topicType || 'unknown'})`);
    });

    const drafts = [];
    for (let index = 0; index < selectedTopics.length; index += 1) {
      const topic = selectedTopics[index];
      console.log(`
[${index + 1}/${selectedTopics.length}] Generating draft for "${topic.topic}"...`);

      try {
        const draft = await generateDraft(
          topic,
          siteConfig,
          topic.reasoning || `Trending topic with score ${topic.score}`,
        );

        const filepath = saveDraft(draft);
        drafts.push({ draft, filepath });

        console.log(`✓ Draft saved: ${draft.title}`);
      } catch (err) {
        console.error(`✗ Failed to generate draft for "${topic.topic}":`, err.message);
      }
    }

    console.log(`
=== Generation complete! ===`);
    console.log(`Generated ${drafts.length} draft(s):
`);

    drafts.forEach(({ draft, filepath }, index) => {
      console.log(`${index + 1}. ${draft.title}`);
      console.log(`   Slug: ${draft.slug}`);
      console.log(`   File: ${filepath}`);
      console.log(`   Review: http://localhost:3001/draft/${draft.siteId}/${draft.slug}
`);
    });

    return drafts.map(({ draft }) => draft);
  } catch (err) {
    console.error(`
Error generating for site ${siteId}:`, err.message);
    throw err;
  }
}

export async function generateSites(siteIds) {
  const allDrafts = [];
  for (const siteId of siteIds) {
    const drafts = await generateForSite(siteId);
    allDrafts.push(...drafts);
  }
  return allDrafts;
}

export async function runCli(argv = process.argv.slice(2)) {
  const hasPytrends = await checkPytrends();
  if (!hasPytrends) {
    console.error(`
Please install pytrends: npm run setup`);
    process.exit(1);
  }

  let sitesToGenerate = [];

  if (argv.includes('--all')) {
    sitesToGenerate = getAllSiteIds();
  } else {
    const siteIndex = argv.indexOf('--site');
    if (siteIndex !== -1 && argv[siteIndex + 1]) {
      sitesToGenerate = [argv[siteIndex + 1]];
    } else {
      console.error('Usage: node generator/run.mjs --site <siteId>');
      console.error('   or: node generator/run.mjs --all');
      process.exit(1);
    }
  }

  console.log('SEO-Hub Generator');
  console.log(`=================\n`);

  await generateSites(sitesToGenerate);

  console.log(`
=== All done! ===
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
