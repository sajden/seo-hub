#!/usr/bin/env node

import { getSite, getAllSiteIds } from '../lib/config.mjs';
import { readExistingArticles, readExistingDrafts } from '../lib/articles.mjs';
import { getDemandTopics } from '../lib/demand-sources.mjs';
import { getTrendingTopics, checkPytrends } from './trends.mjs';
import { checkDuplicate, filterDuplicates } from './duplicate-check.mjs';
import { performGapAnalysis, selectBalancedTopics, selectTopTopics } from './gap-analysis.mjs';
import { generateDraft, saveDraft } from './draft-generator.mjs';
import { createRunLedger } from '../lib/run-ledger.mjs';

/**
 * Main generator workflow
 * @param {string} siteId - Site to generate for
 * @returns {Promise<Array<object>>}
 */
export async function generateForSite(siteId) {
  console.log(`
=== Generating article for site: ${siteId} ===
`);

  let ledger = null;
  try {
    const siteConfig = getSite(siteId);
    ledger = createRunLedger(siteId, {
      reason: 'generateForSite',
      targetSite: siteConfig.targetSite,
      niche: siteConfig.niche
    });
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
Fetching demand topics from Keyword Planner and Search Demand...`);
    const demandTopics = await getDemandTopics(siteConfig);
    console.log(`Found ${demandTopics.length} demand topics`);
    demandTopics.slice(0, 8).forEach((topic, index) => {
      console.log(`  ${index + 1}. ${topic.topic} (${topic.source}, score: ${topic.score})`);
    });

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
Filtering demand topics (relevance + duplicates)...`);
    const demandTopicsForFiltering = demandTopics.slice(0, 35);
    const uniqueDemandTopics = await filterDuplicates(
      demandTopicsForFiltering,
      existingArticles,
      existingDrafts,
      siteConfig.niche,
      [...(siteConfig.seedKeywords || []), ...demandTopicsForFiltering.map((topic) => topic.preferredKeyword || topic.topic)],
      { sourceStage: 'demand', onDecision: (decision) => ledger.recordDecision(decision) },
    );
    console.log(`${uniqueDemandTopics.length} valid demand topics after filtering`);

    console.log(`
Filtering trending topics (relevance + duplicates)...`);
    const uniqueTrendingTopics = await filterDuplicates(
      trendingTopics,
      existingArticles,
      existingDrafts,
      siteConfig.niche,
      siteConfig.seedKeywords || [],
      { sourceStage: 'trending', onDecision: (decision) => ledger.recordDecision(decision) },
    );
    console.log(`${uniqueTrendingTopics.length} valid trending topics after filtering`);

    console.log(`
Performing gap analysis...`);
    const gapTopics = await performGapAnalysis(existingArticles, existingDrafts, {
      ...siteConfig,
      demandTopics,
    });
    console.log(`${gapTopics.length} gap topics found`);

    console.log(`
Filtering gap topics (relevance + duplicates)...`);
    const uniqueGapTopics = await filterDuplicates(
      gapTopics,
      existingArticles,
      existingDrafts,
      siteConfig.niche,
      siteConfig.seedKeywords || [],
      { sourceStage: 'gap', onDecision: (decision) => ledger.recordDecision(decision) },
    );
    console.log(`${uniqueGapTopics.length} valid gap topics after filtering`);

    let selectedTopics = [];
    const balancedTopics = selectBalancedTopics(uniqueDemandTopics, [...uniqueTrendingTopics, ...uniqueGapTopics], 2);

    if (balancedTopics.length >= 2) {
      console.log(`
Selecting balanced topics from demand, trends and gaps`);
      selectedTopics = balancedTopics;
    } else if (uniqueDemandTopics.length >= 2) {
      console.log(`
Selecting 2 demand-backed topics`);
      selectedTopics = selectTopTopics(uniqueDemandTopics, 2);
    } else if (uniqueTrendingTopics.length >= 2) {
      console.log(`
Selecting 2 trending topics`);
      selectedTopics = selectTopTopics(uniqueTrendingTopics, 2);
    } else if (uniqueGapTopics.length >= 2) {
      console.log(`
Selecting 2 gap topics`);
      selectedTopics = selectTopTopics(uniqueGapTopics, 2);
    } else if (uniqueTrendingTopics.length === 1 && uniqueGapTopics.length === 1) {
      console.log(`
Using 1 trending + 1 gap topic`);
      selectedTopics = [uniqueTrendingTopics[0], uniqueGapTopics[0]];
    } else if (uniqueTrendingTopics.length === 1) {
      console.log(`
Using 1 trending topic`);
      selectedTopics = [uniqueTrendingTopics[0]];
    } else if (uniqueGapTopics.length === 1) {
      console.log(`
Using 1 gap topic`);
      selectedTopics = [uniqueGapTopics[0]];
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

        const duplicateDraftCheck = await checkDuplicate(
          { topic: `${draft.title}. ${draft.trendTopic}. ${draft.suggestedAngle}` },
          existingArticles,
          [...existingDrafts, ...drafts.map(({ draft: existingDraft }) => existingDraft)],
        );
        if (duplicateDraftCheck.isDuplicate) {
          console.log(`Skipping generated duplicate draft: "${draft.title}" - ${duplicateDraftCheck.reasoning}`);
          ledger.recordDecision({
            sourceStage: 'generated-draft',
            decision: 'duplicate',
            topic: draft.title,
            source: topic.source || '',
            score: topic.score ?? null,
            reason: duplicateDraftCheck.reasoning || 'Generated draft duplicated existing content',
            duplicateCheck: duplicateDraftCheck
          });
          continue;
        }

        const filepath = saveDraft(draft);
        drafts.push({ draft, filepath });
        ledger.recordGenerated(draft, filepath);

        console.log(`✓ Draft saved: ${draft.title}`);
      } catch (err) {
        console.error(`✗ Failed to generate draft for "${topic.topic}":`, err.message);
        ledger.recordFailure(topic, err);
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

    ledger.finish('ok');
    return drafts.map(({ draft }) => draft);
  } catch (err) {
    console.error(`
Error generating for site ${siteId}:`, err.message);
    ledger?.finish('error', err);
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
