#!/usr/bin/env node

import { getSite, getAllSiteIds } from '../lib/config.mjs';
import { readExistingArticles, readExistingDrafts } from '../lib/articles.mjs';
import { getDemandTopics } from '../lib/demand-sources.mjs';
import { getTrendingTopics, checkPytrends } from './trends.mjs';
import { checkDuplicate, filterDuplicates } from './duplicate-check.mjs';
import { performGapAnalysis, selectBalancedTopics, selectTopTopics } from './gap-analysis.mjs';
import { generateDraft, saveDraft } from './draft-generator.mjs';
import { createRunLedger, readRuns } from '../lib/run-ledger.mjs';
import { assessTopicFreshness, suggestSupportQuestionSeeds } from '../lib/codex.mjs';

const DEFAULT_TARGET_DRAFT_COUNT = 2;
const DEFAULT_MAX_GENERATION_ATTEMPTS = 10;
const DEFAULT_GENERATION_MIX = { commercial: 1, support: 1 };

function normalizeTopicKey(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9åäö\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeTopics(topics = []) {
  const seen = new Set();
  const deduped = [];

  for (const topic of topics) {
    const key = normalizeTopicKey([
      topic.topic,
      topic.preferredKeyword,
      topic.suggestedAngle,
    ].filter(Boolean).join(' '));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(topic);
  }

  return deduped;
}

function getRecentRejectedGenerationMemory(siteId, limit = 20) {
  const topics = new Set();
  const reasons = new Map();

  for (const run of readRuns(siteId, limit)) {
    for (const decision of run.decisions ?? []) {
      if (decision.sourceStage !== 'generated-draft') continue;
      if (decision.decision !== 'duplicate' && decision.decision !== 'failed') continue;

      const key = normalizeTopicKey([
        decision.originalTopic,
        decision.topic,
        decision.preferredKeyword,
        decision.suggestedAngle,
      ].filter(Boolean).join(' '));
      if (!key) continue;
      topics.add(key);
      reasons.set(key, decision.reason || `${decision.decision} in previous generation run`);
    }
  }

  return { topics, reasons };
}

function getContentDate(content) {
  const value = content.generatedAt || content.publishedAt || content.date || content.updatedAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getRecentContent(existingArticles = [], existingDrafts = [], lookbackDays = 90) {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  return [...existingArticles, ...existingDrafts]
    .map((item) => ({ ...item, contentDate: getContentDate(item) }))
    .filter((item) => !item.contentDate || item.contentDate.getTime() >= cutoff)
    .sort((a, b) => (b.contentDate?.getTime() || 0) - (a.contentDate?.getTime() || 0));
}

async function buildCandidateQueue({
  uniqueDemandTopics,
  uniqueTrendingTopics,
  uniqueGapTopics,
  supportTopics,
  targetDraftCount,
  maxAttempts,
  mix,
  generationMemory,
  recentContent,
  topicFreshness,
  ledger,
}) {
  const commercialTarget = Math.max(0, mix.commercial ?? DEFAULT_GENERATION_MIX.commercial);
  const supportTarget = Math.max(0, mix.support ?? DEFAULT_GENERATION_MIX.support);
  const commercialAttemptBudget = Math.max(commercialTarget, maxAttempts - supportTarget);
  const supportAttemptBudget = Math.max(supportTarget, Math.min(supportTopics.length, maxAttempts - commercialAttemptBudget));

  const balanced = selectBalancedTopics(
    uniqueDemandTopics,
    [...uniqueTrendingTopics, ...uniqueGapTopics],
    commercialAttemptBudget,
  );
  const commercialRanked = [
    ...balanced,
    ...selectTopTopics(uniqueDemandTopics, commercialAttemptBudget),
    ...selectTopTopics(uniqueGapTopics, commercialAttemptBudget),
    ...selectTopTopics(uniqueTrendingTopics, commercialAttemptBudget),
  ];
  const supportRanked = selectTopTopics(supportTopics, Math.max(supportAttemptBudget, supportTarget));

  const ranked = [
    ...dedupeTopics(supportRanked).slice(0, supportTarget),
    ...dedupeTopics(commercialRanked).slice(0, commercialTarget),
    ...dedupeTopics(supportRanked).slice(supportTarget),
    ...dedupeTopics(commercialRanked).slice(commercialTarget),
  ];

  const queue = [];
  for (const topic of dedupeTopics(ranked)) {
    const key = normalizeTopicKey([
      topic.topic,
      topic.preferredKeyword,
      topic.suggestedAngle,
    ].filter(Boolean).join(' '));

    if (generationMemory.topics.has(key)) {
      const reason = generationMemory.reasons.get(key) || 'Topic previously generated a duplicate draft';
      console.log(`Skipping remembered duplicate generation topic: "${topic.topic}" - ${reason}`);
      ledger.recordDecision({
        sourceStage: 'generation-memory',
        decision: 'duplicate',
        topic: topic.topic,
        source: topic.source || '',
        score: topic.score ?? null,
        reason,
        preferredKeyword: topic.preferredKeyword || '',
        suggestedAngle: topic.suggestedAngle || '',
      });
      continue;
    }

    if (recentContent.length > 0) {
      try {
        const freshness = await assessTopicFreshness(topic, recentContent, topicFreshness);
        if (freshness.shouldPause) {
          const reason = `${freshness.reasoning} Cluster: ${freshness.clusterLabel || 'unknown'}, similar recent: ${freshness.similarRecentCount}, novelty: ${freshness.noveltyScore}.`;
          console.log(`Skipping recently saturated topic: "${topic.topic}" - ${reason}`);
          ledger.recordDecision({
            sourceStage: 'topic-freshness',
            decision: 'rejected',
            topic: topic.topic,
            source: topic.source || '',
            score: topic.score ?? null,
            reason,
            preferredKeyword: topic.preferredKeyword || '',
            suggestedAngle: topic.suggestedAngle || '',
            freshness,
          });
          continue;
        }
      } catch (err) {
        console.warn(`Topic freshness check failed for "${topic.topic}": ${err.message}`);
      }
    }

    queue.push(topic);
    if (queue.length >= Math.max(targetDraftCount, maxAttempts)) break;
  }

  return queue;
}

function hasSupportIntent(topic) {
  const query = normalizeTopicKey([
    topic.topic,
    topic.preferredKeyword,
    topic.suggestedAngle,
    topic.demand?.intent,
  ].filter(Boolean).join(' '));

  if (!query) return false;

  const patterns = [
    /\b(problem|problem med|fel|felsok|felsokning|fungerar inte|funkar inte|gar inte|kan inte|saknas|slutar|stoppad|blockerad|nekad|misslyckas)\b/,
    /\b(varfor|hur|vad gor|vad betyder|vilken|nar|kan man|sa gor du|guide|setup|installera|konfigurera|kom igang)\b/,
    /\b(synkar inte|syncar inte|startar inte|kors inte|skickas inte|logga in|behorighet|licens|policy|transkribering|inspelning)\b/,
  ];

  return patterns.some((pattern) => pattern.test(query));
}

function hasMeaningfulDemand(topic) {
  const bucket = String(topic.demand?.demandBucket || topic.demand?.demand_bucket || '').toLowerCase();
  const score = Number(topic.score ?? 0);
  const volume = String(topic.demand?.searchVolume || '').toLowerCase();

  if (['high', 'medium', 'rising', 'low'].includes(bucket)) return true;
  if (score >= 60) return true;
  if (/\b(10-100|100-1k|1k-10k|10k-100k)\b/.test(volume)) return true;
  return false;
}

function supportTopicFromDemand(topic) {
  return {
    ...topic,
    source: topic.source || 'search-demand',
    score: Math.min(100, (topic.score ?? 60) + 8),
    topicType: 'support_question',
    contentIntent: 'support_question',
    suggestedAngle: topic.suggestedAngle || `Svara på sökfrågan "${topic.topic}" som en praktisk felsökningsguide med tydliga kontroller, vanliga orsaker och nästa steg.`,
    reasoning: `${topic.reasoning || 'Search demand candidate.'} Classified as support/question intent from real demand data.`,
    demand: {
      ...(topic.demand || {}),
      intent: 'support_question',
      source: topic.demand?.source || topic.source || 'search-demand',
    },
  };
}

function getSupportQuestionTopicsFromDemand(demandTopics = [], gapTopics = []) {
  return dedupeTopics([...demandTopics, ...gapTopics])
    .filter(hasMeaningfulDemand)
    .filter(hasSupportIntent)
    .map(supportTopicFromDemand);
}

function cleanSuggestQuery(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[?!.:;()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulSupportSuggestion(value = '') {
  const query = cleanSuggestQuery(value);
  if (query.length < 8 || query.length > 110) return false;
  if (!hasSupportIntent({ topic: query })) return false;
  if (/\b(jobb|lön|utbildning|gratis nedladdning|torrent|reddit)\b/.test(query)) return false;
  return true;
}

function buildSuggestQueries(seedQuery = '') {
  const seed = cleanSuggestQuery(seedQuery);
  if (!seed) return [];

  return dedupeTopics([
    { topic: seed },
    { topic: `${seed} problem` },
    { topic: `${seed} fungerar inte` },
    { topic: `hur ${seed}` },
    { topic: `${seed} inställningar` },
    { topic: `${seed} behörighet` },
  ]).map((topic) => topic.topic).slice(0, 5);
}

async function fetchGoogleSuggestions(query) {
  const url = new URL('https://suggestqueries.google.com/complete/search');
  url.searchParams.set('client', 'firefox');
  url.searchParams.set('hl', 'sv');
  url.searchParams.set('gl', 'se');
  url.searchParams.set('q', query);

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json,text/plain,*/*',
      'User-Agent': 'Mozilla/5.0 article-generator/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Google Suggest returned ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.[1]) ? data[1].filter((item) => typeof item === 'string') : [];
}

function supportTopicFromSuggestion(suggestion, seed, suggestQuery) {
  const topic = cleanSuggestQuery(suggestion);
  return {
    topic,
    preferredKeyword: topic,
    source: 'google_suggest',
    score: 78,
    topicType: 'support_question',
    contentIntent: 'support_question',
    suggestedAngle: `Svara på Google-sökningen "${topic}" med en praktisk felsökningsguide: sannolika orsaker, steg-för-steg-kontroller, admininställningar och när man bör ta hjälp.`,
    reasoning: `Google Suggest returned this support/problem search for "${suggestQuery}". Seed reason: ${seed.reasoning || 'LLM suggested this root query from the capability map.'}`,
    demand: {
      intent: 'support_question',
      source: 'google_suggest',
      demandBucket: 'autocomplete',
      searchVolume: 'google_autocomplete',
      parentTopic: seed.parentTopic || '',
      seedQuery: seed.query || '',
      suggestQuery,
    },
  };
}

async function discoverSupportQuestionTopics(siteConfig, demandTopics = []) {
  let seeds = [];
  try {
    seeds = await suggestSupportQuestionSeeds(siteConfig, demandTopics);
  } catch (err) {
    console.warn(`Support question seed generation failed: ${err.message}`);
    return [];
  }

  const cleanSeeds = seeds
    .map((seed) => ({
      query: cleanSuggestQuery(seed.query || seed.topic || ''),
      reasoning: seed.reasoning || '',
      parentTopic: seed.parentTopic || seed.parent || '',
    }))
    .filter((seed) => seed.query)
    .slice(0, 10);

  const discovered = [];
  for (const seed of cleanSeeds) {
    for (const suggestQuery of buildSuggestQueries(seed.query)) {
      try {
        const suggestions = await fetchGoogleSuggestions(suggestQuery);
        for (const suggestion of suggestions) {
          if (!isUsefulSupportSuggestion(suggestion)) continue;
          discovered.push(supportTopicFromSuggestion(suggestion, seed, suggestQuery));
        }
      } catch (err) {
        console.warn(`Google Suggest failed for "${suggestQuery}": ${err.message}`);
      }
    }
  }

  return dedupeTopics(discovered).slice(0, 20);
}

function buildSiteContext(siteConfig) {
  return [
    siteConfig.niche,
    siteConfig.capabilitiesContext ? `SebCastwall capability map: ${siteConfig.capabilitiesContext}` : '',
  ].filter(Boolean).join('\n\n');
}

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
    const siteContext = buildSiteContext(siteConfig);

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
      siteContext,
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
      siteContext,
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
      siteContext,
      siteConfig.seedKeywords || [],
      { sourceStage: 'gap', onDecision: (decision) => ledger.recordDecision(decision) },
    );
    console.log(`${uniqueGapTopics.length} valid gap topics after filtering`);

    console.log(`
Discovering support/question topics from Google Suggest...`);
    const demandSupportTopics = getSupportQuestionTopicsFromDemand(demandTopics, uniqueGapTopics);
    const suggestedSupportTopics = await discoverSupportQuestionTopics(siteConfig, demandTopics);
    const rawSupportTopics = dedupeTopics([...demandSupportTopics, ...suggestedSupportTopics]);
    console.log(`${demandSupportTopics.length} demand-backed and ${suggestedSupportTopics.length} Google Suggest support/question topic(s) found`);

    console.log(`
Filtering support/question topics (relevance + duplicates)...`);
    const uniqueSupportTopics = await filterDuplicates(
      rawSupportTopics,
      existingArticles,
      existingDrafts,
      siteContext,
      siteConfig.seedKeywords || [],
      { sourceStage: 'support', onDecision: (decision) => ledger.recordDecision(decision) },
    );
    console.log(`${uniqueSupportTopics.length} valid support/question topics after filtering`);

    const targetDraftCount = siteConfig.generation?.targetDraftCount ?? siteConfig.targetDraftCount ?? DEFAULT_TARGET_DRAFT_COUNT;
    const maxGenerationAttempts = siteConfig.generation?.maxAttempts ?? siteConfig.maxGenerationAttempts ?? DEFAULT_MAX_GENERATION_ATTEMPTS;
    const generationMix = {
      ...DEFAULT_GENERATION_MIX,
      ...(siteConfig.generation?.mix ?? {}),
    };
    const generationMemory = getRecentRejectedGenerationMemory(siteConfig.id);
    const topicFreshness = {
      lookbackDays: 90,
      maxSimilarRecent: 2,
      minNoveltyScore: 70,
      ...(siteConfig.generation?.topicFreshness || {}),
    };
    const recentContent = getRecentContent(existingArticles, existingDrafts, topicFreshness.lookbackDays);
    const supportTopics = uniqueSupportTopics;
    console.log(`Loaded ${supportTopics.length} support/question topic(s) from demand data and Google Suggest`);
    console.log(`Loaded ${recentContent.length} recent article/draft(s) for topic freshness checks`);
    const selectedTopics = await buildCandidateQueue({
      uniqueDemandTopics,
      uniqueTrendingTopics,
      uniqueGapTopics,
      supportTopics,
      targetDraftCount,
      maxAttempts: maxGenerationAttempts,
      mix: generationMix,
      generationMemory,
      recentContent,
      topicFreshness,
      ledger,
    });

    if (selectedTopics.length === 0) {
      console.log('No topics selected. Exiting.');
      return [];
    }

    console.log(`
Selected ${selectedTopics.length} generation candidate(s), targeting ${targetDraftCount} saved draft(s):`);
    selectedTopics.forEach((topic, index) => {
      console.log(`  ${index + 1}. "${topic.topic}" (score: ${topic.score}, type: ${topic.topicType || 'unknown'})`);
    });

    const drafts = [];
    for (let index = 0; index < selectedTopics.length; index += 1) {
      if (drafts.length >= targetDraftCount) {
        console.log(`Reached target of ${targetDraftCount} saved draft(s).`);
        break;
      }

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
            originalTopic: topic.topic,
            source: topic.source || '',
            score: topic.score ?? null,
            reason: duplicateDraftCheck.reasoning || 'Generated draft duplicated existing content',
            preferredKeyword: topic.preferredKeyword || draft.preferredKeyword || '',
            suggestedAngle: topic.suggestedAngle || draft.suggestedAngle || '',
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
