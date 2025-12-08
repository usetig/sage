export interface ModelOption {
  id: string; // provider/model
  label: string;
}

export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export const FALLBACK_MODELS: ModelOption[] = [
  { id: 'openai/gpt-4o-mini', label: 'OpenAI • gpt-4o-mini' },
  { id: 'openai/gpt-4o', label: 'OpenAI • gpt-4o' },
  { id: 'anthropic/claude-3-5-sonnet-20241022', label: 'Anthropic • Claude 3.5 Sonnet (2024-10-22)' },
  { id: 'openai/gpt-5.1-codex', label: 'OpenAI • GPT 5.1 Codex' },
  { id: 'anthropic/claude-opus-4.5', label: 'Anthropic • Opus 4.5' },
  { id: 'google/gemini-3-pro', label: 'Google • Gemini 3.0' },
];

export type ModelId = (typeof FALLBACK_MODELS)[number]['id'];

export function buildModelOptionsFromProviders(providers: any[]): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of providers ?? []) {
    const providerId = provider?.id ?? provider?.providerId ?? provider?.providerID;
    const models = provider?.models ?? [];
    if (!providerId || !Array.isArray(models)) continue;
    for (const model of models) {
      const modelId = model?.id ?? model?.modelId ?? model?.modelID;
      if (!modelId) continue;
      const full = `${providerId}/${modelId}`;
      const name = model?.name ?? modelId;
      options.push({ id: full, label: `${providerId} • ${name}` });
    }
  }
  return options;
}
