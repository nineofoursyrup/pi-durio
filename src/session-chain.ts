import { openHostReadonly, readObject } from './evidence.js';
import { boundedInteger } from './history.js';
import { taskTypeOf } from './task-type.js';

/**
 * Sessions (会话) are derived, never recorded: product runs linked by `context.imported`
 * (`source.sourceRunId` → parent run). Rules (#41, #63, spec E3/U14):
 * - a run without an import starts a session — including a run that failed or aborted before writing
 *   `context.imported`, and every improve analysis;
 * - when one run is continued several times, the earliest-accepted continuation stays in the parent's
 *   session and each later one starts a branch session;
 * - task N is the context-chain depth (a branch from task N starts at task N+1);
 * - a session's identity is the durable sessionId of its first task.
 * Reads are snapshot-bounded and readonly: no records are written and no writer lock is taken.
 */
export type SessionTaskStatus = 'completed' | 'failed' | 'aborted' | 'unknown' | 'ended' | 'running' | 'accepted';
export interface SessionTask {
  runId: string; taskId: string | null; sessionId: string | null; number: number; at: string; seq: number;
  workspace: string | null; project: string | null; input: string; kind: 'task' | 'improve'; taskType: string | null; status: SessionTaskStatus;
}
export interface SessionSummary {
  /** The first task's durable sessionId; the `s-` display number is cut from this. */
  id: string; headRunId: string; tailRunId: string; kind: 'task' | 'improve'; workspace: string | null; project: string | null;
  /** Tasks of this session only; a branch does not count the original session's tasks before the fork. */
  tasks: number; first: SessionTask; tail: SessionTask;
  forkedFrom: { sessionId: string; runId: string; number: number } | null;
  /** Acceptance seq of the newest task; sessions list newest activity first by it. */
  lastSeq: number;
}
interface Node { runId: string; seq: number; at: string; parent: string | null; children: string[]; depth: number; head: string; next: string | null }

const MAX_SCANNED_HEADS = 500;

export class SessionChains {
  private readonly accepted = new Map<string, any>();
  private readonly byId = new Map<string, string>();
  private readonly members = new Map<string, string[]>();
  /** Heads in acceptance order of their newest task, newest first. */
  private readonly recent: string[];
  constructor(private readonly root: string, readonly through: number, private readonly nodes: Map<string, Node>) {
    const last = new Map<string, number>();
    for (const node of nodes.values()) last.set(node.head, Math.max(last.get(node.head) ?? 0, node.seq));
    this.recent = [...last.keys()].sort((a, b) => last.get(b)! - last.get(a)!);
  }
  isHead(runId: string) { return this.nodes.get(runId)?.head === runId; }
  /** The session a run belongs to and its task number, or null for an unknown run. */
  sessionOfRun(runId: string): { id: string; headRunId: string; number: number } | null {
    const node = this.nodes.get(runId);
    return node ? { id: this.sessionIdOf(node.head), headRunId: node.head, number: node.depth } : null;
  }
  /** `id` is a session identity (full sessionId of its first task; resolve `s-` numbers first). */
  session(id: string): SessionSummary | null {
    const head = this.headOf(id);
    return head ? this.summary(head) : null;
  }
  /** One page of a session's own tasks in chain order; `after` is a task number. */
  tasks(id: string, options: { after?: number; limit?: number } = {}) {
    const head = this.headOf(id), after = boundedInteger(options.after ?? 0), limit = boundedInteger(options.limit ?? 20, 1, 50);
    if (!head) return { items: [] as SessionTask[], next: null as number | null };
    const page = this.chain(head).filter(runId => this.nodes.get(runId)!.depth > after);
    const items = page.slice(0, limit).map(runId => this.task(runId));
    return { items, next: page.length > limit ? items.at(-1)!.number : null };
  }
  /** Full context chain ending at `runId`, root first; for a branch this includes the original session's tasks up to the fork. */
  contextRunIds(runId: string) {
    const ids: string[] = [];
    for (let node = this.nodes.get(runId); node; node = node.parent ? this.nodes.get(node.parent) : undefined) ids.unshift(node.runId);
    return ids;
  }
  /**
   * Sessions newest activity first, optionally of one workspace. Walks back from the newest run and stops
   * when the page is full, so a short list (the welcome screen's 3) never scans the whole root. At most
   * 500 sessions are examined per call; `next` continues from where this page stopped.
   */
  list(options: { workspace?: string; before?: number; limit?: number } = {}) {
    const limit = boundedInteger(options.limit ?? 20, 1, 50), before = options.before === undefined ? Infinity : boundedInteger(options.before);
    const items: SessionSummary[] = [];let scanned = 0, stop: number | null = null;
    for (const head of this.recent) {
      const lastSeq = this.nodes.get(this.chain(head).at(-1)!)!.seq;
      if (lastSeq >= before) continue;
      if (items.length === limit || scanned === MAX_SCANNED_HEADS) { stop = items.at(-1)?.lastSeq ?? lastSeq + 1; break; }
      scanned++;
      if (options.workspace !== undefined && this.read(head)?.workspace !== options.workspace) continue;
      items.push(this.summary(head));
    }
    return { items, next: stop === null ? null : { before: stop }, through: this.through, scanned };
  }
  private headOf(id: string) {
    if (this.byId.has(id)) return this.byId.get(id)!;
    for (const head of this.recent) if (this.sessionIdOf(head) === id) return head;
    return undefined;
  }
  private sessionIdOf(head: string) {
    const id = typeof this.read(head)?.sessionId === 'string' ? this.read(head).sessionId as string : head;
    this.byId.set(id, head);
    return id;
  }
  private chain(head: string) {
    let list = this.members.get(head);
    if (!list) {
      list = [];
      for (let id: string | null = head; id; id = this.nodes.get(id)!.next) list.push(id);
      this.members.set(head, list);
    }
    return list;
  }
  private summary(head: string): SessionSummary {
    const chain = this.chain(head), first = this.task(head), tail = this.task(chain.at(-1)!), parent = this.nodes.get(head)!.parent;
    const forked = parent ? this.sessionOfRun(parent) : null;
    return {
      id: this.sessionIdOf(head), headRunId: head, tailRunId: tail.runId, kind: first.kind, workspace: first.workspace, project: first.project,
      tasks: chain.length, first, tail, forkedFrom: forked && parent ? { sessionId: forked.id, runId: parent, number: forked.number } : null, lastSeq: tail.seq,
    };
  }
  private task(runId: string): SessionTask {
    const node = this.nodes.get(runId)!, data = this.read(runId) ?? {};
    return {
      runId, taskId: data.taskId ?? null, sessionId: data.sessionId ?? null, number: node.depth, at: node.at, seq: node.seq,
      workspace: data.workspace ?? null, project: data.projectId ?? data.workspace ?? null, input: typeof data.input === 'string' ? data.input : '',
      kind: data.kind === 'improve' ? 'improve' : 'task', taskType: taskTypeOf(data), status: this.status(runId),
    };
  }
  private read(runId: string) {
    if (!this.accepted.has(runId)) {
      const db = openHostReadonly(this.root);let row: Record<string, unknown> | undefined;
      try { row = db.prepare("SELECT body FROM records WHERE run_id=? AND kind='task.accepted' AND seq<=? ORDER BY seq LIMIT 1").get(runId, this.through) as Record<string, unknown> | undefined; }
      finally { db.close(); }
      this.accepted.set(runId, row ? JSON.parse(readObject(this.root, JSON.parse(String(row.body))).toString()) : null);
    }
    return this.accepted.get(runId);
  }
  private status(runId: string): SessionTaskStatus {
    const db = openHostReadonly(this.root);let closed: Record<string, unknown> | undefined, started: unknown;
    try {
      closed = db.prepare("SELECT kind,body FROM records WHERE run_id=? AND seq<=? AND kind IN ('run.closed','recovery.closed','recovery.ended') ORDER BY seq DESC LIMIT 1").get(runId, this.through) as Record<string, unknown> | undefined;
      started = closed ? true : db.prepare("SELECT 1 FROM records WHERE run_id=? AND seq<=? AND kind='run.started' LIMIT 1").get(runId, this.through);
    } finally { db.close(); }
    if (!closed) return started ? 'running' : 'accepted';
    if (closed.kind === 'recovery.ended') return 'ended';
    const data = JSON.parse(readObject(this.root, JSON.parse(String(closed.body))).toString());
    return (data.result ?? data).status ?? 'unknown';
  }
}

