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
- **Model selection** - Choose from multiple AI models via settings screen
- **Debug mode** - Toggle verbose status messages for troubleshooting
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

2. **Start Sage**:
   ```bash
   npm start
   ```
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

3. **First run only**: Sage automatically configures Claude hooks in `.claude/settings.local.json`. You'll see "✓ Hooks configured" in the session list.

4. **Select a Claude session** from the interactive picker using arrow keys and Enter

5. **Continue working with Claude Code** - Sage will automatically review new turns as they arrive

## How It Works

### First Run Setup
On launch, Sage automatically:
1. **Configures Claude hooks** (first run only) - installs hooks in `.claude/settings.local.json`
2. Ensures runtime directories exist under `~/.sage/{project-path}/runtime/`
3. Reads active session metadata captured by the Claude hooks
4. Displays an interactive session picker

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
- **[Troubleshooting](documentation/thread-persistence.md)** - Advanced state management

## Keyboard Controls

### Session Picker
- `↑` / `↓` - Navigate sessions
- `Enter` - Select session to review
- `R` - Refresh session list
- `S` - Open settings (model selection)
- `Ctrl+C` - Exit

### Continuous Review Mode
- `M` - Manually rescan hook signals (force review)
- `C` - Chat with Sage about the current review
- `B` - Back to session picker
- `Ctrl+O` - Toggle stream overlay
- `Ctrl+C` - Exit

### Settings Screen
- `↑` / `↓` - Navigate options (models, debug toggle)
- `Enter` - Select model or toggle debug mode
- `Esc` / `B` - Back to session picker

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
│   │   ├── threads.ts        # Thread metadata & resumption
│   │   ├── models.ts         # Available AI models configuration
│   │   ├── settings.ts       # User settings persistence
│   │   └── debug.ts          # Artifact utilities
│   ├── hooks/                # Claude hook shim (invoked by Claude Code)
│   │   └── sageHook.ts
│   ├── ui/                   # Terminal UI components
│   │   ├── App.tsx           # Main TUI orchestrator
│   │   ├── CritiqueCard.tsx  # Critique renderer
│   │   └── SettingsScreen.tsx # Model selection UI
│   └── scripts/              # Developer utilities (hook installer)
│       └── configureHooks.ts
├── .debug/                    # Artifact files written for inspection
└── documentation/             # Reference docs

Runtime state (sessions, threads, reviews) is stored globally:
~/.sage/
└── {encoded-project-path}/    # e.g., Users-you-projects-myapp/
    ├── runtime/
    ├── threads/
    └── reviews/
```

## Troubleshooting

### No sessions appear in picker
- Verify you've used Claude Code in this repository before
- Restart Sage to trigger auto-configuration of Claude hooks
- Or run `npm run configure-hooks` manually if auto-configuration fails
- Check that `~/.sage/{project-path}/runtime/sessions/` contains metadata files
- Press `R` to refresh the session list in Sage

### Reviews aren't triggering automatically
- Confirm `.claude/settings.local.json` contains Sage's hook command
- Inspect `~/.sage/{project-path}/runtime/needs-review/` for pending signal files
- Use the `M` key to rescan signals manually
- Check `~/.sage/{project-path}/runtime/hook-errors.log` for hook execution errors

### Codex connection errors
- Verify your Codex SDK credentials are configured
- Check network connectivity

### "Not a git repository" error
Sage requires running in a Git-tracked directory. Initialize git:
```bash
git init
```

## Known Limitations

- **Single-instance assumption** — Running multiple Sage processes against the same repository can race on `~/.sage/{project-path}/` state files. Keep one instance active per repo to avoid desynchronised queues or duplicate critiques.
- **Incomplete responses on manual selection** — If you select a session while Claude is still typing, the initial review may fail or produce inaccurate critique. Wait for Claude to finish its response before selecting the session. Continuous mode is unaffected and works correctly.
- **iTerm2 Flickering** — Users may experience flickering when using iTerm2 due to its handling of rapid screen updates. This is a known issue with the underlying Ink library and iTerm2. Using the default macOS Terminal or VS Code's integrated terminal is recommended if this persists.

## Configuration

### Hook Configuration
Sage **automatically configures hooks on first run**. When you start Sage in a new project, it detects missing hooks and adds them to `.claude/settings.local.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"/path/to/sage/dist/hooks/sageHook.js\"", "timeout": 30 }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "node \"/path/to/sage/dist/hooks/sageHook.js\"", "timeout": 30 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"/path/to/sage/dist/hooks/sageHook.js\"", "timeout": 30 }] }]
  }
}
```

**Manual setup**: If auto-configuration fails (shown as a warning), run `npm run configure-hooks`.

Claude invokes these hooks for the active session, and Sage stores the resulting metadata under `~/.sage/{project-path}/runtime/`.

### Settings

Press `S` from the session picker to open the settings screen.

**Model Selection**: Choose from multiple AI models for code review:
- GPT-5.1 Codex (default)
- GPT-5.1 Codex Mini
- GPT-5.1
- GPT-5
- GPT-5 Mini
- GPT-5 Nano
- GPT-4.1
- GPT-4.1 Mini
- GPT-4.1 Nano

**Debug Mode**: Toggle verbose status messages on/off. When enabled, you'll see detailed progress information like:
- "loading session context..."
- "Codex thread: {id}"
- "Queued review: {prompt}"
- Review progress from the AI model

Debug mode is off by default for a cleaner UI. Enable it when troubleshooting or if you want more visibility into what Sage is doing.

All settings are stored in `~/.sage/settings.json` and persist across sessions.

### Directory Structure

**Global Sage Directory** (`~/.sage/`):

- `~/.sage/settings.json` - User preferences (model selection, debug mode)

Each project gets its own subdirectory based on its full path (e.g., `/Users/you/projects/myapp` → `~/.sage/Users-you-projects-myapp/`):

- `~/.sage/{project-path}/runtime/sessions/` - Active-session metadata captured from hooks
- `~/.sage/{project-path}/runtime/needs-review/` - Signal files that queue critiques
- `~/.sage/{project-path}/runtime/hook-errors.log` - Hook execution error log
- `~/.sage/{project-path}/threads/` - Codex thread metadata for resumption (auto-generated)
- `~/.sage/{project-path}/reviews/` - Cached critique history (auto-generated)

**Local Project Files**:

- `.debug/` - Prompt artifacts for inspection (auto-generated, local to project)
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
- Minimal persistent logging to console (artifacts available in `.debug/`)
- Warmup-only sessions are filtered but take up session IDs

## License

ISC

## Links

- **Repository**: https://github.com/usetig/sage
- **Issues**: https://github.com/usetig/sage/issues
