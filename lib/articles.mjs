import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Read all existing articles from a target repository
 * @param {string} repoPath - Path to the target repository (e.g., ../auto-web)
 * @param {string} contentPath - Path within repo to articles (e.g., content/articles)
 * @returns {Array<Object>} Array of article metadata
 */
export function readExistingArticles(repoPath, contentPath) {
  const fullPath = resolve(repoPath, contentPath);

  if (!existsSync(fullPath)) {
    console.warn(`Articles path does not exist: ${fullPath}`);
    return [];
  }

  try {
    const files = readdirSync(fullPath).filter(f => f.endsWith('.mdx') || f.endsWith('.md'));
    const articles = [];

    for (const file of files) {
      const filePath = join(fullPath, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const metadata = parseArticle(content, file);
        articles.push(metadata);
      } catch (err) {
        console.error(`Failed to read article ${file}:`, err.message);
      }
    }

    return articles;
  } catch (err) {
    console.error(`Failed to read articles from ${fullPath}:`, err.message);
    return [];
  }
}

/**
 * Parse an MDX/MD article file
 * @param {string} content - File content
 * @param {string} filename - File name
 * @returns {Object} Parsed metadata
 */
function parseArticle(content, filename) {
  const frontmatter = parseFrontmatter(content);
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

  return {
    filename,
    title: frontmatter.title || extractFirstHeading(body) || filename,
    description: frontmatter.description || frontmatter.metaDescription || '',
    tags: frontmatter.tags || [],
    date: frontmatter.date || null,
    body: body.substring(0, 500), // First 500 chars for context
  };
}

/**
 * Parse YAML frontmatter from markdown content
 * @param {string} content - Markdown content
 * @returns {Object} Parsed frontmatter
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const data = {};

  // Simple YAML parser (handles basic key: value pairs)
  const lines = yaml.split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim();
    let value = line.substring(colonIndex + 1).trim();

    // Remove quotes
    value = value.replace(/^["']|["']$/g, '');

    // Handle arrays (tags: [tag1, tag2])
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
    }

    data[key] = value;
  }

  return data;
}

/**
 * Extract first H1 heading from markdown
 * @param {string} markdown - Markdown content
 * @returns {string|null} First heading or null
 */
function extractFirstHeading(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Read existing drafts for a site
 * @param {string} siteId - Site identifier
 * @returns {Array<Object>} Array of draft objects
 */
export function readExistingDrafts(siteId) {
  const draftsPath = resolve('.local', 'drafts', siteId);

  if (!existsSync(draftsPath)) {
    return [];
  }

  try {
    const files = readdirSync(draftsPath).filter(f => f.endsWith('.json'));
    const drafts = [];

    for (const file of files) {
      const filePath = join(draftsPath, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const draft = JSON.parse(content);
        drafts.push(draft);
      } catch (err) {
        console.error(`Failed to read draft ${file}:`, err.message);
      }
    }

    return drafts;
  } catch (err) {
    console.error(`Failed to read drafts from ${draftsPath}:`, err.message);
    return [];
  }
}
