import { writeFile, readFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { errMessage } from './errors.js';

const GITHUB_REPO = 'Shopify/product-taxonomy';
const GITHUB_BRANCH = 'main';
const DATA_FILE_PATH = 'dist/en/categories.json';
const LOCAL_DATA_PATH = join(import.meta.dirname, '../data/categories.json');

const REMOTE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${DATA_FILE_PATH}`;

interface TaxonomyData {
  version: string;
  [key: string]: unknown;
}

async function readLocal(): Promise<TaxonomyData | null> {
  try {
    const text = await readFile(LOCAL_DATA_PATH, 'utf-8');
    return JSON.parse(text) as TaxonomyData;
  } catch {
    return null;
  }
}

async function fetchRemote(): Promise<{ text: string; data: TaxonomyData }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(REMOTE_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}: ${response.statusText}`);
    }
    const text = await response.text();
    const data = JSON.parse(text) as TaxonomyData;
    if (!data.version) {
      throw new Error('Remote taxonomy data missing version field');
    }
    return { text, data };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch taxonomy data from Shopify's GitHub repo with version-aware caching.
 * Single fetch of the remote body — if version differs from local, the same body
 * is written to disk (no re-download).
 */
export class DataFetcher {
  async ensureTaxonomyData(): Promise<void> {
    console.log('Checking taxonomy data...');
    const local = await readLocal();
    if (local) {
      console.log(`✓ Local taxonomy found (version ${local.version})`);
    }

    let remote: { text: string; data: TaxonomyData };
    try {
      remote = await fetchRemote();
      console.log(`✓ Remote taxonomy version: ${remote.data.version}`);
    } catch (error) {
      if (local) {
        console.warn('⚠ GitHub unavailable, using cached version:', local.version);
        console.warn('  Error:', errMessage(error));
        return;
      }
      throw new Error(
        'Taxonomy data not available: GitHub is unreachable and no cached version exists. ' +
        'Please check your internet connection or manually download categories.json from: ' +
        `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${DATA_FILE_PATH}`,
      );
    }

    if (local && local.version === remote.data.version) {
      console.log('✓ Local taxonomy is up-to-date');
      return;
    }

    console.log(`Downloading taxonomy data (${remote.data.version})...`);
    await mkdir(dirname(LOCAL_DATA_PATH), { recursive: true });
    await writeFile(LOCAL_DATA_PATH, remote.text, 'utf-8');
    console.log('✓ Taxonomy data downloaded successfully');
  }
}
