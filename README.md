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
- **Thread persistence** - Automatically resumes context when re-selecting sessions
- **FIFO queue** - Handles multiple turns gracefully, reviews in order
- **Interactive TUI** - Session picker and real-time critique display
- **Read-only by design** - Never modifies your code

## Prerequisites

Before installing Sage, ensure you have:

1. **Node.js 18+** — [Download here](https://nodejs.org/)
2. **OpenAI Codex SDK credentials** — Configured on your system
3. **Claude Code** — With at least one session in your repository
4. **Git repository** — Sage must run in a Git-tracked directory

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

2. **Configure Claude hooks (run once per project):**
   ```bash
   npm run configure-hooks
   ```

3. **Start Sage**:
   ```bash
   npm start
   ```
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

4. **Select a Claude session** from the interactive picker using arrow keys and Enter

5. **Continue working with Claude Code** - Sage will automatically review new turns as they arrive

## How It Works

### First Run Setup
On launch, Sage automatically:
1. Ensures runtime directories exist under `.sage/runtime/`
2. Reads active session metadata captured by the Claude hooks
3. Displays an interactive session picker

### Continuous Review Mode
After selecting a session:
1. **Initial Review** – Sage loads the transcript directly from Claude’s JSONL log and critiques the most recent turn
2. **Hook Signals** – Claude’s hooks write per-session “needs-review” signals; Sage watches these files for new work
3. **Queue Processing** – New turns are detected, queued (FIFO), and reviewed incrementally
4. **Critique Cards** – Structured feedback appears in the terminal as reviews complete

### Critique Card Structure
Each review includes:
- **Verdict**: Approved | Concerns | Critical Issues
- **Why**: Main reasoning and issues found
- **Alternatives**: Suggested alternative approaches (if applicable)
- **Questions**: Clarification questions for you (if applicable)

## Documentation

- **[Architecture Guide](documentation/CODEBASE_GUIDE.md)** - Comprehensive technical reference
- **[Contributing](agents.md)** - Guidelines for contributors and AI agents
- **[Debug Mode](documentation/debug-mode.md)** - Testing without Codex API calls
- **[Troubleshooting](documentation/thread-persistence.md)** - Advanced state management

## Keyboard Controls

### Session Picker
- `↑` / `↓` - Navigate sessions
- `Enter` - Select session to review
- `R` - Refresh session list
- `Ctrl+C` - Exit

### Continuous Review Mode
- `M` - Manually rescan hook signals (force review)
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
│   │   ├── jsonl.ts          # Claude JSONL parsing utilities
│   │   ├── review.ts         # Review orchestration
│   │   └── debug.ts          # Debug mode utilities
│   ├── hooks/                # Claude hook shim (invoked by Claude Code)
│   │   └── sageHook.ts
│   └── scripts/              # Developer utilities (hook installer)
│       └── configureHooks.ts
│       ├── App.tsx           # Main TUI orchestrator
│       └── CritiqueCard.tsx  # Critique renderer
├── .sage/                     # Runtime state (sessions, reviews)
├── .debug/                    # Debug artifacts (when SAGE_DEBUG=1)
└── documentation/             # Reference docs
```

## Troubleshooting

### No sessions appear in picker
- Verify you've used Claude Code in this repository before
- Run `npm run configure-hooks` to ensure Claude hooks are installed
- Check that `.sage/runtime/sessions/` contains metadata files
- Press `R` to refresh the session list in Sage

### Reviews aren't triggering automatically
- Confirm `.claude/settings.local.json` contains Sage’s hook command
- Inspect `.sage/runtime/needs-review/` for pending signal files
- Use the `M` key to rescan signals manually
- Check `.sage/runtime/hook-errors.log` for hook execution errors

### Codex connection errors
- Verify your Codex SDK credentials are configured
- Check network connectivity
- Try debug mode to test without Codex: `SAGE_DEBUG=1 npm start`

### "Not a git repository" error
Sage requires running in a Git-tracked directory. Initialize git:
```bash
git init
```

## Known Limitations

- **Single-instance assumption** — Running multiple Sage processes against the same repository can race on `.sage/history/`, `.sage/threads/`, or the new review cache. Keep one instance active per repo to avoid desynchronised queues or duplicate critiques.
- **Incomplete responses on manual selection** — If you select a session while Claude is still typing, the initial review may fail or produce inaccurate critique. Wait for Claude to finish its response before selecting the session. Continuous mode is unaffected and works correctly.

## Configuration

### Hook Configuration
Run `npm run configure-hooks` whenever you clone Sage into a new project. This command appends the following entries to `.claude/settings.local.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx tsx \"$CLAUDE_PROJECT_DIR/src/hooks/sageHook.ts\"", "timeout": 30 }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "npx tsx \"$CLAUDE_PROJECT_DIR/src/hooks/sageHook.ts\"", "timeout": 30 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "npx tsx \"$CLAUDE_PROJECT_DIR/src/hooks/sageHook.ts\"", "timeout": 30 }] }]
  }
}
```

Claude invokes these hooks for the active session, and Sage stores the resulting metadata under `.sage/runtime/`.

### Directory Structure
- `.sage/runtime/sessions/` - Active-session metadata captured from hooks
- `.sage/runtime/needs-review/` - Signal files that queue critiques
- `.sage/threads/` - Codex thread metadata for resumption (auto-generated)
- `.sage/reviews/` - Cached critique history (auto-generated)
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
- **Claude Code hooks** - Session lifecycle + prompt metadata
- **Claude JSONL transcripts** - Source of truth for conversation turns
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
