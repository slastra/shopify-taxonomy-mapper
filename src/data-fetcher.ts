import { writeFile, readFile, exists } from 'fs/promises';
import { join } from 'path';

const GITHUB_REPO = 'Shopify/product-taxonomy';
const GITHUB_BRANCH = 'main';
const DATA_FILE_PATH = 'dist/en/categories.json';
const LOCAL_DATA_PATH = join(import.meta.dirname, '../data/categories.json');

interface TaxonomyData {
  version: string;
  [key: string]: unknown;
}

/**
 * Fetch taxonomy data from Shopify's GitHub repository
 * Implements smart caching with version checking
 */
export class DataFetcher {
  /**
   * Ensure taxonomy data is available and up-to-date
   * Downloads from GitHub if needed, falls back to cached version
   */
  async ensureTaxonomyData(): Promise<void> {
    console.log('Checking taxonomy data...');

    try {
      // Check if local file exists
      const localExists = await exists(LOCAL_DATA_PATH);
      let localVersion: string | null = null;

      if (localExists) {
        try {
          const localData = await readFile(LOCAL_DATA_PATH, 'utf-8');
          const parsed = JSON.parse(localData) as TaxonomyData;
          localVersion = parsed.version;
          console.log(`✓ Local taxonomy found (version ${localVersion})`);
        } catch (error) {
          console.warn('⚠ Local taxonomy file corrupted, will re-download');
        }
      }

      // Try to fetch latest version info from GitHub
      try {
        const remoteVersion = await this.getRemoteVersion();
        console.log(`✓ Remote taxonomy version: ${remoteVersion}`);

        // Download if we don't have it or if version is different
        if (!localVersion || localVersion !== remoteVersion) {
          console.log(`Downloading taxonomy data (${remoteVersion})...`);
          await this.downloadTaxonomyData();
          console.log('✓ Taxonomy data downloaded successfully');
          return;
        } else {
          console.log('✓ Local taxonomy is up-to-date');
          return;
        }
      } catch (error) {
        // GitHub unavailable - fall back to cached version
        if (localExists && localVersion) {
          console.warn('⚠ GitHub unavailable, using cached version:', localVersion);
          console.warn('  Error:', error instanceof Error ? error.message : String(error));
          return;
        } else {
          // No cached version and GitHub unavailable - cannot continue
          throw new Error(
            'Taxonomy data not available: GitHub is unreachable and no cached version exists. ' +
            'Please check your internet connection or manually download categories.json from: ' +
            `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${DATA_FILE_PATH}`
          );
        }
      }
    } catch (error) {
      throw new Error(`Failed to ensure taxonomy data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the version of the remote taxonomy data without downloading the full file
   */
  private async getRemoteVersion(): Promise<string> {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${DATA_FILE_PATH}`;

    // Fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub returned ${response.status}: ${response.statusText}`);
      }

      // Read just enough to get the version field (first ~200 bytes should be plenty)
      const text = await response.text();
      const data = JSON.parse(text) as TaxonomyData;

      if (!data.version) {
        throw new Error('Remote taxonomy data missing version field');
      }

      return data.version;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Download the full taxonomy data file from GitHub
   */
  private async downloadTaxonomyData(): Promise<void> {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${DATA_FILE_PATH}`;

    // Fetch with longer timeout for full file (30MB)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.text();

      // Validate JSON before writing
      const parsed = JSON.parse(data) as TaxonomyData;
      if (!parsed.version) {
        throw new Error('Downloaded data missing version field');
      }

      // Write to local file
      await writeFile(LOCAL_DATA_PATH, data, 'utf-8');
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get the current local taxonomy version
   */
  async getLocalVersion(): Promise<string | null> {
    try {
      const localExists = await exists(LOCAL_DATA_PATH);
      if (!localExists) return null;

      const data = await readFile(LOCAL_DATA_PATH, 'utf-8');
      const parsed = JSON.parse(data) as TaxonomyData;
      return parsed.version || null;
    } catch (error) {
      return null;
    }
  }
}
