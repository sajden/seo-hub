import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

/**
 * Execute Codex CLI with a prompt
 * @param {string} prompt - The prompt to send to Codex
 * @param {Object} options - Optional parameters
 * @param {boolean} options.json - Expect JSON response
 * @returns {Promise<string|Object>} Response from Codex
 */
export async function callCodex(prompt, options = {}) {
  const { json = false } = options;

  // Create temp directory for input/output
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-'));
  const outputFile = join(tempDir, 'output.txt');

  try {
    // Use codex exec with stdin (avoids escaping issues)
    const command = `echo ${JSON.stringify(prompt)} | codex exec --ephemeral --output-last-message "${outputFile}" -`;

    const { stderr } = await execAsync(command, {
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      shell: '/bin/bash'
    });

    if (stderr && !stderr.includes('Session completed')) {
      console.warn('Codex stderr:', stderr);
    }

    // Read output from file
    const output = readFileSync(outputFile, 'utf-8').trim();

    if (json) {
      try {
        // Try to extract JSON from markdown code blocks if present
        const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[1]);
        }
        return JSON.parse(output);
      } catch (err) {
        throw new Error(`Failed to parse Codex JSON response: ${err.message}\nOutput: ${output}`);
      }
    }

    return output;
  } catch (err) {
    throw new Error(`Codex execution failed: ${err.message}`);
  } finally {
    // Always clean up temp files
    try {
      unlinkSync(outputFile);
    } catch {}
  }
}

/**
 * Compare a topic with existing articles to check for semantic duplicates
 * @param {string} topic - The topic to check
 * @param {Array<Object>} existingArticles - Array of existing article metadata
 * @returns {Promise<Object>} { isDuplicate: boolean, reasoning: string, similarity: number }
 */
export async function semanticCompare(topic, existingArticles) {
  const articleSummaries = existingArticles.map(a =>
    `- ${a.title} (tags: ${a.tags?.join(', ') || 'none'})`
  ).join('\n');

  const prompt = `You are analyzing if a new topic is a duplicate of existing articles.

Topic to check: "${topic}"

Existing articles:
${articleSummaries}

Answer in JSON format:
{
  "isDuplicate": true/false,
  "reasoning": "brief explanation",
  "similarity": 0-100
}

Consider it a duplicate if:
- The topic covers the same core subject/intent
- The content would overlap >70%
- It's essentially the same story or angle

Return isDuplicate=false if:
- It's a different angle on a similar topic
- It covers a new development/update
- The focus is substantially different`;

  try {
    const result = await callCodex(prompt, { json: true });
    return {
      isDuplicate: result.isDuplicate || false,
      reasoning: result.reasoning || 'No reasoning provided',
      similarity: result.similarity || 0,
    };
  } catch (err) {
    console.error('Semantic compare failed:', err.message);
    // Default to not duplicate on error to avoid blocking generation
    return {
      isDuplicate: false,
      reasoning: `Error during comparison: ${err.message}`,
      similarity: 0,
    };
  }
}

/**
 * Generate article content using Codex
 * @param {Object} params - Generation parameters
 * @param {string} params.topic - Article topic
 * @param {string} params.niche - Site niche
 * @param {string} params.language - Target language
 * @param {Object} params.length - { min, max } word count
 * @returns {Promise<Object>} Generated article data
 */
