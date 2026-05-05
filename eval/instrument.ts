import { NovaLiteClient } from '../src/nova-client.js';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Wrap a NovaLiteClient.converse so each call appends a TurnUsage entry to the
 * returned array. The returned `reset` empties that array between mappings.
 */
export function trackTokens(client: NovaLiteClient): { turns: TurnUsage[]; reset: () => void } {
  const turns: TurnUsage[] = [];
  const orig = client.converse.bind(client);
  client.converse = async (...args) => {
    const r = await orig(...args);
    turns.push({
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadInputTokens || 0,
      cacheWriteTokens: r.usage.cacheWriteInputTokens || 0,
    });
    return r;
  };
  return { turns, reset: () => { turns.length = 0; } };
}
