import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { DEFAULT_MODEL } from './models.js';

export interface SageSettings {
  selectedModel: string;
  debugMode: boolean;
}

const DEFAULT_SETTINGS: SageSettings = {
  selectedModel: DEFAULT_MODEL,
  debugMode: false,
};

/**
 * Get the global settings file path.
 * Returns ~/.sage/settings.json
 */
export function getSettingsPath(): string {
  return path.join(os.homedir(), '.sage', 'settings.json');
}

/**
 * Load settings from disk.
 * Returns default settings if file doesn't exist or is invalid.
 */
export async function loadSettings(): Promise<SageSettings> {
  try {
    const settingsPath = getSettingsPath();
    const content = await fs.readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(content);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save settings to disk.
 */
export async function saveSettings(settings: SageSettings): Promise<void> {
  const settingsPath = getSettingsPath();
  const dir = path.dirname(settingsPath);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
}
