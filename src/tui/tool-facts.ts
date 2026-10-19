/** Shared file-change facts for the session transcript and its exit summary. */
export const lineCount = (text: string) => text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
export function editLineChanges(diff: string) {
  const lines = diff.split('\n');
  return { added: lines.filter(line => /^\+\s*\d/.test(line)).length, removed: lines.filter(line => /^-\s*\d/.test(line)).length };
}
export function writeLineChanges(acquired: { content: string; previous: string | null }) {
  const content = Buffer.from(acquired.content, 'base64').toString('utf8');
  return { content, added: lineCount(content), removed: acquired.previous === null ? 0 : lineCount(Buffer.from(acquired.previous, 'base64').toString('utf8')) };
}
