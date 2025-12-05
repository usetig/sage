#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import App from './ui/App.js';

const allowTellClaudeSend = process.argv.includes('--danger-allow-send') || process.env.SAGE_ALLOW_SEND === '1';

render(<App allowTellClaudeSend={allowTellClaudeSend} />);
