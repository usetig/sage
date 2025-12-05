#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import App from './ui/App.js';
import { configureCodexProfile } from './scripts/configureCodexProfile.js';

const command = process.argv[2];

if (command === 'config') {
  configureCodexProfile()
    .then((result) => {
      const changes: string[] = [];
      if (result.createdFile) changes.push('created ~/.codex/config.toml');
      if (result.updatedProfile) changes.push('merged Sage profile defaults');
      if (result.updatedFeatures) changes.push('enabled RMCP client');
      if (result.updatedServers.length) changes.push(`added MCP servers: ${result.updatedServers.join(', ')}`);
      if (result.setDefaultProfile) changes.push('set default profile to "sage"');
      const message = changes.length ? changes.join(' | ') : 'config already up to date';
      console.log(`✅ Sage config applied: ${message}`);
    })
    .catch((error) => {
      console.error('Failed to apply Sage config:', error);
      process.exitCode = 1;
    });
} else {
  render(<App />);
}
