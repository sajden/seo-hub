import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = join(__dirname, '../config.json');
const projectRoot = join(__dirname, '..');

let cachedConfig = null;
let envLoaded = false;

function loadLocalEnvFile(filename) {
  const filePath = join(projectRoot, filename);

  if (!existsSync(filePath)) {
    return;
  }

  const raw = readFileSync(filePath, 'utf-8');

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function ensureLocalEnvLoaded() {
  if (envLoaded) {
    return;
  }

  loadLocalEnvFile('.env');
  loadLocalEnvFile('.env.local');
  envLoaded = true;
}

/**
 * Load and parse config.json
 * @returns {Object} Parsed configuration
 */
export function loadConfig() {
  ensureLocalEnvLoaded();

  if (!cachedConfig) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      cachedConfig = JSON.parse(raw);
      validateConfig(cachedConfig);
    } catch (err) {
      throw new Error(`Failed to load config: ${err.message}`);
    }
  }
  return cachedConfig;
}

/**
 * Get a specific site configuration by ID
 * @param {string} siteId - Site identifier
 * @returns {Object|null} Site config or null if not found
 */
export function getSite(siteId) {
  const config = loadConfig();
  const site = config.sites.find(s => s.id === siteId);

  if (!site) {
    throw new Error(`Site '${siteId}' not found in config`);
  }

  return site;
}

/**
 * Get all site IDs
 * @returns {string[]} Array of site IDs
 */
export function getAllSiteIds() {
  const config = loadConfig();
  return config.sites.map(s => s.id);
}

/**
 * Validate config structure
 * @param {Object} config - Configuration object to validate
 */
function validateConfig(config) {
  if (!config.sites || !Array.isArray(config.sites)) {
    throw new Error('Config must have a "sites" array');
  }

  for (const site of config.sites) {
    const required = ['id', 'niche', 'targetRepo', 'contentPath', 'seedKeywords'];
    for (const field of required) {
      if (!site[field]) {
        throw new Error(`Site config missing required field: ${field}`);
      }
    }
  }
}

/**
 * Resolve environment variable references in config values
 * Example: "env:AUTOWEB_SECRET" → process.env.AUTOWEB_SECRET
 * @param {string} value - Config value that might contain env reference
 * @returns {string} Resolved value
 */
export function resolveEnv(value) {
  ensureLocalEnvLoaded();

  if (typeof value === 'string' && value.startsWith('env:')) {
    const envVar = value.slice(4);
    return process.env[envVar] || '';
  }
  return value;
}

export function resolveProjectPath(relativePath) {
  if (isAbsolute(relativePath)) {
    return resolve(relativePath);
  }

  return join(__dirname, '..', relativePath);
}
