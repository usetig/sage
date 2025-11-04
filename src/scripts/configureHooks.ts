import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';

const HOOK_COMMAND = 'npx tsx "$CLAUDE_PROJECT_DIR/src/hooks/sageHook.ts"';
const TARGET_EVENTS = ['SessionStart', 'Stop', 'UserPromptSubmit'] as const;

async function ensureHooks(): Promise<void> {
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

  for (const event of TARGET_EVENTS) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const hasCommand = existing.some((entry: any) =>
      entry &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook: any) => hook && hook.type === 'command' && typeof hook.command === 'string' && hook.command.trim() === HOOK_COMMAND,
      ),
    );

    if (!hasCommand) {
      existing.push({
        hooks: [
          {
            type: 'command',
            command: HOOK_COMMAND,
            timeout: 30,
          },
        ],
      });
    }

    settings.hooks[event] = existing;
  }

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}${os.EOL}`, 'utf8');
  console.log('✅ Claude hooks configured for Sage.');
}

void ensureHooks().catch((error) => {
  console.error('Failed to configure hooks:', error);
  process.exitCode = 1;
});
