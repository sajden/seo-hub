import express from 'express';
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { marked } from 'marked';
import { publishDraft, updatePublishedDraft, unpublishDraft, deleteDraft } from '../publisher/publish-draft.mjs';
import { startScheduler, getSchedulerStatus, triggerGeneration } from '../lib/scheduler.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT ?? process.env.SEO_HUB_PORT ?? 3001);
const BASE_PATH = normalizeBasePath(process.env.SEO_HUB_BASE_PATH ?? '');
const router = express.Router();
const ALLOWED_ORIGINS = new Set((process.env.SEO_HUB_ALLOWED_ORIGINS ?? [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'https://dashboard.sebcastwall.se',
  'https://personal-ai-dashboard-57d.pages.dev'
].join(',')).split(',').map(origin => origin.trim()).filter(Boolean));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
router.use('/ui/public', express.static(join(__dirname, 'public')));

function normalizeBasePath(value) {
  if (!value || value === '/') {
    return '';
  }
  return `/${String(value).replace(/^\/+|\/+$/g, '')}`;
}

function withBase(pathname = '') {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${BASE_PATH}${normalized}` || normalized;
}

function uiHref(pathname = '/') {
  const suffix = pathname === '/' ? '/ui/' : `/ui${pathname}`;
  return withBase(suffix);
}

function apiHref(pathname) {
  return withBase(pathname);
}

function getAllDrafts() {
  const draftsBaseDir = resolve('.local', 'drafts');

  if (!existsSync(draftsBaseDir)) {
    return [];
  }

  const siteDirs = readdirSync(draftsBaseDir);
  const allDrafts = [];

  for (const siteId of siteDirs) {
    const siteDraftsDir = join(draftsBaseDir, siteId);
    const files = readdirSync(siteDraftsDir).filter((file) => file.endsWith('.json'));

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

function updateDraftFile(filepath, updates) {
  const current = JSON.parse(readFileSync(filepath, 'utf-8'));
  const nextDraft = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(filepath, JSON.stringify(nextDraft, null, 2), 'utf-8');
  return nextDraft;
}

function updateDraftStatus(filepath, status) {
  try {
    updateDraftFile(filepath, { status });
    return true;
  } catch (err) {
    console.error('Failed to update draft status:', err.message);
    return false;
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLayout({ title, content }) {
  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="${uiHref('/public/styles.css')}">
</head>
<body>
  <div class="container">
    <header>
      <div class="topbar">
        <div>
          <h1>SEO-Hub</h1>
          <p>Granska, publicera och hantera artiklar.</p>
        </div>
        <nav class="nav-links">
          <a href="${uiHref('/')}">Utkast</a>
          <a href="${uiHref('/published')}">Publicerade</a>
        </nav>
      </div>
    </header>
    ${content}
  </div>
</body>
</html>
  `;
}

function formatDate(value) {
  if (!value) {
    return 'Okänt datum';
  }

  return new Date(value).toLocaleDateString('sv-SE');
}

function toArticleJob(siteState) {
  const status = siteState.running
    ? 'running'
    : siteState.lastRunStatus === 'error'
      ? 'failed'
      : siteState.lastRunStatus === 'ok'
        ? 'completed'
        : 'scheduled';

  return {
    id: `article-generator-${siteState.siteId}`,
    module: 'article-generator',
    title: `Article generation: ${siteState.siteId}`,
    status,
    runModes: ['manual', 'scheduled', 'retry'],
    approvals: ['article_publish'],
    createdAt: null,
    updatedAt: siteState.lastRunAt ?? siteState.nextRunAt,
    schedule: {
      nextRunAt: siteState.nextRunAt,
    },
    summary: {
      siteId: siteState.siteId,
      lastRunAt: siteState.lastRunAt,
      lastRunStatus: siteState.lastRunStatus,
      lastRunError: siteState.lastRunError,
      lastRunSlugs: siteState.lastRunSlugs ?? [],
    },
    outputs: (siteState.lastRunSlugs ?? []).map((slug) => ({
      type: 'article_draft',
      slug,
    })),
  };
}

function articleJobs() {
  return (getSchedulerStatus().sites ?? []).map(toArticleJob);
}

function siteIdFromJobId(jobId) {
  return String(jobId).replace(/^article-generator-/, '');
}

