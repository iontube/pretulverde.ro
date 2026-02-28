#!/usr/bin/env node

/**
 * Auto-generate articles script for pretulverde.ro
 * - Reads keywords from keywords.json
 * - Generates 1 article per run from different categories (rotates daily)
 * - Updates keywords.json (moves to completed)
 * - Runs build and deploy
 * - Stops when no more keywords
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.join(__dirname, '..');

// Load .env file manually
async function loadEnv() {
  try {
    const envPath = path.join(projectDir, '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          process.env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
  } catch (e) {
    // .env file is optional
  }
}

await loadEnv();

// Config
const ARTICLES_PER_RUN = parseInt(process.env.ARTICLES_PER_RUN) || 1;
const KEYWORDS_FILE = path.join(projectDir, 'keywords.json');
const LOG_FILE = path.join(projectDir, 'generation.log');

// Logging
async function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  await fs.appendFile(LOG_FILE, logMessage);
}

// Get the full paths to node/npm/npx
const NODE_PATH = process.execPath;
const NODE_BIN_DIR = path.dirname(NODE_PATH);
const NPM_PATH = path.join(NODE_BIN_DIR, 'npm');
const NPX_PATH = path.join(NODE_BIN_DIR, 'npx');

// Run command and return promise
function runCommand(command, args, cwd) {
  let actualCommand = command;
  if (command === 'node') actualCommand = NODE_PATH;
  else if (command === 'npm') actualCommand = NPM_PATH;
  else if (command === 'npx') actualCommand = NPX_PATH;

  return new Promise((resolve, reject) => {
    const proc = spawn(actualCommand, args, {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        PATH: `${NODE_BIN_DIR}:${process.env.PATH || ''}`
      }
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// Select keywords from different categories (round-robin)
function selectFromDifferentCategories(keywords, count) {
  const byCategory = {};
  for (const kw of keywords) {
    const cat = kw.categorySlug;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(kw);
  }

  const categories = Object.keys(byCategory);
  const selected = [];

  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  let catIndex = dayOfYear % categories.length;

  while (selected.length < count && categories.length > 0) {
    const cat = categories[catIndex % categories.length];
    const catKeywords = byCategory[cat];

    if (catKeywords.length > 0) {
      selected.push(catKeywords.shift());
    }

    if (catKeywords.length === 0) {
      categories.splice(catIndex % categories.length, 1);
      if (categories.length === 0) break;
    } else {
      catIndex++;
    }
  }

  return selected;
}

// Check if enough time passed since last generation (min 2 days)
async function shouldRunToday() {
  try {
    const keywordsData = JSON.parse(await fs.readFile(KEYWORDS_FILE, 'utf-8'));
    const completed = keywordsData.completed || [];
    if (completed.length === 0) return true;

    const lastDate = completed
      .map(c => new Date(c.modifiedDate || c.date).getTime())
      .reduce((a, b) => Math.max(a, b), 0);

    const daysSinceLast = (Date.now() - lastDate) / (1000 * 60 * 60 * 24);
    // Randomize: skip if today, 50% chance if 1 day ago, always run if 2+ days
    if (daysSinceLast < 1) return false;
    // Post every day, skip only if already posted today
    return true;
  } catch {
    return true;
  }
}

// Generate stats.json with article count for the panou sync
async function generateStats() {
  const pagesDir = path.join(projectDir, 'src', 'pages');
  const publicDir = path.join(projectDir, 'public');
  const excludePages = new Set(['index', 'contact', 'cookies', 'privacy-policy', 'privacy', 'gdpr', 'sitemap', '404', 'about', 'terms']);

  const files = await fs.readdir(pagesDir);
  const articles = files.filter(f => {
    if (!f.endsWith('.astro')) return false;
    const name = f.replace('.astro', '');
    if (name.startsWith('[')) return false;
    if (excludePages.has(name)) return false;
    return true;
  });

  const stats = { articlesCount: articles.length, lastUpdated: new Date().toISOString() };
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, 'stats.json'), JSON.stringify(stats, null, 2));
  await log(`Stats generated: ${articles.length} articles`);
}

// Main
async function main() {
  // Check if we should run today (min 2 days between articles)
  if (!await shouldRunToday()) {
    console.log(`[${new Date().toISOString()}] Skipping - last article was less than 2 days ago`);
    process.exit(0);
  }

  await log('='.repeat(60));
  await log('AUTO-GENERATE STARTED - pretulverde.ro');
  await log('='.repeat(60));

  // Read keywords
  let keywordsData;
  try {
    const content = await fs.readFile(KEYWORDS_FILE, 'utf-8');
    keywordsData = JSON.parse(content);
  } catch (error) {
    await log(`ERROR: Could not read keywords.json: ${error.message}`);
    process.exit(1);
  }

  const pendingKeywords = keywordsData.pending || [];

  if (pendingKeywords.length === 0) {
    await log('No more keywords to process. Stopping.');
    await log('Consider removing the cron job as all keywords are completed.');
    process.exit(0);
  }

  await log(`Pending keywords: ${pendingKeywords.length}`);
  await log(`Will generate: ${Math.min(ARTICLES_PER_RUN, pendingKeywords.length)} article(s)`);

  // Select keywords from different categories
  const toProcess = selectFromDifferentCategories([...pendingKeywords], Math.min(ARTICLES_PER_RUN, pendingKeywords.length));

  await log(`Selected keywords: ${toProcess.map(k => `${k.keyword} (${k.category})`).join(', ')}`);

  // Create temp config for generate-batch.js
  const tempConfigPath = path.join(projectDir, 'temp-articles.json');
  await fs.writeFile(tempConfigPath, JSON.stringify({
    articles: toProcess.map(kw => ({
      keyword: kw.keyword,
      category: kw.category,
      categorySlug: kw.categorySlug,
      pubDate: kw.pubDate,
      modifiedDate: kw.modifiedDate
    }))
  }, null, 2));

  await log('Generating articles...');

  // Run the generation script
  try {
    await runCommand('node', ['scripts/generate-batch.js'], projectDir);
    await log('Articles generated successfully');
  } catch (error) {
    await log(`ERROR generating articles: ${error.message}`);
    process.exit(1);
  }

  // Read successful keywords
  const successfulKeywordsPath = path.join(projectDir, 'successful-keywords.json');
  let successfulKeywordsFull = [];
  try {
    const successContent = await fs.readFile(successfulKeywordsPath, 'utf-8');
    successfulKeywordsFull = JSON.parse(successContent);
  } catch (e) {
    await log('Warning: Could not read successful keywords');
  }

  const successfulKeywordNames = successfulKeywordsFull.map(k => k.keyword);
  const failedToProcess = toProcess.filter(kw => !successfulKeywordNames.includes(kw.keyword));

  const processedKeywordNames = toProcess.map(k => k.keyword);
  keywordsData.pending = pendingKeywords.filter(kw => !processedKeywordNames.includes(kw.keyword));
  keywordsData.pending = [...keywordsData.pending, ...failedToProcess];
  keywordsData.completed = [...(keywordsData.completed || []), ...successfulKeywordsFull];

  await fs.writeFile(KEYWORDS_FILE, JSON.stringify(keywordsData, null, 2));
  await log(`Keywords updated. Generated: ${successfulKeywordsFull.length}, Failed: ${failedToProcess.length}, Remaining: ${keywordsData.pending.length}`);

  // Skip build and deploy if no articles were generated
  if (successfulKeywordsFull.length === 0) {
    await log('No articles generated successfully. Skipping build and deploy.');
    await log('='.repeat(60));
    await log('AUTO-GENERATE COMPLETED (NO NEW ARTICLES)');
    await log(`Remaining keywords: ${keywordsData.pending.length}`);
    await log('='.repeat(60));

    try {
      await fs.unlink(tempConfigPath);
      await fs.unlink(successfulKeywordsPath);
    } catch (e) {}

    return;
  }

  // Generate stats.json before build
  await generateStats();

  // Build
  await log('Building site...');
  try {
    await runCommand('npm', ['run', 'build'], projectDir);
    await log('Build completed');
  } catch (error) {
    await log(`ERROR building: ${error.message}`);
    process.exit(1);
  }

  // Deploy to Cloudflare (with retry for transient errors)
  const projectName = process.env.CLOUDFLARE_PROJECT_NAME || 'pretulverde-ro';
  const MAX_DEPLOY_RETRIES = 3;
  let deploySuccess = false;
  for (let attempt = 1; attempt <= MAX_DEPLOY_RETRIES; attempt++) {
    await log(`Deploying to Cloudflare (project: ${projectName})... attempt ${attempt}/${MAX_DEPLOY_RETRIES}`);
    try {
      await runCommand('npx', ['wrangler', 'pages', 'deploy', 'dist', '--project-name', projectName], projectDir);
      await log('Deploy completed');
      deploySuccess = true;
      break;
    } catch (error) {
      await log(`Deploy attempt ${attempt} failed: ${error.message}`);
      if (attempt < MAX_DEPLOY_RETRIES) {
        const waitSec = attempt * 30;
        await log(`Waiting ${waitSec}s before retry...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      }
    }
  }
  if (!deploySuccess) {
    await log('ERROR: All deploy attempts failed');
    process.exit(1);
  }

  // Cleanup
  try {
    await fs.unlink(tempConfigPath);
    await fs.unlink(successfulKeywordsPath);
  } catch (e) {}
  try {
    await fs.unlink(path.join(projectDir, 'generation-results.json'));
  } catch (e) {}

  await log('='.repeat(60));
  await log('AUTO-GENERATE COMPLETED SUCCESSFULLY');
  await log(`Remaining keywords: ${keywordsData.pending.length}`);
  if (keywordsData.pending.length === 0) {
    await log('All keywords processed! Consider removing the cron job.');
  }
  await log('='.repeat(60));
}

main().catch(async (error) => {
  await log(`FATAL ERROR: ${error.message}`);
  process.exit(1);
});
