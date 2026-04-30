import { loadConfig, getSite } from './config.mjs';
import { readExistingDrafts } from './articles.mjs';
import { generateForSite } from '../generator/run.mjs';

const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DAY_LABELS = {
  sunday: 'söndag',
  monday: 'måndag',
  tuesday: 'tisdag',
  wednesday: 'onsdag',
  thursday: 'torsdag',
  friday: 'fredag',
  saturday: 'lördag',
};

const schedulerState = new Map();
const siteTimers = new Map();
let schedulerStarted = false;

function nowIso() {
  return new Date().toISOString();
}

function normalizeSchedule(site) {
  const fallback = { day: 'monday', time: '09:00' };
  const schedule = site.schedule ?? fallback;
  const day = String(schedule.day ?? fallback.day).toLowerCase();
  const time = String(schedule.time ?? fallback.time);
  const [hourRaw = '09', minuteRaw = '00'] = time.split(':');
  const hours = Number.parseInt(hourRaw, 10);
  const minutes = Number.parseInt(minuteRaw, 10);

  return {
    day: day === 'daily' || DAY_MAP[day] !== undefined ? day : fallback.day,
    hours: Number.isFinite(hours) ? hours : 9,
    minutes: Number.isFinite(minutes) ? minutes : 0,
  };
}

function formatScheduleLabel(site) {
  const schedule = normalizeSchedule(site);
  if (schedule.day === 'daily') {
    return `Varje dag ${String(schedule.hours).padStart(2, '0')}:${String(schedule.minutes).padStart(2, '0')}`;
  }

  return `Varje ${DAY_LABELS[schedule.day] ?? schedule.day} ${String(schedule.hours).padStart(2, '0')}:${String(schedule.minutes).padStart(2, '0')}`;
}

function computeNextRun(site, fromDate = new Date()) {
  const schedule = normalizeSchedule(site);
  const next = new Date(fromDate);
  next.setSeconds(0, 0);
  next.setHours(schedule.hours, schedule.minutes, 0, 0);

  if (schedule.day === 'daily') {
    if (next <= fromDate) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  let deltaDays = (DAY_MAP[schedule.day] - next.getDay() + 7) % 7;
  if (deltaDays === 0 && next <= fromDate) {
    deltaDays = 7;
  }

  next.setDate(next.getDate() + deltaDays);
  return next;
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function draftWasGeneratedToday(siteId) {
  const today = localDateKey();
  return readExistingDrafts(siteId).some((draft) => {
    const timestamp = draft.generatedAt ?? draft.updatedAt ?? draft.publishedAt ?? null;
    if (!timestamp) return false;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return false;
    return localDateKey(date) === today;
  });
}

function scheduledTimePassedToday(site) {
  const schedule = normalizeSchedule(site);
  if (schedule.day !== 'daily') return false;

  const now = new Date();
  const scheduled = new Date(now);
  scheduled.setSeconds(0, 0);
  scheduled.setHours(schedule.hours, schedule.minutes, 0, 0);
  return now >= scheduled;
}

function getInitialSiteState(siteId) {
  return {
    siteId,
    running: false,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    lastRunSlugs: [],
  };
}

function ensureSiteState(siteId) {
  if (!schedulerState.has(siteId)) {
    schedulerState.set(siteId, getInitialSiteState(siteId));
  }
  return schedulerState.get(siteId);
}

function clearSiteTimer(siteId) {
  const timer = siteTimers.get(siteId);
  if (timer) {
    clearTimeout(timer);
    siteTimers.delete(siteId);
  }
}

function scheduleSite(siteId) {
  const site = getSite(siteId);
  const state = ensureSiteState(siteId);
  const nextRun = computeNextRun(site);
  const delay = Math.max(nextRun.getTime() - Date.now(), 1000);

  clearSiteTimer(siteId);
  state.nextRunAt = nextRun.toISOString();

  const timer = setTimeout(() => {
    runSite(siteId, 'scheduled').catch((error) => {
      console.error(`[article-generator:scheduler] Scheduled run failed for ${siteId}:`, error.message);
    });
  }, delay);

  siteTimers.set(siteId, timer);
}

async function runSite(siteId, reason = 'manual') {
  const state = ensureSiteState(siteId);

  if (state.running) {
    return { siteId, skipped: true, reason: 'already_running' };
  }

  state.running = true;
  state.lastRunError = null;

  try {
    const drafts = await generateForSite(siteId);
    state.lastRunAt = nowIso();
    state.lastRunStatus = 'ok';
    state.lastRunSlugs = drafts.map((draft) => draft.slug);
    return { siteId, reason, drafts };
  } catch (error) {
    state.lastRunAt = nowIso();
    state.lastRunStatus = 'error';
    state.lastRunError = error.message;
    state.lastRunSlugs = [];
    throw error;
  } finally {
    state.running = false;
    scheduleSite(siteId);
  }
}

function getScheduleSummary() {
  const sites = loadConfig().sites ?? [];
  if (sites.length === 0) {
    return 'Inget schema konfigurerat';
  }

  const labels = Array.from(new Set(sites.map((site) => formatScheduleLabel(site))));
  if (labels.length === 1) {
    return labels[0];
  }

  return `${labels.length} scheman (${labels.join(', ')})`;
}

export function getSchedulerStatus() {
  const states = Array.from(schedulerState.values()).sort((a, b) => a.siteId.localeCompare(b.siteId));
  const nextRun = states
    .filter((state) => state.nextRunAt)
    .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))[0] ?? null;
  const lastRun = states
    .filter((state) => state.lastRunAt)
    .sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)))[0] ?? null;

  return {
    enabled: schedulerStarted,
    running: states.some((state) => state.running),
    scheduleSummary: getScheduleSummary(),
    nextRunAt: nextRun?.nextRunAt ?? null,
    lastRunAt: lastRun?.lastRunAt ?? null,
    lastRunStatus: lastRun?.lastRunStatus ?? null,
    lastRunSiteId: lastRun?.siteId ?? null,
    lastRunSlug: lastRun?.lastRunSlugs?.[0] ?? null,
    lastRunSlugs: lastRun?.lastRunSlugs ?? [],
    lastRunError: lastRun?.lastRunError ?? null,
    sites: states,
  };
}

export function startScheduler() {
  if (schedulerStarted) {
    return getSchedulerStatus();
  }

  const config = loadConfig();
  schedulerStarted = true;

  for (const site of config.sites ?? []) {
    ensureSiteState(site.id);
    scheduleSite(site.id);

    if (
      process.env.SEO_HUB_RUN_MISSED_DAILY_ON_START !== 'false'
      && scheduledTimePassedToday(site)
      && !draftWasGeneratedToday(site.id)
    ) {
      setTimeout(() => {
        runSite(site.id, 'missed_daily_startup').catch((error) => {
          console.error(`[article-generator:scheduler] Missed daily startup run failed for ${site.id}:`, error.message);
        });
      }, 1000);
    }
  }

  return getSchedulerStatus();
}

export async function triggerGeneration({ siteId = null, reason = 'manual' } = {}) {
  const config = loadConfig();
  const siteIds = siteId ? [siteId] : (config.sites ?? []).map((site) => site.id);
  const runs = [];

  for (const currentSiteId of siteIds) {
    runs.push(await runSite(currentSiteId, reason));
  }

  return {
    siteIds,
    runs,
    drafts: runs.flatMap((run) => run.drafts ?? []),
  };
}
