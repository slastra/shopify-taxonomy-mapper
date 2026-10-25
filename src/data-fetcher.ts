import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { errMessage } from './errors.js';

const GITHUB_REPO = 'Shopify/product-taxonomy';
// Pinned to a stable release: `main` carries the unstable taxonomy, whose IDs can
// change before release and may not exist in Shopify's live taxonomy yet. When
// bumping, migrate cached IDs with dist/en/integrations/shopify/*_to_* mappings.
const TAXONOMY_RELEASE = 'v2026-08';
const DATA_FILE_PATH = 'dist/en/categories.json';
const LOCAL_DATA_PATH = join(import.meta.dirname, '../data/categories.json');

const REMOTE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${TAXONOMY_RELEASE}/${DATA_FILE_PATH}`;

// categories.json's "version" field for the pinned release ("v2026-08" → "2026-08").
const PINNED_VERSION = TAXONOMY_RELEASE.replace(/^v/, '');

/** The local file's version, read from its first bytes ("version" is the first key). */
async function readLocalVersion(): Promise<string | null> {
  try {
    const head = await Bun.file(LOCAL_DATA_PATH).slice(0, 512).text();
    return /"version"\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fetchRemote(): Promise<{ text: string; version: string }> {
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
    const { version } = JSON.parse(text) as { version?: string };
    if (!version) {
      throw new Error('Remote taxonomy data missing version field');
    }
    return { text, version };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make sure data/categories.json holds the pinned taxonomy release. The release
 * never changes, so a matching local file means no network call at all.
 */
export class DataFetcher {
  async ensureTaxonomyData(): Promise<void> {
    console.log('Checking taxonomy data...');
    const localVersion = await readLocalVersion();
    if (localVersion === PINNED_VERSION) {
      console.log(`✓ Local taxonomy is the pinned release (${PINNED_VERSION})`);
      return;
    }

    console.log(localVersion
      ? `Local taxonomy is ${localVersion}; downloading pinned release ${TAXONOMY_RELEASE}...`
      : `Downloading taxonomy release ${TAXONOMY_RELEASE}...`);
    let remote: { text: string; version: string };
    try {
      remote = await fetchRemote();
    } catch (error) {
      if (localVersion) {
        console.warn(`⚠ GitHub unavailable, using local taxonomy ${localVersion}:`, errMessage(error));
        return;
      }
      throw new Error(
        'Taxonomy data not available: GitHub is unreachable and no local copy exists. ' +
        'Please check your internet connection or manually download categories.json from: ' +
        `https://github.com/${GITHUB_REPO}/blob/${TAXONOMY_RELEASE}/${DATA_FILE_PATH}`,
      );
    }

    await mkdir(dirname(LOCAL_DATA_PATH), { recursive: true });
    await writeFile(LOCAL_DATA_PATH, remote.text, 'utf-8');
    console.log(`✓ Taxonomy ${remote.version} downloaded`);
  }
}
