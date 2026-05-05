import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const RUNS_ROOT = resolve('.local', 'runs');

function nowIso() {
  return new Date().toISOString();
}

function safeSiteId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function createRunLedger(siteId, metadata = {}) {
  const safeId = safeSiteId(siteId);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = join(RUNS_ROOT, safeId);
  const filepath = join(runDir, `${runId}.json`);
  const run = {
    schemaVersion: 1,
    runId,
    siteId,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    metadata,
    summary: {
      candidates: 0,
      selected: 0,
      rejected: 0,
      duplicates: 0,
      generated: 0,
      failed: 0
    },
    decisions: [],
    generatedDrafts: []
  };

  function save() {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(filepath, `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
  }

  save();

  return {
    run,
    filepath,
    recordDecision(decision) {
      const entry = {
        decidedAt: nowIso(),
        ...decision
      };
      run.decisions.push(entry);
      run.summary.candidates = run.decisions.length;
      run.summary.selected = run.decisions.filter((item) => item.decision === 'selected').length;
      run.summary.rejected = run.decisions.filter((item) => item.decision === 'rejected').length;
      run.summary.duplicates = run.decisions.filter((item) => item.decision === 'duplicate').length;
      save();
      return entry;
    },
    recordGenerated(draft, filepathForDraft) {
      run.generatedDrafts.push({
        title: draft.title,
        slug: draft.slug,
        siteId: draft.siteId,
        filepath: filepathForDraft,
        trendTopic: draft.trendTopic,
        preferredKeyword: draft.preferredKeyword,
        generatedAt: draft.generatedAt || nowIso()
      });
      run.summary.generated = run.generatedDrafts.length;
      save();
    },
    recordFailure(topic, error) {
      run.summary.failed += 1;
      run.decisions.push({
        decidedAt: nowIso(),
        sourceStage: 'generation',
        decision: 'failed',
        topic: topic?.topic || String(topic || ''),
        source: topic?.source || '',
        score: topic?.score ?? null,
        reason: error instanceof Error ? error.message : String(error)
      });
      save();
    },
    finish(status = 'ok', error = null) {
      run.status = status;
      run.finishedAt = nowIso();
      run.error = error ? (error instanceof Error ? error.message : String(error)) : null;
      save();
    }
  };
}

export function readRuns(siteId, limit = 20) {
  const runDir = join(RUNS_ROOT, safeSiteId(siteId));
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const filepath = join(runDir, file);
      try {
        return { ...JSON.parse(readFileSync(filepath, 'utf-8')), filepath };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0))
    .slice(0, limit);
}
