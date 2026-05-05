import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const DEFAULT_OPERATOR_HUB_RESEARCH_DIR = '/home/sajden/github/operator-hub/.local/research/search-demand';

function normalizeQuery(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function sourceScore(keyword = {}) {
  let score = 52;
  if (keyword.source === 'google_keyword_planner') score += 14;
  if (keyword.source === 'google_trends') score += 12;
  if (keyword.source === 'gsc') score += 10;
  if (keyword.demandBucket === 'high' || keyword.demand_bucket === 'high') score += 18;
  if (keyword.demandBucket === 'medium' || keyword.demand_bucket === 'medium') score += 10;
  if (keyword.demandBucket === 'rising' || keyword.demand_bucket === 'rising') score += 22;
  if (keyword.competition === 'low') score += 8;
  if (keyword.status === 'missing') score += 22;
  if (keyword.status === 'weak') score += 16;
  if (keyword.status === 'planned') score += 10;
  if (keyword.status === 'targeted') score += 6;
  if (keyword.status === 'covered') score -= 25;
  if (keyword.status === 'ignored') score -= 100;
  return Math.max(0, Math.min(100, score));
}

function keywordToTopic(keyword, source) {
  const query = normalizeQuery(keyword.query);
  if (!query || query.length < 3) return null;
  const status = keyword.status || 'planned';
  if (status === 'ignored') return null;

  const demand = keyword.demandBucket || keyword.demand_bucket || 'unknown';
  const competition = keyword.competition || 'unknown';
  const target = keyword.targetUrl ? ` Target page: ${keyword.targetUrl}.` : '';
  const notes = keyword.notes ? ` Notes: ${keyword.notes}.` : '';

  return {
    topic: query,
    score: sourceScore(keyword),
    source,
    relatedTo: query,
    preferredKeyword: query,
    suggestedAngle: `Skriv en praktisk svensk artikel som fångar sökintentionen bakom "${query}" och kopplar den till konkret affärsnytta, automation eller systemintegration.${target}${notes}`,
    reasoning: `Demand source ${source}: status=${status}, demand=${demand}, competition=${competition}.${target}${notes}`,
    topicType: status === 'missing' || status === 'weak' ? 'narrow_practical' : 'broad_strategic',
    demand: {
      status,
      demandBucket: demand,
      competition,
      intent: keyword.intent || 'unknown',
      source: keyword.source || source,
      targetUrl: keyword.targetUrl || ''
    }
  };
}

async function fetchKeywordPlan(projectSlug) {
  const url = (process.env.ARTICLE_GENERATOR_KEYWORD_PLAN_URL
    ?? process.env.SEO_HUB_KEYWORD_PLAN_URL
    ?? '').trim();
  if (!url) return [];

  try {
    const endpoint = new URL(url);
    if (!endpoint.searchParams.has('projectSlug')) {
      endpoint.searchParams.set('projectSlug', projectSlug);
    }
    const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload.keywords) ? payload.keywords : [];
  } catch (error) {
    console.warn(`Keyword Planner fetch failed: ${error.message}`);
    return [];
  }
}

function readKeywordPlanFile(projectSlug) {
  const candidates = [
    process.env.ARTICLE_GENERATOR_KEYWORD_PLAN_FILE,
    process.env.SEO_HUB_KEYWORD_PLAN_FILE,
    '/data/keyword-plan.json',
    '/home/sajden/github/seo-monitor/.local/keyword-plan.json'
  ].filter(Boolean);

  for (const filepath of candidates) {
    try {
      if (!existsSync(filepath)) continue;
      const payload = JSON.parse(readFileSync(filepath, 'utf-8'));
      return (payload.keywords || []).filter((keyword) => (keyword.projectSlug || projectSlug) === projectSlug);
    } catch (error) {
      console.warn(`Keyword Planner file read failed (${filepath}): ${error.message}`);
    }
  }

  return [];
}

function findNormalizedResearchFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) stack.push(fullPath);
      else if (entry === 'normalized-result.json') files.push({ filepath: fullPath, mtimeMs: stats.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map((item) => item.filepath);
}

function readOperatorHubDemandKeywords() {
  const rootDir = process.env.OPERATOR_HUB_RESEARCH_DIR || DEFAULT_OPERATOR_HUB_RESEARCH_DIR;
  const files = findNormalizedResearchFiles(rootDir).slice(0, 20);
  const keywords = [];

  for (const filepath of files) {
    try {
      const payload = JSON.parse(readFileSync(filepath, 'utf-8'));
      for (const keyword of payload.keywords || []) {
        keywords.push({
          ...keyword,
          source: keyword.source || 'operator_hub_research',
          notes: keyword.notes || payload.summary || ''
        });
      }
    } catch (error) {
      console.warn(`Operator Hub demand read failed (${filepath}): ${error.message}`);
    }
  }

  return keywords;
}

function dedupeTopics(topics) {
  const seen = new Set();
  return topics
    .filter(Boolean)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter((topic) => {
      const key = topic.topic.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function getDemandTopics(siteConfig) {
  const projectSlug = siteConfig.keywordProjectSlug || siteConfig.targetSite || 'sebcastwall';
  const keywordPlanKeywords = [
    ...(await fetchKeywordPlan(projectSlug)),
    ...readKeywordPlanFile(projectSlug)
  ];
  const operatorHubKeywords = readOperatorHubDemandKeywords();

  const topics = [
    ...keywordPlanKeywords.map((keyword) => keywordToTopic(keyword, 'keyword-planner')),
    ...operatorHubKeywords.map((keyword) => keywordToTopic(keyword, 'operator-hub-demand'))
  ];

  return dedupeTopics(topics).slice(0, 80);
}