function publicDraft(draft) {
  return {
    siteId: draft.siteId,
    slug: draft.slug,
    title: draft.title,
    metaDescription: draft.metaDescription ?? '',
    body: draft.body ?? '',
    tags: Array.isArray(draft.tags) ? draft.tags : [],
    status: draft.status ?? 'pending',
    category: draft.category ?? '',
    trendScore: draft.trendScore ?? null,
    trendTopic: draft.trendTopic ?? '',
    preferredKeyword: draft.preferredKeyword ?? '',
    suggestedAngle: draft.suggestedAngle ?? '',
    reasoning: draft.reasoning ?? '',
    generatedAt: draft.generatedAt ?? null,
    updatedAt: draft.updatedAt ?? null,
    publishedAt: draft.publishedAt ?? null,
    publishedPath: draft.publishedPath ?? null,
  };
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map((tag) => String(tag).trim()).filter(Boolean);
  }

  return String(value ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'article-generator',
    basePath: BASE_PATH,
    scheduler: getSchedulerStatus(),
  });
});

router.get('/scheduler/status', (req, res) => {
  res.json(getSchedulerStatus());
});

router.get('/jobs', (req, res) => {
  res.json({ jobs: articleJobs() });
});

router.get('/jobs/:jobId', (req, res) => {
  const job = articleJobs().find((candidate) => candidate.id === req.params.jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.json({ job });
});

router.post('/jobs/:jobId/run', (req, res) => {
  const siteId = siteIdFromJobId(req.params.jobId);
  const job = articleJobs().find((candidate) => candidate.id === req.params.jobId);
  const status = getSchedulerStatus();

  if (!job) {
    res.status(404).json({ ok: false, error: 'Job not found' });
    return;
  }

  if (status.running) {
    res.status(409).json({ ok: false, error: 'Article Agent is already generating' });
    return;
  }

  res.status(202).json({ ok: true, started: true, jobId: req.params.jobId, siteId });

  triggerGeneration({ siteId, reason: 'manual_job_api' })
    .then((result) => {
      console.log(`[article-generator] Job run completed for ${result.siteIds.join(', ')}`);
    })
    .catch((error) => {
      console.error('[article-generator] Job run failed:', error.message);
    });
});

router.get('/schedules', (req, res) => {
  const scheduler = getSchedulerStatus();
  res.json({
    schedules: (scheduler.sites ?? []).map((site) => ({
      id: `article-generator-${site.siteId}`,
      module: 'article-generator',
      jobId: `article-generator-${site.siteId}`,
      enabled: scheduler.enabled,
      summary: scheduler.scheduleSummary,
      nextRunAt: site.nextRunAt,
    })),
  });
});

router.get('/integrations/status', (req, res) => {
  res.json({
    integrations: [
      {
        id: 'codex_gateway',
        label: 'Codex Gateway',
        configured: Boolean(process.env.SEO_HUB_CODEX_URL || process.env.CODEX_GATEWAY_URL),
        secretExposed: false,
      },
      {
        id: 'publish_secret',
        label: 'Publish Secret',
        configured: Boolean(process.env.AUTOWEB_SECRET),
        secretExposed: false,
      },
    ],
  });
});

router.get('/drafts', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const drafts = getAllDrafts()
    .filter((draft) => !status || draft.status === status)
    .sort((a, b) => new Date(b.updatedAt ?? b.generatedAt ?? b.publishedAt ?? 0) - new Date(a.updatedAt ?? a.generatedAt ?? a.publishedAt ?? 0))
    .map(publicDraft);

  res.json({ drafts });
});

router.get('/drafts/:siteId/:slug', (req, res) => {
  const draft = getDraft(req.params.siteId, req.params.slug);

  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  res.json({ draft: publicDraft(draft) });
});

