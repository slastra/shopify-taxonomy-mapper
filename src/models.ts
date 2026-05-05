// Bedrock cross-region inference profile IDs. Add new entries here, not as
// inline string literals elsewhere — eval scripts and the runtime client both
// reference this map.
export const MODEL_IDS = {
  novaMicro:    'us.amazon.nova-micro-v1:0',
  novaLite:     'us.amazon.nova-lite-v1:0',
  novaPro:      'us.amazon.nova-pro-v1:0',
  nova2Lite:    'us.amazon.nova-2-lite-v1:0',
  claude3Haiku: 'us.anthropic.claude-3-haiku-20240307-v1:0',
  haiku45:      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
} as const;

export type ModelId = typeof MODEL_IDS[keyof typeof MODEL_IDS];

export const DEFAULT_MODEL_ID: ModelId = MODEL_IDS.novaMicro;