/**
 * Derives the session chains of one data root at a snapshot. Only `task.accepted` row identities and the
 * small `context.imported` bodies are read here; task details are decoded lazily for the pages asked for.
 */
export function readSessionChains(root: string, options: { through?: number } = {}) {
  const nodes = new Map<string, Node>();
  let db: ReturnType<typeof openHostReadonly>;
  try { db = openHostReadonly(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new SessionChains(root, 0, nodes); throw error; }
  let rows: Record<string, unknown>[], through: number;
  try {
    through = options.through ?? Number((db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM records').get() as { n: number }).n);
    rows = db.prepare("SELECT seq,run_id,kind,at,body FROM records WHERE kind IN ('task.accepted','context.imported') AND seq<=? ORDER BY seq").all(through) as Record<string, unknown>[];
  } finally { db.close(); }
  for (const row of rows) {
    const runId = String(row.run_id);
    if (row.kind === 'task.accepted') { if (!nodes.has(runId)) nodes.set(runId, { runId, seq: Number(row.seq), at: String(row.at), parent: null, children: [], depth: 1, head: runId, next: null }); continue; }
    const node = nodes.get(runId), parent = JSON.parse(readObject(root, JSON.parse(String(row.body))).toString()).source?.sourceRunId;
    if (node && typeof parent === 'string' && parent !== runId && nodes.has(parent) && node.parent === null) { node.parent = parent; nodes.get(parent)!.children.push(runId); }
  }
  // Map order is acceptance order and a parent is always accepted before its continuations, so a
  // parent's depth and head are final when its children are reached. The earliest-accepted child stays.
  for (const node of nodes.values()) node.children.sort((a, b) => nodes.get(a)!.seq - nodes.get(b)!.seq);
  for (const node of nodes.values()) {
    if (!node.parent) continue;
    const parent = nodes.get(node.parent)!;
    node.depth = parent.depth + 1;
    if (parent.children[0] === node.runId) { node.head = parent.head; parent.next = node.runId; }
  }
  return new SessionChains(root, through, nodes);
}
