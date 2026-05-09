import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);
const CODEX_GATEWAY_URL = (process.env.SEO_HUB_CODEX_URL ?? process.env.CODEX_GATEWAY_URL ?? '').trim();
const CODEX_GATEWAY_TOKEN = (process.env.SEO_HUB_CODEX_TOKEN ?? process.env.CODEX_GATEWAY_TOKEN ?? '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY ?? '').trim();
const OPENAI_MODEL = (process.env.ARTICLE_GENERATOR_LLM_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.4-mini').trim();
const DEFAULT_WORKSPACE_PATH = process.env.SEO_HUB_CODEX_WORKSPACE_PATH ?? '/home/sajden/github/sebcastwall';

async function callCodexGateway(prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (CODEX_GATEWAY_TOKEN) headers.Authorization = `Bearer ${CODEX_GATEWAY_TOKEN}`;

  const response = await fetch(CODEX_GATEWAY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      projectId: 'article-generator',
      projectSlug: 'article-generator',
      workspacePath: DEFAULT_WORKSPACE_PATH,
      systemPrompt: 'You are a precise SEO content assistant. Return only the requested final answer.',
      task: prompt,
      context: { source: 'article-generator' },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex gateway returned ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    const data = JSON.parse(text);
    return data.text ?? text;
  } catch {
    return text;
  }
}

function extractResponseText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  return parts.join('\n').trim();
}

async function callOpenAi(prompt) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: 'You are a precise SEO content assistant. Return only the requested final answer.',
      input: prompt,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status}: ${text.slice(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI returned non-JSON response: ${text.slice(0, 500)}`);
  }

  const output = extractResponseText(data);
  if (!output) {
    throw new Error(`OpenAI returned no text output: ${text.slice(0, 500)}`);
  }

  return output;
}

export async function callCodex(prompt, options = {}) {
  const { json = false } = options;
  let output = '';

  if (OPENAI_API_KEY) {
    output = await callOpenAi(prompt);
  } else if (CODEX_GATEWAY_URL) {
    output = await callCodexGateway(prompt);
  } else {
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-'));
    const outputFile = join(tempDir, 'output.txt');

    try {
      const command = `echo ${JSON.stringify(prompt)} | codex exec --ephemeral --output-last-message "${outputFile}" -`;
      const { stderr } = await execAsync(command, {
        maxBuffer: 1024 * 1024 * 10,
        shell: '/bin/bash',
      });

      if (stderr && !stderr.includes('Session completed')) {
        console.warn('Codex stderr:', stderr);
      }

      output = readFileSync(outputFile, 'utf-8').trim();
    } catch (err) {
      throw new Error(`Codex execution failed: ${err.message}`);
    } finally {
      try {
        unlinkSync(outputFile);
      } catch {}
    }
  }

  if (json) {
    try {
      const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) return JSON.parse(jsonMatch[1]);
      return JSON.parse(output);
    } catch (err) {
      throw new Error(`Failed to parse Codex JSON response: ${err.message}\nOutput: ${output}`);
    }
  }

  return output;
}

export async function semanticCompare(topic, existingArticles) {
  const articleSummaries = existingArticles
    .map((article) => {
      const status = article.status ? `, status: ${article.status}` : '';
      const topicHint = article.trendTopic ? `, topic: ${article.trendTopic}` : '';
      const keywordHint = article.preferredKeyword ? `, keyword: ${article.preferredKeyword}` : '';
      const angleHint = article.suggestedAngle ? `, angle: ${article.suggestedAngle}` : '';
      const descriptionHint = article.description ? `, description: ${article.description}` : '';
      const bodyHint = article.body ? `\n  excerpt: ${String(article.body).replace(/\s+/g, ' ').slice(0, 650)}` : '';
      return `- ${article.title} (tags: ${article.tags?.join(', ') || 'none'}${status}${topicHint}${keywordHint}${angleHint}${descriptionHint})${bodyHint}`;
    })
    .join('\n');

  const prompt = `You are analyzing if a new topic is a duplicate of existing articles.\n\nTopic to check: "${topic}"\n\nExisting articles:\n${articleSummaries}\n\nAnswer in JSON format:\n{\n  "isDuplicate": true/false,\n  "reasoning": "brief explanation",\n  "similarity": 0-100\n}\n\nConsider it a duplicate if:\n- The topic covers the same core subject/intent\n- The content would overlap >70%\n- It's essentially the same story or angle\n\nReturn isDuplicate=false if:\n- It's a different angle on a similar topic\n- It covers a new development/update\n- The focus is substantially different`;

  try {
    const result = await callCodex(prompt, { json: true });
    return {
      isDuplicate: result.isDuplicate || false,
      reasoning: result.reasoning || 'No reasoning provided',
      similarity: result.similarity || 0,
    };
  } catch (err) {
    console.error('Semantic compare failed:', err.message);
    return deterministicSemanticCompare(topic, existingArticles, err.message);
  }
}

function normalizeTerms(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 3)
    .filter((term) => ![
      'företag', 'svenska', 'artikel', 'guide', 'eller', 'från', 'till',
      'med', 'utan', 'som', 'och', 'för', 'hur', 'varför', 'detta'
    ].includes(term));
}

function deterministicSemanticCompare(topic, existingArticles, errorMessage = '') {
  const topicTerms = new Set(normalizeTerms(topic));
  if (topicTerms.size === 0) {
    return {
      isDuplicate: false,
      reasoning: `LLM comparison failed and deterministic fallback found no terms: ${errorMessage}`,
      similarity: 0,
    };
  }

  let best = { title: '', similarity: 0 };
  for (const article of existingArticles) {
    const articleText = [
      article.title,
      Array.isArray(article.tags) ? article.tags.join(' ') : '',
      article.description,
      article.trendTopic,
      article.preferredKeyword,
      article.suggestedAngle,
      article.body
    ].filter(Boolean).join(' ');
    const articleTerms = new Set(normalizeTerms(articleText));
    const overlap = [...topicTerms].filter((term) => articleTerms.has(term)).length;
    const similarity = Math.round((overlap / Math.max(1, Math.min(topicTerms.size, articleTerms.size))) * 100);
    if (similarity > best.similarity) best = { title: article.title || 'existing content', similarity };
  }

  return {
    isDuplicate: best.similarity >= 55,
    reasoning: `LLM comparison failed; deterministic fallback similarity ${best.similarity}% against "${best.title}". Error: ${errorMessage}`,
    similarity: best.similarity,
  };
}

export async function checkTopicRelevance(topic, niche, seedKeywords = []) {
  const prompt = `You are analyzing if a topic is relevant for a business-focused Swedish website.\n\nTopic: "${topic}"\nSite context and capability map:\n${niche}\n\nSeed keywords: ${seedKeywords.join(', ') || 'none'}\n\nDecide if the topic should be written as an SEO/help article for this site. Prefer practical SMB topics where SebCastwall can credibly help with diagnosis, Microsoft 365/Teams, email, automation, AI assistants, integrations, dashboards, booking/intake, local content, social/content workflows, websites when truly needed, or hands-on IT setup.\n\nDo not force every topic into AI or a new website. Choose the most credible first-help angle from the capability map.\n\nClassify the topic as one of:\n- "broad_strategic": a broader keyword/theme that is still valuable for positioning and demand capture\n- "narrow_practical": a more concrete use case, workflow, integration or operational problem\n- "support_question": a concrete problem/search question that should be answered as a troubleshooting or FAQ guide\n\nReturn JSON:\n{\n  "isRelevant": true/false,\n  "reasoning": "brief explanation",\n  "relevanceScore": 0-100,\n  "closestSeedKeyword": "best matching keyword or empty string",\n  "suggestedAngle": "best article angle in Swedish",\n  "topicType": "broad_strategic or narrow_practical or support_question"\n}`;

  return await callCodex(prompt, { json: true });
}

export async function assessTopicFreshness(topic, recentContent = [], options = {}) {
  const maxSimilarRecent = options.maxSimilarRecent ?? 2;
  const minNoveltyScore = options.minNoveltyScore ?? 70;
  const contentSummary = recentContent
    .slice(0, 30)
    .map((item) => {
      const parts = [
        item.title,
        item.date ? `date: ${item.date}` : null,
        item.status ? `status: ${item.status}` : null,
        item.trendTopic ? `topic: ${item.trendTopic}` : null,
        item.preferredKeyword ? `keyword: ${item.preferredKeyword}` : null,
        item.suggestedAngle ? `angle: ${item.suggestedAngle}` : null,
        Array.isArray(item.tags) && item.tags.length ? `tags: ${item.tags.join(', ')}` : null,
        item.description ? `description: ${item.description}` : null,
      ].filter(Boolean);
      return `- ${parts.join(' | ')}`;
    })
    .join('\n');

  const prompt = `You are protecting a Swedish B2B article pipeline from publishing the same subject cluster too often.\n\nCandidate topic:\nTitle/topic: "${topic.topic}"\nPreferred keyword: "${topic.preferredKeyword || ''}"\nSuggested angle: "${topic.suggestedAngle || ''}"\nContent intent: "${topic.contentIntent || topic.topicType || ''}"\nDemand: source=${topic.source || topic.demand?.source || 'unknown'}, volume=${topic.demand?.searchVolume || 'unknown'}, demand=${topic.demand?.demandBucket || 'unknown'}\n\nRecent published articles and drafts:\n${contentSummary || '- none'}\n\nDecide if this candidate should be paused for now because the same subject cluster has already been covered recently.\n\nRules:\n- This is not an exact duplicate check. It is a frequency/novelty check.\n- Pause broad strategic topics when recent content already covers the same reader intent, systems, business problem, and service angle.\n- Allow concrete support/problem articles when the search question is specific, even if the same system appears in recent content.\n- Allow a topic if it has a clearly new intent, new system/problem, or substantially different reader job.\n- Use maxSimilarRecent=${maxSimilarRecent} and minNoveltyScore=${minNoveltyScore} as the decision bar.\n\nReturn JSON only:\n{\n  "shouldPause": true/false,\n  "reasoning": "short Swedish explanation",\n  "similarRecentCount": 0-10,\n  "noveltyScore": 0-100,\n  "clusterLabel": "short Swedish subject cluster label",\n  "closestRecentTitles": ["title 1", "title 2"]\n}`;

  const result = await callCodex(prompt, { json: true });
  const noveltyScore = Number(result.noveltyScore ?? 100);
  const similarRecentCount = Number(result.similarRecentCount ?? 0);
  const shouldPause = Boolean(result.shouldPause)
    || (similarRecentCount >= maxSimilarRecent && noveltyScore < minNoveltyScore);

  return {
    shouldPause,
    reasoning: result.reasoning || 'Topic cluster appears too recently covered.',
    similarRecentCount,
    noveltyScore,
    clusterLabel: result.clusterLabel || '',
    closestRecentTitles: Array.isArray(result.closestRecentTitles) ? result.closestRecentTitles : [],
  };
}

export async function suggestSupportQuestionSeeds(siteConfig, demandTopics = []) {
  const demandSummary = demandTopics
    .slice(0, 25)
    .map((topic) => `- ${topic.topic} (${topic.source}, score: ${topic.score}, demand: ${topic.demand?.demandBucket || 'unknown'}, volume: ${topic.demand?.searchVolume || 'unknown'})`)
    .join('\n');

  const prompt = `You are planning Swedish Google autocomplete checks for practical SMB help articles.\n\nSite context and capability map:\n${siteConfig.niche}\n${siteConfig.capabilitiesContext ? `\n${siteConfig.capabilitiesContext}` : ''}\n\nDemand-backed parent topics:\n${demandSummary || '- none'}\n\nReturn 8-12 short Swedish root queries that are likely to produce real Google autocomplete questions/problems. These are NOT article titles. They should be search phrases a business user or admin might type before adding words like "fungerar inte", "problem", "hur", "varför", "inställningar", "behörighet" or "guide".\n\nPrefer concrete systems and workflows from the capability map and demand topics, for example Microsoft 365, Teams, Outlook, SharePoint, OneDrive, Power Automate, Fortnox, CRM, booking, forms, email, integrations, dashboards, AI assistants.\n\nAvoid generic head terms like "ai företag" unless made concrete.\n\nReturn JSON only:\n[\n  {\n    "query": "short Swedish root query",\n    "reasoning": "why this is likely to reveal support/problem searches",\n    "parentTopic": "closest demand-backed parent topic or capability"\n  }\n]`;

  const result = await callCodex(prompt, { json: true });
  return Array.isArray(result) ? result : [];
}

export async function findContentGaps(existingArticles, existingDrafts = [], siteConfig) {
  const articleSummaries = existingArticles
    .map((article) => {
      const parts = [
        article.title,
        article.description ? `description: ${article.description}` : null,
        Array.isArray(article.tags) && article.tags.length ? `tags: ${article.tags.join(', ')}` : null,
      ].filter(Boolean);
      const bodyHint = article.body ? `\n  excerpt: ${String(article.body).replace(/\s+/g, ' ').slice(0, 650)}` : '';
      return `- ${parts.join(' | ')}${bodyHint}`;
    })
    .join('\n');
  const draftSummaries = existingDrafts
    .map((draft) => {
      const parts = [
        draft.title,
        draft.trendTopic ? `topic: ${draft.trendTopic}` : null,
        draft.preferredKeyword ? `keyword: ${draft.preferredKeyword}` : null,
        draft.suggestedAngle ? `angle: ${draft.suggestedAngle}` : null,
        draft.status ? `status: ${draft.status}` : null,
      ].filter(Boolean);
      const bodyHint = draft.body ? `\n  excerpt: ${String(draft.body).replace(/\s+/g, ' ').slice(0, 650)}` : '';
      return `- ${parts.join(' | ')}${bodyHint}`;
    })
    .join('\n');
  const demandTopics = (siteConfig.demandTopics || [])
    .slice(0, 30)
    .map((topic) => `- ${topic.topic} (${topic.source}, score: ${topic.score}, status: ${topic.demand?.status || 'unknown'}, demand: ${topic.demand?.demandBucket || 'unknown'})`)
    .join('\n');

  const prompt = `You are a content strategist for a Swedish B2B website.\n\nSite context and capability map:\n${siteConfig.niche}\n${siteConfig.capabilitiesContext ? `\n${siteConfig.capabilitiesContext}` : ''}\n\nSeed keywords: ${(siteConfig.seedKeywords || []).join(', ')}\n\nDemand-backed keyword opportunities from Keyword Planner / Google Trends / Operator Hub research:\n${demandTopics || '- none'}\n\nExisting published articles:\n${articleSummaries || '- none'}\n\nExisting generated drafts, including pending, published and rejected drafts:\n${draftSummaries || '- none'}\n\nSuggest 3 specific, non-listicle article ideas that fit the demand-backed keyword opportunities and SebCastwall's real capabilities.\n\nHard rules:\n- Prefer missing, weak, planned, rising or high-demand keywords from the demand list.\n- Include practical diagnosis/help angles when the search intent looks like a problem, setup issue, vendor confusion or repeated question.\n- Do not suggest a topic that overlaps with an existing article or generated draft.\n- Avoid repeating the same system pair, workflow, buyer problem, primary keyword and article angle already present in drafts.\n- If a seed keyword already has recent draft coverage, choose a different keyword or a substantially different business problem.\n- Do not default to pitching a new website; suggest websites only when the problem is actually web presence or conversion.\n- Reject topics that are mainly about SEO strategy, content marketing, topical authority, rankings, publishing tactics, or generic thought-leadership unless the site clearly sells SEO services, which this site does not.\n\nUse topicType:\n- "broad_strategic" for broader but still commercially useful positioning articles\n- "narrow_practical" for concrete use cases, workflows, integrations or implementation problems\n- "support_question" for concrete troubleshooting/FAQ guides\n\nReturn a JSON array:\n[\n  {\n    "topic": "Specific topic in Swedish",\n    "reasoning": "Why it fills a demand-backed gap and why it is not covered by existing drafts",\n    "relevanceScore": 0-100,\n    "closestSeedKeyword": "best matching demand or seed keyword",\n    "suggestedAngle": "problem-focused article angle in Swedish",\n    "topicType": "broad_strategic or narrow_practical or support_question"\n  }\n]`;

  return await callCodex(prompt, { json: true });
}

export async function generateArticle({
  topic,
  niche,
  language,
  seedKeywords = [],
  preferredKeyword = '',
  suggestedAngle = '',
  demand = null,
  demandSource = '',
  contentIntent = '',
  length,
}) {
  const minWords = length?.min ?? 1200;
  const maxWords = length?.max ?? 1800;
  const demandContext = demand
    ? `\nDemand context: source=${demandSource || demand.source || 'unknown'}, status=${demand.status || 'unknown'}, demand=${demand.demandBucket || 'unknown'}, competition=${demand.competition || 'unknown'}, intent=${demand.intent || 'unknown'}, targetUrl=${demand.targetUrl || 'none'}`
    : '';
  const isSupportQuestion = contentIntent === 'support_question' || demand?.intent === 'support_question';
  const articleShape = isSupportQuestion
    ? `\nThis is a help/question article. Write it as a practical troubleshooting guide for someone searching because something is not working.\n\nSupport article requirements:\n- The title should answer the problem directly, for example "Teams-transkribering fungerar inte: så felsöker du steg för steg"\n- Start with likely causes in plain Swedish before deeper explanation\n- Include a step-by-step checklist readers can follow\n- Include separate sections for user-level checks, admin/policy checks, licenses/settings, and when to automate or escalate\n- Answer adjacent FAQ-style questions naturally in H2/H3 sections\n- Do not make it a broad thought-leadership article\n- Keep the CTA short and tied to getting help fixing the workflow`
    : `\nThis is a commercial/educational article. Make it practical, specific and tied to a concrete business outcome.`;
  const prompt = `You are a professional SEO and technical content writer specializing in business technology for Swedish SMBs.\n\nWrite a valuable, actionable article based on this demand-backed topic: "${topic}"\n\nSite context: ${niche}\nLanguage: ${language}\nSeed keywords: ${seedKeywords.join(', ') || 'none'}\nPrimary keyword to lean on: ${preferredKeyword || 'choose the closest relevant seed keyword'}${demandContext}\nSuggested angle: ${suggestedAngle || 'turn the topic into a concrete business problem and practical solution'}\nTarget word count: ${minWords}-${maxWords} words\n${articleShape}\n\nReturn JSON with exactly these fields:\n{\n  "title": "Search-friendly Swedish title",\n  "slug": "url-slug",\n  "metaDescription": "under 160 chars, written for click-through",\n  "body": "full markdown article in Swedish without a top-level H1",\n  "tags": ["tag1", "tag2", "tag3"]\n}\n\nRequirements:\n- Use a title that is practical, specific and searchable, not vague thought-leadership copy\n- Align the article to one clear keyword/theme that fits the demand context and seed keywords\n- Do not rewrite an existing angle with new wording; create a distinct business problem and search intent\n- Solve one specific business problem for Swedish SMBs\n- Stay tightly on the main topic from start to finish; do not drift into a broader services pitch unless it directly supports the primary keyword and reader intent\n- If you mention adjacent systems, automation or integrations, keep it brief and only as supporting context for the main topic\n- The last section must still be about the same problem and keyword as the headline, followed by a short natural CTA\n- Do not include a top-level markdown H1 inside body; start directly with intro paragraphs and H2 sections\n- Use valid markdown only: H2/H3 headings must be headings, bullet lists must use one item per line, and never write inline pseudo-lists such as "- item - item - item" in one paragraph\n- Avoid listicles and generic AI filler\n- Use practical examples, systems and workflows when relevant\n- Use real internal markdown links when relevant, preferably these routes: [AI-automatisering](/tjanster/ai-automatisering), [Systemintegrationer](/tjanster/integrationer), [Kontakt](/kontakt)\n- Do not use placeholder links like [relevant tjänstesida]\n- End with a natural CTA\n- Return JSON only.`;

  return await callCodex(prompt, { json: true });
}
