import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);
const CODEX_GATEWAY_URL = (process.env.SEO_HUB_CODEX_URL ?? process.env.CODEX_GATEWAY_URL ?? '').trim();
const CODEX_GATEWAY_TOKEN = (process.env.SEO_HUB_CODEX_TOKEN ?? process.env.CODEX_GATEWAY_TOKEN ?? '').trim();
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

export async function callCodex(prompt, options = {}) {
  const { json = false } = options;
  let output = '';

  if (CODEX_GATEWAY_URL) {
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
    .map((article) => `- ${article.title} (tags: ${article.tags?.join(', ') || 'none'})`)
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
    return {
      isDuplicate: false,
      reasoning: `Error during comparison: ${err.message}`,
      similarity: 0,
    };
  }
}

export async function checkTopicRelevance(topic, niche, seedKeywords = []) {
  const prompt = `You are analyzing if a topic is relevant for a business-focused Swedish website.\n\nTopic: "${topic}"\nSite niche: ${niche}\nSeed keywords: ${seedKeywords.join(', ') || 'none'}\n\nDecide if the topic should be written as an SEO article for this site. Prefer topics that can be turned into a practical SMB article tied to one of the seed keywords.\n\nClassify the topic as one of:\n- "broad_strategic": a broader keyword/theme that is still valuable for positioning and demand capture\n- "narrow_practical": a more concrete use case, workflow, integration or operational problem\n\nReturn JSON:\n{\n  "isRelevant": true/false,\n  "reasoning": "brief explanation",\n  "relevanceScore": 0-100,\n  "closestSeedKeyword": "best matching keyword or empty string",\n  "suggestedAngle": "best article angle in Swedish",\n  "topicType": "broad_strategic or narrow_practical"\n}`;

  return await callCodex(prompt, { json: true });
}

export async function findContentGaps(existingArticles, siteConfig) {
  const summaries = existingArticles.map((article) => `- ${article.title}`).join('\n');
  const prompt = `You are a content strategist for a Swedish B2B website.\n\nSite niche: ${siteConfig.niche}\nSeed keywords: ${(siteConfig.seedKeywords || []).join(', ')}\n\nExisting articles:\n${summaries}\n\nSuggest 3 specific, non-listicle article ideas that fit the seed keywords and the site's services. Reject topics that are mainly about SEO strategy, content marketing, topical authority, rankings, publishing tactics, or generic thought-leadership unless the site clearly sells SEO services, which this site does not.\n\nUse topicType:\n- "broad_strategic" for broader but still commercially useful positioning articles\n- "narrow_practical" for concrete use cases, workflows, integrations or implementation problems\n\nReturn a JSON array:\n[\n  {\n    "topic": "Specific topic in Swedish",\n    "reasoning": "Why it fills a gap",\n    "relevanceScore": 0-100,\n    "closestSeedKeyword": "best matching seed keyword",\n    "suggestedAngle": "problem-focused article angle in Swedish",\n    "topicType": "broad_strategic or narrow_practical"\n  }\n]`;

  return await callCodex(prompt, { json: true });
}

export async function generateArticle({
  topic,
  niche,
  language,
  seedKeywords = [],
  preferredKeyword = '',
  suggestedAngle = '',
  length,
}) {
  const minWords = length?.min ?? 1200;
  const maxWords = length?.max ?? 1800;
  const prompt = `You are a professional SEO and technical content writer specializing in business technology for Swedish SMBs.\n\nWrite a valuable, actionable article based on this trend topic: "${topic}"\n\nSite context: ${niche}\nLanguage: ${language}\nSeed keywords: ${seedKeywords.join(', ') || 'none'}\nPrimary keyword to lean on: ${preferredKeyword || 'choose the closest relevant seed keyword'}\nSuggested angle: ${suggestedAngle || 'turn the topic into a concrete business problem and practical solution'}\nTarget word count: ${minWords}-${maxWords} words\n\nReturn JSON with exactly these fields:\n{\n  "title": "Search-friendly Swedish title",\n  "slug": "url-slug",\n  "metaDescription": "under 160 chars, written for click-through",\n  "body": "full markdown article in Swedish without a top-level H1",\n  "tags": ["tag1", "tag2", "tag3"]\n}\n\nRequirements:\n- Use a title that is practical, specific and searchable, not vague thought-leadership copy\n- Align the article to one clear keyword/theme that fits the site and seed keywords\n- Solve one specific business problem for Swedish SMBs\n- Stay tightly on the main topic from start to finish; do not drift into a broader services pitch unless it directly supports the primary keyword and reader intent\n- If you mention adjacent systems, automation or integrations, keep it brief and only as supporting context for the main topic\n- The last section must still be about the same problem and keyword as the headline, followed by a short natural CTA\n- Do not include a top-level markdown H1 inside body; start directly with intro paragraphs and H2 sections\n- Avoid listicles and generic AI filler\n- Use practical examples, systems and workflows when relevant\n- Use real internal markdown links when relevant, preferably these routes: [AI-automatisering](/tjanster/ai-automatisering), [Systemintegrationer](/tjanster/integrationer), [Kontakt](/kontakt)\n- Do not use placeholder links like [relevant tjänstesida]\n- End with a natural CTA\n- Return JSON only.`;

  return await callCodex(prompt, { json: true });
}
