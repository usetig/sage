import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { parse, stringify } from '@iarna/toml';
import { DEFAULT_MODEL } from '../lib/models.js';

const CONFIG_DIR = path.join(os.homedir(), '.codex');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.toml');
const DEFAULT_PROFILE_NAME = 'sage';

type TomlValue = Record<string, any>;

interface ConfigureResult {
  createdFile: boolean;
  updatedProfile: boolean;
  updatedFeatures: boolean;
  updatedServers: string[];
  setDefaultProfile: boolean;
}

const DEFAULT_PROFILE: TomlValue = {
  model: DEFAULT_MODEL,
  approval_policy: 'never',
  sandbox_mode: 'workspace-write',
  allow_search: true,
  description: 'Sage read-only profile with Context7 MCP and search enabled',
};

const DEFAULT_FEATURES: TomlValue = {
  rmcp_client: true,
};

const DEFAULT_MCP_SERVERS: Record<string, TomlValue> = {
  context7: {
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    timeout: 20000,
  },
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function safeParseToml(raw: string | null): TomlValue {
  if (!raw) return {};
  try {
    return parse(raw) as TomlValue;
  } catch {
    return {};
  }
}

function ensureTable(root: TomlValue, key: string): TomlValue {
  if (!root[key] || typeof root[key] !== 'object' || Array.isArray(root[key])) {
    root[key] = {};
  }
  return root[key] as TomlValue;
}

function mergeShallow(target: TomlValue, source: TomlValue): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(source)) {
    if (target[key] === undefined) {
      target[key] = deepClone(value);
      changed = true;
    }
  }
  return changed;
}

export async function configureCodexProfile(profileName = DEFAULT_PROFILE_NAME): Promise<ConfigureResult> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  let rawConfig: string | null = null;
  try {
    rawConfig = await fs.readFile(CONFIG_PATH, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const config = safeParseToml(rawConfig);
  const profiles = ensureTable(config, 'profiles');
  const mcpServers = ensureTable(config, 'mcp_servers');
  const features = ensureTable(config, 'features');

  if (!profiles[profileName] || typeof profiles[profileName] !== 'object') {
    profiles[profileName] = {};
  }

  const profileTable = profiles[profileName] as TomlValue;

  const updatedProfile = mergeShallow(profileTable, DEFAULT_PROFILE);
  const updatedFeatures = mergeShallow(features, DEFAULT_FEATURES);

  const updatedServers: string[] = [];
  for (const [serverName, serverConfig] of Object.entries(DEFAULT_MCP_SERVERS)) {
    if (!mcpServers[serverName] || typeof mcpServers[serverName] !== 'object') {
      mcpServers[serverName] = deepClone(serverConfig);
      updatedServers.push(serverName);
    }
  }

  const setDefaultProfile = config.profile !== profileName;
  config.profile = profileName;

  const output = stringify(config).trimEnd() + os.EOL;
  await fs.writeFile(CONFIG_PATH, output, 'utf8');

  return {
    createdFile: rawConfig === null,
    updatedProfile,
    updatedFeatures,
    updatedServers,
    setDefaultProfile,
  };
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  configureCodexProfile()
    .then((result) => {
      const actions: string[] = [];
      if (result.createdFile) actions.push('created config.toml');
      if (result.updatedProfile) actions.push('applied profile defaults');
      if (result.updatedFeatures) actions.push('enabled RMCP client');
      if (result.updatedServers.length) actions.push(`added MCP servers: ${result.updatedServers.join(', ')}`);
      if (result.setDefaultProfile) actions.push('set profile=sage');
      const summary = actions.length ? actions.join('; ') : 'config already up to date';
      console.log(`✅ Sage Codex profile configured: ${summary}`);
    })
    .catch((error) => {
      console.error('Failed to configure Codex profile for Sage:', error);
      process.exitCode = 1;
    });
}
