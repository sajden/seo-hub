#!/usr/bin/env node

import { loadConfig, getSite, getAllSiteIds } from '../lib/config.mjs';
import { readExistingArticles, readExistingDrafts } from '../lib/articles.mjs';
import { getTrendingTopics, checkPytrends } from './trends.mjs';
import { filterDuplicates } from './duplicate-check.mjs';
import { performGapAnalysis, selectBestTopic, selectTopTopics } from './gap-analysis.mjs';
import { generateDraft, saveDraft } from './draft-generator.mjs';

/**
 * Main generator workflow
 * @param {string} siteId - Site to generate for
 */
async function generateForSite(siteId) {
  console.log(`\n=== Generating article for site: ${siteId} ===\n`);

  try {
    // 1. Load site config
    const siteConfig = getSite(siteId);
    console.log(`Site: ${siteConfig.id} - ${siteConfig.niche}`);

    // 2. Read existing articles
    console.log('\nReading existing articles...');
    const existingArticles = readExistingArticles(
      siteConfig.targetRepo,
      siteConfig.contentPath
    );
    console.log(`Found ${existingArticles.length} existing articles`);

    // 3. Read existing drafts
    console.log('\nReading existing drafts...');
    const existingDrafts = readExistingDrafts(siteConfig.id);
    console.log(`Found ${existingDrafts.length} existing drafts`);

    // 4. Get trending topics
    console.log('\nFetching trending topics...');
    const trendingTopics = await getTrendingTopics(
      siteConfig.seedKeywords,
      siteConfig.region || 'SE'
    );

    if (trendingTopics.length === 0) {
      console.log('No trending topics found.');
    } else {
      console.log(`Found ${trendingTopics.length} trending topics:`);
      trendingTopics.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.topic} (score: ${t.score})`);
      });
    }

    // 5. Filter trending topics (duplicates + relevance)
    console.log('\nFiltering trending topics (relevance + duplicates)...');
    let uniqueTrendingTopics = await filterDuplicates(
      trendingTopics,
      existingArticles,
      existingDrafts,
      siteConfig.niche
    );
    console.log(`${uniqueTrendingTopics.length} valid trending topics after filtering`);

    // 6. Always perform gap analysis for diversity
    console.log('\nPerforming gap analysis...');
    const gapTopics = await performGapAnalysis(existingArticles, siteConfig);
    console.log(`${gapTopics.length} gap topics found`);

    // 7. Mix trending + gap for diversity (1 trending + 1 gap if possible)
    let selectedTopics = [];

    if (uniqueTrendingTopics.length > 0 && gapTopics.length > 0) {
      // Mix: 1 trending + 1 gap
      console.log('\nMixing 1 trending + 1 gap topic for diversity');
      selectedTopics.push(uniqueTrendingTopics[0]); // Top trending
      selectedTopics.push(gapTopics[0]); // Top gap
    } else if (uniqueTrendingTopics.length >= 2) {
      // Only trending available
      console.log('\nSelecting 2 trending topics');
      selectedTopics = selectTopTopics(uniqueTrendingTopics, 2);
    } else if (gapTopics.length >= 2) {
      // Only gap available
      console.log('\nSelecting 2 gap topics');
      selectedTopics = selectTopTopics(gapTopics, 2);
    } else if (uniqueTrendingTopics.length === 1 && gapTopics.length === 1) {
      // 1 of each
      console.log('\nUsing 1 trending + 1 gap topic');
      selectedTopics = [uniqueTrendingTopics[0], gapTopics[0]];
    } else if (uniqueTrendingTopics.length === 1) {
      // Only 1 trending
      console.log('\nUsing 1 trending topic');
      selectedTopics = [uniqueTrendingTopics[0]];
    } else if (gapTopics.length === 1) {
      // Only 1 gap
      console.log('\nUsing 1 gap topic');
      selectedTopics = [gapTopics[0]];
    }
    if (selectedTopics.length === 0) {
      console.log('No topics selected. Exiting.');
      return;
    }

    console.log(`\nSelected ${selectedTopics.length} topics for generation:`);
    selectedTopics.forEach((t, i) => {
      console.log(`  ${i + 1}. "${t.topic}" (score: ${t.score})`);
    });

    // 8. Generate drafts for each selected topic
    const drafts = [];
    for (let i = 0; i < selectedTopics.length; i++) {
      const topic = selectedTopics[i];
      console.log(`\n[${i + 1}/${selectedTopics.length}] Generating draft for "${topic.topic}"...`);

      try {
        const draft = await generateDraft(
          topic,
          siteConfig,
          topic.reasoning || `Trending topic with score ${topic.score}`
        );

        // 9. Save draft
        const filepath = saveDraft(draft);
        drafts.push({ draft, filepath });

        console.log(`✓ Draft saved: ${draft.title}`);
      } catch (err) {
        console.error(`✗ Failed to generate draft for "${topic.topic}":`, err.message);
        // Continue with next topic even if this one fails
      }
    }

    // Summary
    console.log('\n=== Generation complete! ===');
    console.log(`Generated ${drafts.length} draft(s):\n`);

    drafts.forEach(({ draft, filepath }, i) => {
      console.log(`${i + 1}. ${draft.title}`);
      console.log(`   Slug: ${draft.slug}`);
      console.log(`   File: ${filepath}`);
      console.log(`   Review: http://localhost:3001/draft/${draft.siteId}/${draft.slug}\n`);
    });

  } catch (err) {
    console.error(`\nError generating for site ${siteId}:`, err.message);
    throw err;
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Check pytrends
  const hasPytrends = await checkPytrends();
  if (!hasPytrends) {
    console.error('\nPlease install pytrends: npm run setup');
    process.exit(1);
  }

  // Parse arguments
  let sitesToGenerate = [];

  if (args.includes('--all')) {
    sitesToGenerate = getAllSiteIds();
  } else {
    const siteIndex = args.indexOf('--site');
    if (siteIndex !== -1 && args[siteIndex + 1]) {
      sitesToGenerate = [args[siteIndex + 1]];
    } else {
      console.error('Usage: node generator/run.mjs --site <siteId>');
      console.error('   or: node generator/run.mjs --all');
      process.exit(1);
    }
  }

  console.log('SEO-Hub Generator');
  console.log('=================\n');

  // Generate for each site
  for (const siteId of sitesToGenerate) {
    await generateForSite(siteId);
  }

  console.log('\n=== All done! ===\n');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