export async function generateArticle({ topic, niche, language, length }) {
  const prompt = `You are a professional SEO and technical content writer specializing in business technology.

Write a valuable, actionable article about: "${topic}"

Site context: ${niche}
Language: ${language}
Target word count: 1200-1800 words (aim for narrow and deep coverage)

CRITICAL REQUIREMENTS:

1. SINGLE PROBLEM FOCUS (MANDATORY)
   - This article must solve ONE specific problem for ONE type of reader
   - FORBIDDEN: "Complete guide to...", "Everything about...", "Ultimate guide to..."
   - FORBIDDEN: Trying to cover multiple scenarios, audiences, or use cases
   - REQUIRED: Identify the exact pain point and solve it thoroughly
   - Example of GOOD focus: "How to automate invoice approvals in Microsoft 365 for finance teams"
   - Example of BAD focus: "A guide to Microsoft 365 automation" (too broad)

1b. ANTI-LISTICLE RULES (CRITICAL - ABSOLUTELY NO EXCEPTIONS)
   - FORBIDDEN: "X ways to...", "X processes to...", "X tips for...", "X automations to..."
   - FORBIDDEN: Articles structured as numbered lists covering 5+ different processes/solutions
   - FORBIDDEN: Generic category titles like "AI automation for SMB" or "Guide to Microsoft 365"
   - REQUIRED: Pick ONE specific problem and solve it completely with deep implementation details
   - TEST: If you're tempted to create numbered sections 1-10, STOP. Pick ONE process and go deep instead.

   BAD EXAMPLE TITLES (NEVER DO THIS):
   ❌ "AI-automation för svenska SMB: 10 processer att automatisera"
   ❌ "Guide till Microsoft 365 automation"
   ❌ "7 sätt att förbättra din CRM-process"
   ❌ "Du förlorar timmar på manuellt admin: 7 AI-automationer för svenska SMB"

   GOOD EXAMPLE TITLES (DO THIS):
   ✅ "Slipp dubbelregistrera order från Shopify till Business Central"
   ✅ "Sluta jaga inköpsgodkännanden i Office 365"
   ✅ "Automatisera fakturamatchning mellan Fortnox och leverantörsmejl"

2. DEPTH OVER BREADTH
   - Go narrow and deep - cover ONE thing comprehensively
   - If the topic feels too broad, narrow it down to a specific use case
   - Provide step-by-step implementation details, not high-level overviews
   - Include specific configuration examples, settings, or code where relevant
   - Answer: "What exactly do I click/configure/do?" not "What is this concept?"

3. PRACTICAL VALUE (SHOW, DON'T TELL)
   - Start with the exact problem: "You're wasting 10 hours/week on X because..."
   - Provide 3-5 concrete, immediately actionable steps
   - Include real metrics when possible (e.g., "saves 5-10 hours/week", "reduces costs by 30%")
   - Use SPECIFIC examples: actual tool names, feature names, menu paths
   - Add "common mistakes" or "what to avoid" sections

4. WRITING STYLE
   - Direct, conversational tone - advise a colleague, not lecture an audience
   - NO marketing fluff, NO buzzwords, NO corporate speak
   - NO keyword stuffing, NO backticks, NO forced repetition
   - Vary your phrasing naturally - never repeat the same phrase 3+ times
   - Use active voice ("Du kan..." not "Det kan göras...")
   - Keep paragraphs 2-4 sentences max
   - Write for busy decision-makers who need answers, not education

5. STRUCTURE (FOCUS-FIRST)
   - H1: Problem-focused title (not feature-focused)
     GOOD: "Sluta slösa tid på manuella godkännanden i Teams"
     BAD: "Automatisering med Microsoft Power Automate"
   - Introduction (2-3 paragraphs):
     * Paragraph 1: The specific problem and its cost/pain
     * Paragraph 2: Why this problem exists / what causes it
     * Paragraph 3: What this article will help you do (the solution preview)
   - 3-5 H2 sections with actionable, implementation-focused content
   - H3 subsections only when breaking down complex steps
   - Conclusion: Quick recap + when to get help + CTA

6. CONTENT GUARDRAILS (WHAT TO AVOID)
   - NO generic platitudes ("in today's digital world", "leverage synergies")
   - NO salesy language ("best solution", "industry-leading", "revolutionary")
   - NO vague advice ("consider implementing", "think about", "you might want to")
   - NO superficial coverage of multiple topics - pick ONE and go deep
   - NO executive summaries or high-level strategic thinking pieces
   - If you're explaining "what" something is for more than 1 paragraph, you're too broad

7. SPECIFICITY REQUIREMENTS
   - Name specific tools, features, or methods (not "use automation tools" but "use Power Automate's approval workflow feature")
   - Provide numbered implementation steps with exact actions
   - Include "when to do this" vs "when NOT to do this" guidance
   - Mention prerequisites or requirements upfront
   - State when professional help is needed vs DIY-friendly

8. CALL-TO-ACTION (MANDATORY)
   - End with a natural, specific CTA tied to the article's exact topic
   - Format: "Behöver du hjälp med [the specific problem from this article]? [Contact suggestion]"
   - Make it helpful, not salesy - position as expertise offer
   - Example: "Behöver du hjälp att sätta upp automatiserade godkännandeflöden? Vi hjälper företag att implementera detta på 1-2 dagar."

9. EVERGREEN CONTENT
   - No hardcoded dates or "in 2026" references
   - Focus on timeless principles and current best practices
   - Write so it stays relevant for 12-24 months
   - If a feature/tool might change, note: "OBS: Gränssnittet kan förändras - principerna är desamma"

TONE GUIDELINES:
- Less consultant whitepaper, more practical how-to guide
- Less "strategic thinking", more "here's exactly what to do"
- Less "let's explore the possibilities", more "do this, then this, then this"
- Address reader as "du" (Swedish informal, direct)
- Write like a senior colleague sharing a solution they've implemented successfully

TARGET AUDIENCE:
- Busy Swedish SMB decision-makers (CEOs, operations managers, IT managers)
- They need solutions, not education
- They value specificity and time-savings
- They'll pay for expertise if you demonstrate it clearly

TOOL SELECTION (Swedish SMB context - CRITICAL):
- PRIORITIZE tools commonly used by Swedish SMBs, not US tech startups
- CRM: Prefer Pipedrive, Lime CRM, SuperOffice, Dynamics 365 > HubSpot (rarely used in Sweden)
- Ekonomisystem: Fortnox, Visma eEkonomi, Bokio, PE Accounting
- Automation: Power Automate, Make, n8n, Zapier
- E-handel: Shopify, WooCommerce
- Affärssystem: Business Central, MONITOR, Visma Business
- When choosing between similar solutions, ALWAYS pick the one more common in Swedish SMB market
- Example: For "CRM integration" → use Pipedrive or Lime CRM, NOT HubSpot
- Example: For "invoice automation" → use Fortnox, NOT QuickBooks or Xero

SEO REQUIREMENTS:
- Meta description: Under 160 chars, problem-focused, includes main keyword naturally
- Slug: lowercase, hyphens, descriptive, specific (e.g., "automatisera-fakturagodkannanden-microsoft-365")
- Tags: 3-5 relevant Swedish tags (lowercase, hyphens for multi-word tags)

QUALITY CHECKS (before returning):
- [ ] Does this solve ONE specific problem (not multiple)?
- [ ] Would a reader know EXACTLY what to do after reading?
- [ ] Did I avoid broad "guide to everything" syndrome?
- [ ] Are there specific tool names, steps, and examples?
- [ ] Is this actionable tomorrow, not "food for thought"?
- [ ] Does the title describe a SPECIFIC problem (not a category like "AI automation for SMB")?
- [ ] Did I avoid listicle format (7 ways, 10 processes, etc.)?
- [ ] Would this article become USELESS if split into 10 separate articles? (If yes, it's too broad)
- [ ] Can I explain this article's value in ONE sentence without using "and"?

Return ONLY a JSON object with this exact structure:
{
  "title": "Problem-focused, specific title (not 'Guide to X')",
  "slug": "url-friendly-slug-specific-to-problem",
  "metaDescription": "Problem-solution description under 160 chars",
  "body": "# Title\\n\\nFull markdown content with H2 and H3 sections...",
  "tags": ["tag1", "tag2", "tag3"]
}`;

  return await callCodex(prompt, { json: true });
}

