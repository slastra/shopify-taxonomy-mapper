const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
// Pinned: answers drift between Jev versions. Re-run `bun run eval` before moving it.
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.14';

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

/** An option's description: a plain string, or a JSON object the model reads as structure. */
export type Criterion = string | Record<string, unknown>;

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option name → description. Option names are shown to the model and come back as `choice`. */
  criteria: Record<string, Criterion>;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface DecisionResponse {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost: number };
}

export interface JevConfig {
  apiKey?: string;
  model?: string;
}

/**
 * Client for TypeSafe's Jev decision model via OpenRouter's Decisions API.
 * Stateless: every call is one independent request, so it is safe to share
 * across concurrent mappings.
 */
export class JevClient {
  private apiKey: string;
  private model: string;

  constructor(config: JevConfig = {}) {
    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OpenRouter API key is required. Set the OPENROUTER_API_KEY environment variable.');
    }
    this.apiKey = apiKey;
    this.model = config.model || process.env.JEV_MODEL || DEFAULT_JEV_MODEL;
  }

  /**
   * Ask several choice questions against one state in a single request. Jev
   * evaluates them in parallel, so N questions cost about what one does.
   */
  async decide(state: Record<string, unknown>, questions: Record<string, ChoiceQuestion>): Promise<DecisionResponse> {
    const body = JSON.stringify({ model: this.model, state, questions });

    for (let attempt = 1; ; attempt++) {
      const response = await fetch(DECISIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        return await response.json() as DecisionResponse;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new Error(`Jev request failed (${response.status}): ${await response.text()}`);
      }
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }

  getModelId(): string {
    return this.model;
  }
}
