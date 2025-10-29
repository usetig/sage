import { promises as fs } from 'fs';
import path from 'path';

const CLAUDE_DIR = '.claude';
const SETTINGS_FILE = 'settings.local.json';

const HOOK_COMMAND =
  'specstory sync claude --output-dir "$CLAUDE_PROJECT_DIR/.sage/history" --no-version-check --silent --no-cloud-sync --no-usage-analytics';

export async function ensureStopHookConfigured(): Promise<void> {
  const settingsDir = path.join(process.cwd(), CLAUDE_DIR);
  const settingsPath = path.join(settingsDir, SETTINGS_FILE);

  await fs.mkdir(settingsDir, { recursive: true });

  let raw: string | null = null;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Failed to read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let settings: any;
  if (!raw) {
    settings = {};
  } else {
    try {
      settings = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Unable to parse ${settingsPath} as JSON.`);
    }
  }

  if (!settings || typeof settings !== 'object') {
    settings = {};
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  const stopHooks: any[] = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  const alreadyConfigured = stopHooks.some(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook: any) => hook && hook.type === 'command' && typeof hook.command === 'string' && hook.command.trim() === HOOK_COMMAND,
      ),
  );

  if (alreadyConfigured) {
    return;
  }

  stopHooks.push({
    hooks: [
      {
        type: 'command',
        command: HOOK_COMMAND,
      },
    ],
  });

  settings.hooks.Stop = stopHooks;

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export { HOOK_COMMAND };
