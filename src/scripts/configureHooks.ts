import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

// Get the Sage package root directory (where sage is installed)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// From dist/scripts/ or src/scripts/, go up twice to reach package root
const SAGE_ROOT = path.resolve(__dirname, '..', '..');

// Hook command uses absolute path to compiled JS (works for both dev and npm install)
const HOOK_COMMAND = `node "${path.join(SAGE_ROOT, 'dist/hooks/sageHook.js')}"`;
const TARGET_EVENTS = ['SessionStart', 'Stop', 'UserPromptSubmit'] as const;

export interface HookConfigResult {
  configured: boolean;
  alreadyConfigured: boolean;
}

/**
 * Ensures Sage hooks are configured in .claude/settings.local.json
 * Non-destructive: preserves existing hooks, only adds Sage hooks if missing
 */
export async function ensureHooksConfigured(): Promise<HookConfigResult> {
  const settingsDir = path.join(process.cwd(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.local.json');

  await fs.mkdir(settingsDir, { recursive: true });

  let raw: string | null = null;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  let settings: any = raw ? JSON.parse(raw) : {};
  if (!settings || typeof settings !== 'object') settings = {};
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  let anyAdded = false;

  for (const event of TARGET_EVENTS) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];

    // Find index of any existing Sage hook entry (by looking for sageHook.ts in command)
    const sageEntryIndex = existing.findIndex((entry: any) =>
      entry &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook: any) => hook && hook.type === 'command' && typeof hook.command === 'string' && hook.command.includes('sageHook'),
      ),
    );

    const correctHookEntry = {
      hooks: [
        {
          type: 'command',
          command: HOOK_COMMAND,
          timeout: 30,
        },
      ],
    };

    if (sageEntryIndex === -1) {
      // No Sage hook exists, add one
      existing.push(correctHookEntry);
      anyAdded = true;
    } else {
      // Sage hook exists - check if it needs updating
      const currentEntry = existing[sageEntryIndex];
      const currentCommand = currentEntry?.hooks?.[0]?.command;
      if (currentCommand !== HOOK_COMMAND) {
        // Update to correct path
        existing[sageEntryIndex] = correctHookEntry;
        anyAdded = true;
      }
    }

    settings.hooks[event] = existing;
  }

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}${os.EOL}`, 'utf8');

  return {
    configured: true,
    alreadyConfigured: !anyAdded,
  };
}

// Allow running as standalone script for manual configuration
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  ensureHooksConfigured()
    .then((result) => {
      if (result.alreadyConfigured) {
        console.log('✅ Sage hooks already configured.');
      } else {
        console.log('✅ Claude hooks configured for Sage.');
      }
    })
    .catch((error) => {
      console.error('Failed to configure hooks:', error);
      process.exitCode = 1;
    });
}