router.patch('/drafts/:siteId/:slug', (req, res) => {
  const draft = getDraft(req.params.siteId, req.params.slug);

  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  try {
    const updated = updateDraftFile(draft.filepath, {
      title: req.body.title ?? draft.title,
      metaDescription: req.body.metaDescription ?? draft.metaDescription,
      category: req.body.category ?? draft.category,
      tags: req.body.tags === undefined ? draft.tags : parseTags(req.body.tags),
      body: req.body.body ?? draft.body,
    });
    res.json({ draft: publicDraft(updated) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/drafts/:siteId/:slug', (req, res) => {
  const draft = getDraft(req.params.siteId, req.params.slug);

  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  try {
    unlinkSync(draft.filepath);
    res.json({ ok: true, siteId: req.params.siteId, slug: req.params.slug });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/drafts/:siteId/:slug/reject', (req, res) => {
  const draft = getDraft(req.params.siteId, req.params.slug);

  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const updated = updateDraftFile(draft.filepath, {
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
  });
  res.json({ draft: publicDraft(updated) });
});

router.post('/drafts/:siteId/:slug/publish', async (req, res) => {
  const draft = getDraft(req.params.siteId, req.params.slug);

  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  try {
    const result = await publishDraft(req.params.siteId, req.params.slug);
    const updated = getDraft(req.params.siteId, req.params.slug);
    res.json({ ok: true, result, draft: updated ? publicDraft(updated) : null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/generate', (req, res) => {
  const siteId = typeof req.body?.siteId === 'string' && req.body.siteId.trim() ? req.body.siteId.trim() : null;
  const status = getSchedulerStatus();

  if (status.running) {
    res.status(409).json({ ok: false, error: 'SEO-Hub kör redan en generering' });
    return;
  }

  res.status(202).json({ ok: true, started: true, siteId: siteId ?? 'all' });

  triggerGeneration({ siteId, reason: 'manual_api' })
    .then((result) => {
      console.log(`[article-generator] Manual generation completed for ${result.siteIds.join(', ')}`);
    })
    .catch((error) => {
      console.error('[article-generator] Manual generation failed:', error.message);
    });
});

router.get(['/ui', '/ui/'], (req, res) => {
  const allDrafts = getAllDrafts();
  const pendingDrafts = allDrafts
    .filter((draft) => draft.status === 'pending')
    .sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  const scheduler = getSchedulerStatus();

  const statusPanel = `
    <section class="metadata" style="margin-bottom: 24px;">
      <div class="metadata-row"><strong>Schema:</strong> ${escapeHtml(scheduler.scheduleSummary ?? '–')}</div>
      <div class="metadata-row"><strong>Nästa körning:</strong> ${escapeHtml(scheduler.nextRunAt ? new Date(scheduler.nextRunAt).toLocaleString('sv-SE') : '–')}</div>
      <div class="metadata-row"><strong>Senaste körning:</strong> ${escapeHtml(scheduler.lastRunAt ? new Date(scheduler.lastRunAt).toLocaleString('sv-SE') : '–')}</div>
      <div class="metadata-row"><strong>Status:</strong> ${escapeHtml(scheduler.running ? 'Kör nu' : scheduler.lastRunStatus ?? 'Ingen körning')}</div>
      ${scheduler.lastRunError ? `<div class="metadata-row"><strong>Fel:</strong> ${escapeHtml(scheduler.lastRunError)}</div>` : ''}
      <div class="metadata-row"><strong>Manuell körning:</strong> <code>POST ${escapeHtml(apiHref('/generate'))}</code></div>
    </section>
  `;

  const content = pendingDrafts.length === 0
    ? `
      ${statusPanel}
      <div class="empty-state">
        <p>Inga väntande utkast just nu.</p>
        <code>node generator/run.mjs --site autoweb</code>
      </div>
    `
    : `
      ${statusPanel}
      <table class="drafts-table">
        <thead>
          <tr>
            <th>Site</th>
            <th>Titel</th>
            <th>Trend Score</th>
            <th>Skapad</th>
            <th>Åtgärd</th>
          </tr>
        </thead>
        <tbody>
          ${pendingDrafts.map((draft) => `
            <tr>
              <td><span class="badge">${escapeHtml(draft.siteId)}</span></td>
              <td><strong>${escapeHtml(draft.title)}</strong></td>
              <td>${escapeHtml(draft.trendScore ?? '-')}</td>
              <td>${formatDate(draft.generatedAt)}</td>
              <td><a href="${uiHref(`/draft/${draft.siteId}/${draft.slug}`)}" class="btn btn-primary">Granska</a></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

  res.send(renderLayout({
    title: 'SEO-Hub - Utkast',
    content,
  }));
});

router.get('/ui/draft/:siteId/:slug', (req, res) => {
  const { siteId, slug } = req.params;
  const draft = getDraft(siteId, slug);

  if (!draft) {
    return res.status(404).send('Draft not found');
  }

  const bodyHtml = marked(draft.body || '');

  const content = `
    <a href="${uiHref('/')}" class="back-link">&larr; Tillbaka till utkast</a>
    <section class="page-head">
      <h2>${escapeHtml(draft.title)}</h2>
      <p class="meta">
        <span class="badge">${escapeHtml(draft.siteId)}</span>
        <span>Trend Score: ${escapeHtml(draft.trendScore ?? '-')}</span>
        <span>Skapad: ${formatDate(draft.generatedAt)}</span>
      </p>
    </section>

    <section class="metadata">
      <div class="metadata-row"><strong>Slug:</strong> <code>${escapeHtml(draft.slug)}</code></div>
      <div class="metadata-row"><strong>Meta Description:</strong> ${escapeHtml(draft.metaDescription ?? '')}</div>
      <div class="metadata-row"><strong>Tags:</strong> ${(draft.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(' ')}</div>
      <div class="metadata-row"><strong>Topic:</strong> ${escapeHtml(draft.trendTopic ?? '')}</div>
      <div class="metadata-row"><strong>Reasoning:</strong> ${escapeHtml(draft.reasoning ?? '')}</div>
    </section>

    <section class="article-preview">
      <h2>Förhandsvisning</h2>
      <div class="article-content">${bodyHtml}</div>
    </section>

    <section class="actions">
      <form method="POST" action="${uiHref(`/draft/${siteId}/${slug}/approve`)}">
        <button type="submit" class="btn btn-success">Godkänn</button>
      </form>
      <form method="POST" action="${uiHref(`/draft/${siteId}/${slug}/reject`)}">
        <button type="submit" class="btn btn-danger">Avvisa</button>
      </form>
      <form method="POST" action="${uiHref(`/draft/${siteId}/${slug}/delete`)}">
        <button type="submit" class="btn btn-danger">Radera permanent</button>
      </form>
    </section>
  `;

  res.send(renderLayout({
    title: `${draft.title} - SEO-Hub`,
    content,
  }));
});

router.get('/ui/published', (req, res) => {
  const allDrafts = getAllDrafts();
  const publishedDrafts = allDrafts
    .filter((draft) => draft.status === 'published')
    .sort((a, b) => new Date(b.publishedAt || b.updatedAt || 0) - new Date(a.publishedAt || a.updatedAt || 0));

  const content = publishedDrafts.length === 0
    ? `
      <div class="empty-state">
        <p>Inga publicerade artiklar ännu.</p>
      </div>
    `
    : `
      <table class="drafts-table">
        <thead>
          <tr>
            <th>Site</th>
            <th>Titel</th>
            <th>Slug</th>
            <th>Publicerad</th>
            <th>Åtgärd</th>
          </tr>
        </thead>
        <tbody>
          ${publishedDrafts.map((draft) => `
            <tr>
              <td><span class="badge">${escapeHtml(draft.siteId)}</span></td>
              <td><strong>${escapeHtml(draft.title)}</strong></td>
              <td><code>${escapeHtml(draft.slug)}</code></td>
              <td>${formatDate(draft.publishedAt || draft.updatedAt)}</td>
              <td><a href="${uiHref(`/published/${draft.siteId}/${draft.slug}`)}" class="btn btn-primary">Hantera</a></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

  res.send(renderLayout({
    title: 'SEO-Hub - Publicerade artiklar',
    content,
  }));
});

router.get('/ui/published/:siteId/:slug', (req, res) => {
  const { siteId, slug } = req.params;
  const draft = getDraft(siteId, slug);

  if (!draft || draft.status !== 'published') {
    return res.status(404).send('Published article not found');
  }

  const bodyHtml = marked(draft.body || '');
  const tags = Array.isArray(draft.tags) ? draft.tags.join(', ') : '';

  const content = `
    <a href="${uiHref('/published')}" class="back-link">&larr; Tillbaka till publicerade</a>
    <section class="page-head">
      <h2>${escapeHtml(draft.title)}</h2>
      <p class="meta">
        <span class="badge">${escapeHtml(draft.siteId)}</span>
        <span>Slug: ${escapeHtml(draft.slug)}</span>
        <span>Publicerad: ${formatDate(draft.publishedAt || draft.updatedAt)}</span>
      </p>
    </section>

    <section class="editor-grid">
      <form class="editor-card" method="POST" action="${uiHref(`/published/${siteId}/${slug}/save`)}">
        <h3>Redigera artikel</h3>
        <label class="field">
          <span>Titel</span>
          <input type="text" name="title" value="${escapeHtml(draft.title)}" required />
        </label>
        <label class="field">
          <span>Meta description</span>
          <textarea name="metaDescription" rows="3" required>${escapeHtml(draft.metaDescription ?? '')}</textarea>
        </label>
        <label class="field">
          <span>Kategori</span>
          <input type="text" name="category" value="${escapeHtml(draft.category ?? '')}" />
        </label>
        <label class="field">
          <span>Tags</span>
          <input type="text" name="tags" value="${escapeHtml(tags)}" />
        </label>
        <label class="field">
          <span>Body</span>
          <textarea name="body" rows="18" required>${escapeHtml(draft.body ?? '')}</textarea>
        </label>
        <div class="actions">
          <button type="submit" class="btn btn-success">Spara ändringar</button>
        </div>
      </form>

      <div class="editor-card preview-card">
        <h3>Förhandsvisning</h3>
        <div class="article-content">${bodyHtml}</div>
      </div>
    </section>

    <section class="danger-zone">
      <h3>Publiceringsstatus</h3>
      <p>Avpublicera om artikeln ska bort från sajten men sparas som utkast. Radera permanent om både live-versionen och draften ska bort.</p>
      <div class="actions">
        <form method="POST" action="${uiHref(`/published/${siteId}/${slug}/unpublish`)}">
          <button type="submit" class="btn btn-danger">Avpublicera artikel</button>
        </form>
        <form method="POST" action="${uiHref(`/published/${siteId}/${slug}/delete`)}">
          <button type="submit" class="btn btn-danger">Radera permanent</button>
        </form>
      </div>
    </section>
  `;

  res.send(renderLayout({
    title: `${draft.title} - Hantera publicerad artikel`,
    content,
  }));
});

router.post('/ui/draft/:siteId/:slug/approve', async (req, res) => {
  const { siteId, slug } = req.params;
  const draft = getDraft(siteId, slug);

  if (!draft) {
    return res.status(404).send('Draft not found');
  }

  try {
    await publishDraft(siteId, slug);
    res.redirect(uiHref('/published'));
  } catch (err) {
    console.error(`Failed to publish draft ${draft.title}:`, err.message);
    res.status(500).send(`Failed to publish draft: ${err.message}`);
  }
});

router.post('/ui/draft/:siteId/:slug/reject', (req, res) => {
  const { siteId, slug } = req.params;
  const draft = getDraft(siteId, slug);

  if (!draft) {
    return res.status(404).send('Draft not found');
  }

  const success = updateDraftStatus(draft.filepath, 'rejected');
  res.redirect(success ? uiHref('/') : `${uiHref('/')}?error=reject`);
});

router.post('/ui/draft/:siteId/:slug/delete', async (req, res) => {
  const { siteId, slug } = req.params;

  try {
    await deleteDraft(siteId, slug);
    res.redirect(uiHref('/'));
  } catch (err) {
    console.error(`Failed to permanently delete draft ${slug}:`, err.message);
    res.status(500).send(`Failed to permanently delete draft: ${err.message}`);
  }
});

router.post('/ui/published/:siteId/:slug/save', async (req, res) => {
  const { siteId, slug } = req.params;

  try {
    await updatePublishedDraft(siteId, slug, {
      title: req.body.title,
      metaDescription: req.body.metaDescription,
      category: req.body.category,
      tags: String(req.body.tags || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      body: req.body.body,
    });
    res.redirect(uiHref(`/published/${siteId}/${slug}`));
  } catch (err) {
    console.error(`Failed to update published draft ${slug}:`, err.message);
    res.status(500).send(`Failed to update published article: ${err.message}`);
  }
});

router.post('/ui/published/:siteId/:slug/unpublish', async (req, res) => {
  const { siteId, slug } = req.params;

  try {
    await unpublishDraft(siteId, slug);
    res.redirect(uiHref('/'));
  } catch (err) {
    console.error(`Failed to unpublish draft ${slug}:`, err.message);
    res.status(500).send(`Failed to unpublish article: ${err.message}`);
  }
});

router.post('/ui/published/:siteId/:slug/delete', async (req, res) => {
  const { siteId, slug } = req.params;

  try {
    await deleteDraft(siteId, slug);
    res.redirect(uiHref('/published'));
  } catch (err) {
    console.error(`Failed to permanently delete draft ${slug}:`, err.message);
    res.status(500).send(`Failed to permanently delete article: ${err.message}`);
  }
});

app.use(BASE_PATH || '/', router);

if (BASE_PATH) {
  app.get('/', (req, res) => {
    res.redirect(uiHref('/'));
  });
}

app.listen(PORT, () => {
  startScheduler();
  console.log(`
SEO-Hub running at http://localhost:${PORT}${uiHref('/').replace(BASE_PATH, '') || '/'}
`);
  console.log(`[article-generator] Base path: ${BASE_PATH || '/'}`);
});
