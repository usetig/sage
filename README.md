# Sage

**AI code reviewer that provides automatic second opinions on Claude Code sessions**

Sage monitors your Claude Code conversations in real-time and delivers structured critique cards—no extra commands required. Get a second pair of eyes on Claude's suggestions without breaking your workflow.

## What Problem Does This Solve?

Coding agents like Claude Code can sound confident while being wrong or incomplete. Developers typically copy conversations into another AI assistant (Cursor, GPT) to cross-check plans, which:
- Breaks workflow continuity
- Loses repository context
- Requires manual intervention

**Sage automates the second-opinion pass** by reading the same conversation and codebase, providing grounded critiques automatically.

## Features

- **Zero-command workflow** - Automatically reviews Claude responses as you work
- **Repository-aware** - Reads your codebase to provide informed critiques
- **Structured feedback** - Delivers verdict, reasoning, alternatives, and questions
- **FIFO queue** - Handles multiple turns gracefully, reviews in order
- **Interactive TUI** - Session picker and real-time critique display
- **Read-only by design** - Never modifies your code

## Prerequisites

Before installing Sage, ensure you have:

1. **Node.js 18+** - [Download here](https://nodejs.org/)
2. **SpecStory CLI** - [Installation guide](https://docs.specstory.com)
   ```bash
   # Verify SpecStory is installed and on PATH
   which specstory
   ```
3. **OpenAI Codex SDK credentials** - Configured on your system
4. **Claude Code** - With at least one session in your repository
5. **Git repository** - Sage must run in a Git-tracked directory

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/usetig/sage.git
   cd sage
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Quick Start

1. **Navigate to your project** (must be a Git repository):
   ```bash
   cd /path/to/your/project
   ```

2. **Start Sage**:
   ```bash
   npm start
   ```
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

3. **Select a Claude session** from the interactive picker using arrow keys and Enter

4. **Continue working with Claude Code** - Sage will automatically review new turns as they arrive

## How It Works

### First Run Setup
On launch, Sage automatically:
1. Runs `specstory sync claude` to export Claude Code sessions to `.sage/history/`
2. Installs a Claude Code `Stop` hook in `.claude/settings.local.json` to auto-sync after each Claude response
3. Displays an interactive session picker

### Continuous Review Mode
After selecting a session:
1. **Initial Review** - Sage reads the full conversation, explores relevant code files, and delivers a comprehensive critique of the latest turn
2. **File Watching** - Monitors `.sage/history/{sessionId}.md` for changes
3. **Auto-sync** - The Claude Stop hook triggers SpecStory sync after each Claude response
4. **Queue Processing** - New turns are detected, queued (FIFO), and reviewed incrementally
5. **Critique Cards** - Structured feedback appears in the terminal as reviews complete

### Critique Card Structure
Each review includes:
- **Verdict**: Approved | Concerns | Critical Issues
- **Why**: Main reasoning and issues found
- **Alternatives**: Suggested alternative approaches (if applicable)
- **Questions**: Clarification questions for you (if applicable)

## Keyboard Controls

### Session Picker
- `↑` / `↓` - Navigate sessions
- `Enter` - Select session to review
- `R` - Refresh session list
- `Ctrl+C` - Exit

### Continuous Review Mode
- `M` - Manual SpecStory sync (force refresh)
- `B` - Back to session picker
- `Ctrl+C` - Exit

## Debug Mode

Test Sage without making Codex API calls:

```bash
SAGE_DEBUG=1 npm start
```

Debug mode:
- Skips actual Codex agent calls
- Returns mock critique responses
- Writes full prompts and context to `.debug/review-*.txt`
- Useful for testing the pipeline end-to-end

## Project Structure

```
sage/
├── src/
│   ├── index.tsx              # Entry point
│   ├── types.ts               # TypeScript interfaces
│   ├── lib/                   # Core business logic
│   │   ├── codex.ts          # Codex SDK wrapper & prompts
│   │   ├── specstory.ts      # SpecStory integration
│   │   ├── review.ts         # Review orchestration
│   │   ├── markdown.ts       # Conversation parsing
│   │   ├── hooks.ts          # Claude hook configuration
│   │   └── debug.ts          # Debug mode utilities
│   └── ui/                    # Terminal UI components
│       ├── App.tsx           # Main TUI orchestrator
│       └── CritiqueCard.tsx  # Critique renderer
├── .sage/                     # SpecStory exports (generated)
├── .debug/                    # Debug artifacts (when SAGE_DEBUG=1)
└── documentation/             # Reference docs
```

## Troubleshooting

### "SpecStory not found"
Ensure SpecStory CLI is installed and on your PATH:
```bash
which specstory
```

### No sessions appear in picker
- Verify you've used Claude Code in this repository before
- Check that `.sage/history/` contains markdown files
- Try pressing `R` to refresh the session list
- Run manual sync: `specstory sync claude --output-dir .sage/history`

### Reviews aren't triggering automatically
- Check that `.claude/settings.local.json` contains the Stop hook
- Restart Sage to reconfigure hooks: `npm start`
- Try manual sync with `M` key in continuous mode
- Verify the Claude session file exists in `.sage/history/`

### Codex connection errors
- Verify your Codex SDK credentials are configured
- Check network connectivity
- Try debug mode to test without Codex: `SAGE_DEBUG=1 npm start`

### "Not a git repository" error
Sage requires running in a Git-tracked directory. Initialize git:
```bash
git init
```

## Configuration

### Hook Configuration
Sage auto-installs this hook to `.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop": "specstory sync claude --output-dir .sage/history --no-version-check --silent"
  }
}
```

This runs after every Claude response to keep `.sage/history/` in sync.

### Directory Structure
- `.sage/history/` - SpecStory markdown exports (auto-generated)
- `.debug/` - Debug artifacts when `SAGE_DEBUG=1` (auto-generated)
- `.claude/settings.local.json` - Claude Code hooks (auto-configured)

## Development

### Run in development mode (auto-restart on changes):
```bash
npm run dev
```

### Build TypeScript:
```bash
npm run build
```

### Run production build:
```bash
npm start
```

## Architecture

Sage uses:
- **React + Ink** - Terminal UI framework
- **OpenAI Codex SDK** - AI agent for code review
- **SpecStory CLI** - Claude Code session export
- **Chokidar** - File watching for continuous mode
- **TypeScript** - Type-safe implementation

## Contributing

See [agents.md](./agents.md) for contributor guidelines and architecture details.

## Known Limitations

- Does not follow resumed session chains back to parent sessions
- No arrow-key navigation within critique history
- Minimal persistent logging (debug mode only)
- Warmup-only sessions are filtered but take up session IDs

## License

ISC

## Links

- **Repository**: https://github.com/usetig/sage
- **Issues**: https://github.com/usetig/sage/issues
- **SpecStory Docs**: https://docs.specstory.com
