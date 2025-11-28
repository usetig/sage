import path from 'path';
import os from 'os';

/**
 * Get the project root directory.
 * Uses CLAUDE_PROJECT_DIR if available (for hook context), otherwise uses cwd.
 */
export function getProjectRoot(): string {
  return process.env.CLAUDE_PROJECT_DIR
    ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
    : process.cwd();
}

/**
 * Encode a project path for use as a directory name.
 * Converts /Users/you/projects/foo → Users-you-projects-foo
 */
export function encodeProjectPath(projectPath: string): string {
  // Remove leading slash and replace all slashes with hyphens
  const encoded = projectPath
    .replace(/^\//, '') // Remove leading slash
    .replace(/\//g, '-') // Replace remaining slashes with hyphens
    .replace(/\s+/g, '_'); // Replace spaces with underscores for safety

  return encoded;
}

/**
 * Get the global Sage directory for the current project.
 * Returns ~/.sage/{encoded-project-path}/
 */
export function getSageDir(): string {
  const projectRoot = getProjectRoot();
  const encoded = encodeProjectPath(projectRoot);
  const homeDir = os.homedir();

  return path.join(homeDir, '.sage', encoded);
}

/**
 * Get the runtime directory for the current project.
 * Returns ~/.sage/{encoded-project-path}/runtime/
 */
export function getRuntimeDir(): string {
  return path.join(getSageDir(), 'runtime');
}

/**
 * Get the sessions directory for the current project.
 * Returns ~/.sage/{encoded-project-path}/runtime/sessions/
 */
export function getSessionsDir(): string {
  return path.join(getRuntimeDir(), 'sessions');
}

/**
 * Get the queue directory for the current project.
 * Returns ~/.sage/{encoded-project-path}/runtime/needs-review/
 */
export function getQueueDir(): string {
  return path.join(getRuntimeDir(), 'needs-review');
}

/**
 * Get the error log path for the current project.
 * Returns ~/.sage/{encoded-project-path}/runtime/hook-errors.log
 */
export function getErrorLogPath(): string {
  return path.join(getRuntimeDir(), 'hook-errors.log');
}

/**
 * Get the threads directory for the current project.
 * Returns ~/.sage/{encoded-project-path}/threads/
 */
export function getThreadsDir(): string {
  return path.join(getSageDir(), 'threads');
}

/**
 * Get the reviews directory for the current project.
 * Returns ~/.sage/{encoded-project-path}/reviews/
 */
export function getReviewsDir(): string {
  return path.join(getSageDir(), 'reviews');
}

/**
 * Get the debug directory for the current project.
 * Returns ~/.sage/{encoded-project-path}/debug/
 */
export function getDebugDir(): string {
  return path.join(getSageDir(), 'debug');
}
