import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { getSite, resolveEnv, resolveProjectPath } from '../lib/config.mjs';

function readDraft(siteId, slug) {
  const filepath = resolve(resolveProjectPath('.local/drafts'), siteId, `${slug}.json`);

  if (!existsSync(filepath)) {
    throw new Error(`Draft not found: ${filepath}`);
  }

  return {
    filepath,
    draft: JSON.parse(readFileSync(filepath, 'utf-8'))
  };
}

function deleteDraftFile(filepath) {
  if (existsSync(filepath)) {
    unlinkSync(filepath);
  }
}

function updateDraftFile(filepath, updates) {
  const current = JSON.parse(readFileSync(filepath, 'utf-8'));
  const nextDraft = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString()
  };

  writeFileSync(filepath, JSON.stringify(nextDraft, null, 2), 'utf-8');
  return nextDraft;
}

function stripLeadingH1(body = '') {
  return body.replace(/^#\s+.+\n+/, '').trim();
}

function estimateReadingTime(body = '') {
  const words = body.split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / 220))} min läsning`;
}

function getPublishConfig(siteConfig) {
  const publishUrl = resolveEnv(siteConfig.publishUrl);
  const publishSecret = resolveEnv(siteConfig.revalidateSecret);

  if (!publishUrl || !publishSecret) {
    throw new Error('Missing publishUrl or publish secret in site config');
  }

  return { publishUrl, publishSecret };
}

function buildArticlePayload(draft, siteConfig, overrides = {}) {
  const normalizedBody = stripLeadingH1(overrides.body ?? draft.body ?? '');
  const tags = Array.isArray(overrides.tags ?? draft.tags) ? (overrides.tags ?? draft.tags) : [];
  const category = overrides.category ?? draft.category ?? tags[0] ?? 'Artikel';
  const readingTime = overrides.readingTime ?? draft.readingTime ?? estimateReadingTime(normalizedBody);
  const siteKey = siteConfig.targetSite || siteConfig.siteKey || siteConfig.id;

  return {
    title: overrides.title ?? draft.title,
    slug: draft.slug,
    description: overrides.metaDescription ?? draft.metaDescription ?? '',
    category,
    date: draft.date || new Date().toISOString().slice(0, 10),
    readingTime,
    body: normalizedBody,
    tags,
    site: siteKey,
    source: 'seo-hub'
  };
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

async function publishToSite(siteConfig, payload) {
  const { publishUrl, publishSecret } = getPublishConfig(siteConfig);

  return requestJson(publishUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-publish-secret': publishSecret
    },
    body: JSON.stringify(payload)
  });
}

async function unpublishFromSite(siteConfig, slug) {
  const { publishUrl, publishSecret } = getPublishConfig(siteConfig);
  const siteKey = siteConfig.targetSite || siteConfig.siteKey || siteConfig.id;

  return requestJson(publishUrl, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-publish-secret': publishSecret
    },
    body: JSON.stringify({ slug, site: siteKey })
  });
}

async function deleteFromSite(siteConfig, slug) {
  const { publishUrl, publishSecret } = getPublishConfig(siteConfig);
  const siteKey = siteConfig.targetSite || siteConfig.siteKey || siteConfig.id;
  const url = new URL(publishUrl);
  url.searchParams.set('slug', slug);
  url.searchParams.set('site', siteKey);

  return requestJson(url, {
    method: 'DELETE',
    headers: {
      'x-publish-secret': publishSecret
    }
  });
}

function getPublishedUrl(draft) {
  return `https://sebcastwall.se/artiklar/${draft.slug}`;
}

export async function publishDraft(siteId, slug) {
  const siteConfig = getSite(siteId);
  const { filepath, draft } = readDraft(siteId, slug);
  const payload = buildArticlePayload(draft, siteConfig);

  await publishToSite(siteConfig, payload);

  updateDraftFile(filepath, {
    status: 'published',
    publishedAt: new Date().toISOString(),
    publishedPath: getPublishedUrl(draft),
    readingTime: payload.readingTime,
    category: payload.category,
    tags: payload.tags,
    body: payload.body,
    metaDescription: payload.description
  });

  return {
    alreadyPublished: false,
    publishedPath: getPublishedUrl(draft)
  };
}

export async function updatePublishedDraft(siteId, slug, updates) {
  const siteConfig = getSite(siteId);
  const { filepath, draft } = readDraft(siteId, slug);

  if (draft.status !== 'published') {
    throw new Error('Draft is not published');
  }

  const nextDraft = updateDraftFile(filepath, {
    title: updates.title ?? draft.title,
    metaDescription: updates.metaDescription ?? draft.metaDescription,
    category: updates.category ?? draft.category,
    tags: updates.tags ?? draft.tags,
    body: updates.body ?? draft.body
  });

  const payload = buildArticlePayload(nextDraft, siteConfig, updates);
  await publishToSite(siteConfig, payload);

  updateDraftFile(filepath, {
    readingTime: payload.readingTime,
    category: payload.category,
    tags: payload.tags,
    body: payload.body,
    metaDescription: payload.description,
    publishedPath: getPublishedUrl(nextDraft)
  });

  return { publishedPath: getPublishedUrl(nextDraft) };
}

export async function unpublishDraft(siteId, slug) {
  const siteConfig = getSite(siteId);
  const { filepath, draft } = readDraft(siteId, slug);

  if (draft.status !== 'published') {
    throw new Error('Draft is not published');
  }

  await unpublishFromSite(siteConfig, slug);

  updateDraftFile(filepath, {
    status: 'pending',
    publishedAt: null,
    publishedPath: null
  });

  return { unpublished: true };
}

export async function deleteDraft(siteId, slug) {
  const siteConfig = getSite(siteId);
  const { filepath, draft } = readDraft(siteId, slug);

  if (draft.status === 'published') {
    await deleteFromSite(siteConfig, slug);
  }

  deleteDraftFile(filepath);

  return { deleted: true };
}
