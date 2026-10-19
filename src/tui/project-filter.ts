import { realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { CommandError } from './commands.js';

export const canonicalProject = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/** Exact recorded identity/path wins; a short project name must identify one project. */
export function resolveProjectFilter(input: string | undefined, workspace: string, projects: readonly string[] = []): string | undefined {
  if (input === 'all') return undefined;
  const current = canonicalProject(workspace);
  if (input === undefined) return current;
  const choices = [...new Set([current, ...projects])];
  if (choices.includes(input)) return input;
  if (isAbsolute(input)) return canonicalProject(input);
  const matches = choices.filter(project => basename(project) === input);
  if (matches.length === 1) return matches[0];
  throw new CommandError(matches.length ? `项目名称有歧义：${input}` : `找不到项目：${input}`, matches.length ? matches : choices);
}
