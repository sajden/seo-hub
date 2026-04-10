import express from 'express';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { marked } from 'marked';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(join(__dirname, 'public')));

/**
 * Get all pending drafts across all sites
 */
function getAllDrafts() {
  const draftsBaseDir = resolve('.local', 'drafts');

  if (!existsSync(draftsBaseDir)) {
    return [];
  }

  const siteDirs = readdirSync(draftsBaseDir);
  const allDrafts = [];

  for (const siteId of siteDirs) {
    const siteDraftsDir = join(draftsBaseDir, siteId);
    const files = readdirSync(siteDraftsDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filepath = join(siteDraftsDir, file);
        const content = readFileSync(filepath, 'utf-8');
        const draft = JSON.parse(content);
        allDrafts.push({ ...draft, filepath });
      } catch (err) {
        console.error(`Failed to read draft ${file}:`, err.message);
      }
    }
  }

  return allDrafts;
}

/**
 * Get a specific draft
 */
function getDraft(siteId, slug) {
  const filepath = resolve('.local', 'drafts', siteId, `${slug}.json`);

  if (!existsSync(filepath)) {
    return null;
  }

  try {
    const content = readFileSync(filepath, 'utf-8');
    return { ...JSON.parse(content), filepath };
  } catch (err) {
    console.error('Failed to read draft:', err.message);
    return null;
  }
}

/**
 * Update draft status
 */
function updateDraftStatus(filepath, status) {
  try {
    const content = readFileSync(filepath, 'utf-8');
    const draft = JSON.parse(content);
    draft.status = status;
    draft.updatedAt = new Date().toISOString();
    writeFileSync(filepath, JSON.stringify(draft, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to update draft:', err.message);
    return false;
  }
}

// Routes

app.get('/', (req, res) => {
  const allDrafts = getAllDrafts();
  const pendingDrafts = allDrafts
    .filter(d => d.status === 'pending')
    .sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));

  const html = `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SEO-Hub - Review Drafts</title>
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
  <div class="container">
    <header>
      <h1>SEO-Hub - Article Drafts</h1>
      <p>Review and approve articles before publishing</p>
    </header>

    ${pendingDrafts.length === 0 ? `
      <div class="empty-state">
        <p>No pending drafts. Generate one with:</p>
        <code>node generator/run.mjs --site autoweb</code>
      </div>
    ` : `
      <table class="drafts-table">
        <thead>
          <tr>
            <th>Site</th>
            <th>Title</th>
            <th>Trend Score</th>
            <th>Generated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${pendingDrafts.map(d => `
            <tr>
              <td><span class="badge">${d.siteId}</span></td>
              <td><strong>${d.title}</strong></td>
              <td>${d.trendScore}</td>
              <td>${new Date(d.generatedAt).toLocaleDateString('sv-SE')}</td>
              <td>
                <a href="/draft/${d.siteId}/${d.slug}" class="btn btn-primary">Review</a>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  </div>
</body>
</html>
  `;

  res.send(html);
});

app.get('/draft/:siteId/:slug', (req, res) => {
  const { siteId, slug } = req.params;
  const draft = getDraft(siteId, slug);

  if (!draft) {
    return res.status(404).send('Draft not found');
  }

  const bodyHtml = marked(draft.body);

  const html = `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${draft.title} - SEO-Hub</title>
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
  <div class="container">
    <header>
      <a href="/" class="back-link">&larr; Back to drafts</a>
      <h1>${draft.title}</h1>
      <p class="meta">
        <span class="badge">${draft.siteId}</span>
        <span>Trend Score: ${draft.trendScore}</span>
        <span>Generated: ${new Date(draft.generatedAt).toLocaleDateString('sv-SE')}</span>
      </p>
    </header>

    <section class="metadata">
      <div class="metadata-row">
        <strong>Slug:</strong> <code>${draft.slug}</code>
      </div>
      <div class="metadata-row">
        <strong>Meta Description:</strong> ${draft.metaDescription}
      </div>
      <div class="metadata-row">
        <strong>Tags:</strong> ${draft.tags.map(t => `<span class="tag">${t}</span>`).join(' ')}
      </div>
      <div class="metadata-row">
        <strong>Topic:</strong> ${draft.trendTopic}
      </div>
      <div class="metadata-row">
        <strong>Reasoning:</strong> ${draft.reasoning}
      </div>
    </section>

    <section class="article-preview">
      <h2>Article Preview</h2>
      <div class="article-content">
        ${bodyHtml}
      </div>
    </section>

    <section class="actions">
      <form method="POST" action="/draft/${siteId}/${slug}/approve" style="display: inline;">
        <button type="submit" class="btn btn-success">Godkänn</button>
      </form>
      <form method="POST" action="/draft/${siteId}/${slug}/reject" style="display: inline;">
        <button type="submit" class="btn btn-danger">Avvisa</button>
      </form>
    </section>
  </div>
</body>
</html>
  `;

  res.send(html);
});

app.post('/draft/:siteId/:slug/approve', (req, res) => {
  const { siteId, slug } = req.params;
  const draft = getDraft(siteId, slug);

  if (!draft) {
    return res.status(404).send('Draft not found');
  }

  const success = updateDraftStatus(draft.filepath, 'approved');

  if (success) {
    console.log(`Draft approved: ${draft.title}`);
    // TODO: Fas 2 - trigger publisher here
    res.redirect('/?approved=1');
  } else {
    res.status(500).send('Failed to approve draft');
  }
});

app.post('/draft/:siteId/:slug/reject', (req, res) => {
  const { siteId, slug } = req.params;
  const draft = getDraft(siteId, slug);

  if (!draft) {
    return res.status(404).send('Draft not found');
  }

  const success = updateDraftStatus(draft.filepath, 'rejected');

  if (success) {
    console.log(`Draft rejected: ${draft.title}`);
    res.redirect('/?rejected=1');
  } else {
    res.status(500).send('Failed to reject draft');
  }
});

app.listen(PORT, () => {
  console.log(`\nSEO-Hub Review UI running at http://localhost:${PORT}\n`);
});