/**
 * Check if a topic is relevant to the site niche
 * @param {string} topic - Topic to check
 * @param {string} niche - Site niche
 * @returns {Promise<Object>} { isRelevant: boolean, reasoning: string, score: number }
 */
export async function checkTopicRelevance(topic, niche) {
  const prompt = `You are analyzing if a topic is relevant to a website's niche.

Topic: "${topic}"
Site niche: ${niche}

Is this topic relevant and valuable for this niche?

Return JSON:
{
  "isRelevant": true/false,
  "reasoning": "brief explanation",
  "relevanceScore": 0-100
}

Consider it relevant if:
- It directly relates to the niche
- It would interest the target audience
- It provides value to readers of this site

Consider it irrelevant if:
- It's completely unrelated to the niche
- It wouldn't interest the target audience
- It's off-topic`;

  try {
    const result = await callCodex(prompt, { json: true });
    return {
      isRelevant: result.isRelevant || false,
      reasoning: result.reasoning || 'No reasoning provided',
      score: result.relevanceScore || 0,
    };
  } catch (err) {
    console.error('Relevance check failed:', err.message);
    // Default to relevant on error to avoid blocking
    return {
      isRelevant: true,
      reasoning: `Error during check: ${err.message}`,
      score: 50,
    };
  }
}

/**
 * Find topic gaps in existing content
 * @param {Array<Object>} existingArticles - Existing article metadata
 * @param {string} niche - Site niche
 * @param {Array<string>} keywords - Seed keywords
 * @returns {Promise<Array<Object>>} Suggested topics
 */
export async function findContentGaps(existingArticles, niche, keywords) {
  const articleSummaries = existingArticles.map(a =>
    `- ${a.title}`
  ).join('\n');

  const prompt = `You are a content strategist.

Site niche: ${niche}
Seed keywords: ${keywords.join(', ')}

Existing articles:
${articleSummaries}

Based on the existing content, suggest 3 new article topics that:
1. Fill gaps in coverage
2. Are relevant to the niche and keywords
3. Would provide value to readers
4. Are NOT duplicates of existing articles

CRITICAL - ANTI-LISTICLE RULES:
- FORBIDDEN: "X ways to...", "X processes to...", "X användningsområden", "X tips för..."
- FORBIDDEN: Topics that would naturally become numbered lists of 5+ different things
- REQUIRED: Each topic must solve ONE specific problem for ONE type of reader
- REQUIRED: Focus on specific tool combinations or specific pain points

BAD EXAMPLES (NEVER SUGGEST):
❌ "ChatGPT för företag: 12 konkreta användningsområden för svenska SMB"
❌ "7 sätt att förbättra er CRM-process"
❌ "Guide till Microsoft 365 automation"

GOOD EXAMPLES (SUGGEST THESE):
✅ "Slipp dubbelregistrera fakturor mellan Fortnox och leverantörsmejl"
✅ "Automatisera godkännandeflöden i Microsoft Teams med Power Automate"
✅ "ChatGPT för företag: automatisera återkommande kundsvar"

Return JSON array:
[
  {
    "topic": "Specific, problem-focused topic (NOT a listicle)",
    "reasoning": "Why this fills a gap",
    "relevanceScore": 0-100
  }
]`;

  try {
    const topics = await callCodex(prompt, { json: true });
    return Array.isArray(topics) ? topics : [];
  } catch (err) {
    console.error('Content gap analysis failed:', err.message);
    return [];
  }
}
