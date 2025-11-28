export interface ModelConfig {
  id: string;
  name: string;
}

export const AVAILABLE_MODELS: ModelConfig[] = [
  { id: 'gpt-5.1-codex',      name: 'GPT-5.1 Codex' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
  { id: 'gpt-5.1',            name: 'GPT-5.1' },
  { id: 'gpt-5',              name: 'GPT-5' },
  { id: 'gpt-5-mini',         name: 'GPT-5 Mini' },        
  { id: 'gpt-5-nano',         name: 'GPT-5 Nano' },        
  { id: 'gpt-4.1',            name: 'GPT-4.1' },
  { id: 'gpt-4.1-mini',       name: 'GPT-4.1 Mini' },
  { id: 'gpt-4.1-nano',       name: 'GPT-4.1 Nano' },
];

export const DEFAULT_MODEL = 'gpt-5.1-codex';

export type ModelId = (typeof AVAILABLE_MODELS)[number]['id'];
