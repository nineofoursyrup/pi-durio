/** U13 historical sessions, tasks and readonly 1b transcript. No execution or management writer. */
import { matchesKey, visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import { readObject, readQueue, type QueueItemFact } from '../evidence.js';
import { decode, records } from '../history.js';
import { readDisplayIndex } from '../display-number.js';
import { readRunRecords, type RecordReference } from '../query.js';
import { readSessionChains, type SessionSummary, type SessionTask } from '../session-chain.js';
import { runVersionChanged } from '../continuation.js';
import { readTrace } from '../trace.js';
import { formatCostTotals } from '../cost-estimate.js';
import { RunView, VISIBLE_KINDS, sumUsage } from './run-view.js';
import { assistantLines, clock, plainLines, tokenCount, toolLines, userLines } from './session-screen.js';
import { COLOR_TIER, GLYPHS, styledLine, type ColorTier, type TokenName } from './theme.js';
import { clean, fixedFrame, hintLine, truncateEnd } from './view-stack.js';
import { HistoryFilter, historyCommand, type HistoryScope, type HistoryTarget } from './history-filter.js';
export { historyScope, type HistoryTarget } from './history-filter.js';


/** Project choices share session identity with the rows and also work before the first task exists. */
export function historyProjects(root: string) {
  const chains = readSessionChains(root), projects = new Set<string>(); let before: number | undefined;
  do { const page = chains.list({ before, limit: 50 }); page.items.forEach(s => { if (s.project) projects.add(s.project); }); before = page.next?.before; } while (before !== undefined);
  return [...projects];
}

/** Stable task identity for #86. saved() refreshes facts while preserving the selected row and layer. */
export interface HistoryTaskTarget { root: string; sessionId: string; taskId: string; runId: string | null; acceptedSource: string }
export interface HistoryHost {
  workspace?: string;
  continue?(sessionId: string): void;
  trace?(runId: string): void;
  details?(runId: string, attemptId: string): void;
  annotate?(task: HistoryTaskTarget, saved: () => void): void;
  feedback?(text: string): void;
  changed?(): void;
}
type TaskRow = { key: string; task?: SessionTask; queued?: QueueItemFact };
interface Position { selected: number; offset: number; follow: boolean }
interface SessionPage extends Position { before?: number; items: SessionSummary[]; next: number | null }
interface TaskPage extends Position { session: SessionSummary; page: number; rows: TaskRow[] }
interface BodyPage { row: TaskRow; records: RecordReference[]; before?: number; after?: number; offset: number; expanded: boolean; toggled: Set<string> }
const pageSize = 8, windowSize = 50;
const first = (text: string) => clean(text).split(/\r?\n/)[0] || '输入未记录';
const stateOf = (state: string) => state === 'running' || state === 'accepted' ? 'unknown' : state === 'ended' ? 'aborted' : state;
const status = (state: string): { glyph: string; label: string; fg: TokenName } => state === 'completed' ? { glyph: GLYPHS.ok, label: '完成', fg: 'ac.ok' } : state === 'failed' ? { glyph: GLYPHS.err, label: '失败', fg: 'ac.err' } : state === 'aborted' ? { glyph: GLYPHS.aborted, label: '已中止', fg: 'fg.muted' } : state === 'ended' ? { glyph: GLYPHS.aborted, label: '已结束', fg: 'fg.muted' } : { glyph: GLYPHS.warn, label: '待恢复核对', fg: 'ac.warn' };

export class HistoryView {
  private chains;
  private index;
  private list: SessionPage;
  private previous: SessionPage[] = [];
  private tasks?: TaskPage;
  private body?: BodyPage;
  private filter?: HistoryFilter;
  private filterOffset = 0;
  private views = new Map<string, RunView>();
  private metrics = new Map<string, string>();
  private states = new Map<string, string>();
  private removed = new Set<string>();
  private originals = new Set<string>();
  private hits = new Map<number, () => void>();
  private workspace: string;
  private scope: HistoryScope;
  private navigationRevision = 0;
  constructor(readonly root: string, target: HistoryTarget = {}, private readonly host: HistoryHost = {}) {
    this.workspace = host.workspace ?? target.project ?? process.cwd();
    this.scope = { project: target.project, from: target.from, to: target.to, status: target.status };
    this.chains = readSessionChains(root); this.index = readDisplayIndex(root);
    this.readAvailability(); this.list = this.readPage();
    const session = target.session ?? (target.run && this.chains.sessionOfRun(target.run)?.id);
    if (session) {
      this.openSession(session);
      if (target.run && this.tasks) {
        const row = this.tasks.rows.find(r => r.task?.runId === target.run);
        if (row) { this.tasks.page = Math.floor(this.tasks.rows.indexOf(row) / pageSize); this.tasks.selected = this.tasks.rows.indexOf(row) % pageSize; this.openBody(row); }
      }
    }
  }
  get depth() { return this.body ? 3 : this.tasks ? 2 : this.filter ? 2 : 1; }
  get isBody() { return !!this.body; }
  get acceptsInput() { return !!this.filter?.preset.isEditing; }
  /** A late host probe must not override a user's later layer or selection action. */
  get revision() { return this.navigationRevision; }
  get selectedTask(): HistoryTaskTarget | undefined {
    const row = this.tasks && this.tasks.rows[this.tasks.page * pageSize + this.tasks.selected];
    if (!row || !this.tasks) return undefined;
    const taskId = row.task?.taskId ?? row.queued?.taskId;
    const source = row.task ? this.accepted(row.task.runId)?.id : [...records(this.root, { runId: row.queued!.target.runId, through: this.chains.through, kinds: ['control.accepted'] })].find(ref => ref.seq === row.queued!.acceptedSeq)?.id;
    return taskId && source ? { root: this.root, sessionId: this.tasks.session.id, runId: row.task?.runId ?? null, taskId, acceptedSource: source } : undefined;
  }
  /** Internal layers keep their own selection/window; the app pops its outer stack only when false. */
  back() {
    this.navigationRevision++;
    if (this.filter) { if (this.filter.preset.isEditing) this.filter.preset.handleInput('\x1b'); else this.filter = undefined; }
    else if (this.body) this.body = undefined;
    else if (this.tasks) this.tasks = undefined;
    else return false;
    this.host.changed?.(); return true;
  }
  refresh() {
    const chosen = this.selectedTask, session = this.tasks?.session.id;
    this.chains = readSessionChains(this.root); this.index = readDisplayIndex(this.root); this.views.clear(); this.metrics.clear(); this.states.clear(); this.readAvailability();
    const list = this.list; this.list = { ...this.readPage(list.before), selected: list.selected, offset: list.offset, follow: false };
    if (session) {
      const old = this.tasks!; this.openSession(session);
      const at = this.tasks!.rows.findIndex(row => (row.task?.taskId ?? row.queued?.taskId) === chosen?.taskId);
      this.tasks!.page = at < 0 ? old.page : Math.floor(at / pageSize); this.tasks!.selected = at < 0 ? old.selected : at % pageSize; this.tasks!.offset = old.offset; this.tasks!.follow = false;
    }
    this.host.changed?.();
  }
  private accepted(runId: string) { return [...records(this.root, { runId, through: this.chains.through, kinds: ['task.accepted'] })][0]; }
  private state(task: SessionTask) {
    if (!this.states.has(task.runId)) {
      let value = task.status as string;
      const closed = readRunRecords(this.root, task.runId, { before: this.chains.through + 1, tail: true, limit: 1, kinds: ['run.closed', 'recovery.closed', 'recovery.ended'] }).records[0];
      if (closed && closed.kind !== 'recovery.ended') {
        try { const data = JSON.parse(readObject(this.root, closed.ref).toString()), result = data.result ?? data; if (result.cleanup === 'unknown') value = 'unknown'; } catch { value = 'unknown'; }
      }
      this.states.set(task.runId, value);
    }
    return this.states.get(task.runId)!;
  }
  private readAvailability() {
    this.removed.clear(); this.originals.clear();
    if (!this.chains.through) return;
    for (const ref of records(this.root, { through: this.chains.through, kinds: ['evidence.availability'] })) {
      try { const data = decode(this.root, ref); if (data.state !== 'cleaned') continue; if (!data.sourceId && data.sessionId) this.removed.add(ref.runId); else if (data.sourceId) this.originals.add(ref.runId); } catch { /* unknown is never cleaned */ }
    }
  }
  private readPage(before?: number): SessionPage {
    const items: SessionSummary[] = []; let cursor = before, next: number | null = null;
    while (items.length < pageSize) {
      const page = this.chains.list({ before: cursor, limit: 1 });
      const s = page.items[0]; if (!s) break; cursor = s.lastSeq; next = page.next?.before ?? null;
      if (this.scope.project !== undefined && s.project !== this.scope.project && !(this.scope.project === this.workspace && s.workspace === this.workspace)) { if (!page.next) break; continue; }
      if (this.scope.status && stateOf(this.state(s.tail)) !== this.scope.status) { if (!page.next) break; continue; }
      if (this.scope.from && s.lastAt < this.scope.from || this.scope.to && s.lastAt >= this.scope.to) { if (!page.next) break; continue; }
      items.push(s); if (!page.next) break;
    }
    return { before, items, next, selected: 0, offset: 0, follow: true };
  }
  private openSession(id: string) {
    const session = this.chains.session(id); if (!session) return;
    const rows: TaskRow[] = []; let after: number | undefined;
    do { const page = this.chains.tasks(id, { after, limit: 50 }); rows.push(...page.items.map(task => ({ key: task.runId, task }))); after = page.next ?? undefined; } while (after !== undefined);
    let next: number | undefined;
    do {
      const page = readQueue(this.root, { after: next, through: this.chains.through, limit: 200 });
      rows.push(...page.items.filter(q => q.kind === 'follow-up' && !q.runId && this.chains.sessionOfRun(q.target.runId)?.id === id).map(queued => ({ key: `q:${queued.requestId}`, queued })));
      next = page.next ?? undefined;
    } while (next !== undefined);
    this.tasks = { session, rows, page: 0, selected: 0, offset: 0, follow: true };
  }
  private openBody(row: TaskRow) {
    const page = row.task ? readRunRecords(this.root, row.task.runId, { tail: true, before: this.chains.through + 1, limit: windowSize, kinds: VISIBLE_KINDS }) : undefined;
    this.body = { row, records: page?.records ?? [], offset: 0, expanded: false, toggled: new Set() };
  }
  private view(id: string) { if (!this.views.has(id)) this.views.set(id, new RunView(this.root, id)); return this.views.get(id)!; }
  private feedback(text: string) { this.host.feedback?.(text); }
  handleInput(data: string) {
    this.navigationRevision++;
    if (this.filter) {
      const result = this.filter.preset.handleInput(data);
      if (result === 'cancel') this.filter = undefined;
      else if (result === 'apply') { const scope = this.filter.scope; if (scope) { this.scope = scope; this.list = this.readPage(); this.previous = []; this.filter = undefined; } }
      this.host.changed?.(); return;
    }
    if (matchesKey(data, 'escape')) { this.back(); return; }
    if (this.body) {
      if (matchesKey(data, 'ctrl+o')) { this.body.expanded = !this.body.expanded; this.body.toggled.clear(); }
      else if (data === 't') { if (this.body.row.task) this.host.trace?.(this.body.row.task.runId); else this.feedback('未运行 · 尚无 run'); }
      else if (data === 'n' || data === 'p') {
        const b = this.body;
        if (b.row.task) {
          const page = readRunRecords(this.root, b.row.task.runId, { ...(data === 'p' ? { before: b.records[0]?.seq } : { after: b.records.at(-1)?.seq }), limit: windowSize, kinds: VISIBLE_KINDS, ...(data === 'n' ? { tail: false } : {}) });
          if (page.records.some(ref => ref.seq <= this.chains.through)) { b.records = page.records.filter(ref => ref.seq <= this.chains.through); b.offset = 0; } else this.feedback('已到正文窗口边界');
        }
      } else this.move(data, this.body);
      this.host.changed?.(); return;
    }
    const pos = this.tasks ?? this.list, rows = this.tasks ? this.tasks.rows.slice(this.tasks.page * pageSize, (this.tasks.page + 1) * pageSize) : this.list.items;
    const step = matchesKey(data, 'up') || matchesKey(data, 'shift+tab') ? -1 : matchesKey(data, 'down') || matchesKey(data, 'tab') ? 1 : 0;
    if (step) { pos.selected = Math.max(0, Math.min(rows.length - 1, pos.selected + step)); pos.follow = true; }
    else if (matchesKey(data, 'home')) { pos.selected = 0; pos.follow = true; }
    else if (matchesKey(data, 'end')) { pos.selected = Math.max(0, rows.length - 1); pos.follow = true; }
    else if (data === 'n' || data === 'p') {
      if (this.tasks) { const p = this.tasks.page + (data === 'n' ? 1 : -1); if (p >= 0 && p * pageSize < this.tasks.rows.length) { this.tasks.page = p; this.tasks.selected = 0; this.tasks.offset = 0; this.tasks.follow = true; } }
      else if (data === 'n' && this.list.next !== null) { this.previous.push(this.list); this.list = this.readPage(this.list.next); }
      else if (data === 'p' && this.previous.length) this.list = this.previous.pop()!;
    } else if (matchesKey(data, 'enter')) { if (this.tasks) { const row = rows[pos.selected] as TaskRow; if (row) this.openBody(row); } else { const s = rows[pos.selected] as SessionSummary; if (s) this.openSession(s.id); } }
    else if (data === 'c') { const s = this.tasks?.session ?? this.list.items[this.list.selected]; if (s) this.host.continue?.(s.id); }
    else if (data === 't') { const run = this.tasks ? (rows[pos.selected] as TaskRow)?.task?.runId : this.list.items[this.list.selected]?.tailRunId; if (run) this.host.trace?.(run); else this.feedback('未运行 · 尚无 run'); }
    else if (data === 'a' && this.tasks && this.host.annotate) { const task = this.selectedTask; if (task) this.host.annotate(task, () => this.refresh()); }
    else if (data === '/' && !this.tasks) {
      const projects = new Set<string>(); let before: number | undefined;
      do { const page = this.chains.list({ limit: 50, before }); page.items.forEach(s => { if (s.project) projects.add(s.project); }); before = page.next?.before; } while (before !== undefined);
      this.filter = new HistoryFilter(this.scope, this.workspace, [...projects]); this.filterOffset = 0;
    } else this.move(data, pos);
    this.host.changed?.();
  }
  private move(data: string, position: { offset: number }) { const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -5 : matchesKey(data, 'pageDown') ? 5 : 0; position.offset = Math.max(0, position.offset + delta); }
  scroll(delta: number) { this.navigationRevision++; const p = this.body ?? this.tasks ?? this.list; p.offset = Math.max(0, p.offset + delta); if ('follow' in p) p.follow = false; }
  click(y: number) { this.navigationRevision++; this.hits.get(y)?.(); this.host.changed?.(); }
  private metric(task: SessionTask) {
    if (!this.metrics.has(task.runId)) {
      try {
        const view = this.view(task.runId), trace = readTrace(this.root, task.runId), usage = sumUsage([view.usage()]);
        const rounds = view.updateProgress().round, tokens = trace.unknownTokens ? `${tokenCount(trace.tokens)}+unknown` : tokenCount(usage.tokens);
        this.metrics.set(task.runId, `${rounds} 轮 · ${trace.segments.length ? clock(trace.duration) : '用时未记录'} · ${tokens} tok ${formatCostTotals(usage.totals)}`);
      } catch { this.metrics.set(task.runId, '轮数/用时/用量未记录'); }
    }
    return this.metrics.get(task.runId)!;
  }
  private row(head: string, input: string, tail: string, width: number, selected: boolean, fg: TokenName, tier: ColorTier) {
    const start = `${selected ? '›' : ' '} ${head}`, room = Math.max(4, width - visibleWidth(start) - visibleWidth(tail));
    return styledLine([{ text: start, fg }, { text: truncateEnd(input, room), fg: 'fg.body' }, { text: tail, fg: 'fg.label' }], width, selected ? 'bg.selected' : undefined, tier);
  }
  render(width: number, height: number, tier: ColorTier = COLOR_TIER) {
    this.hits.clear();
    const line = (text: string, fg: TokenName = 'fg.label') => styledLine([{ text: clean(text), fg }], width, undefined, tier);
    if (this.filter) {
      const lines = this.filter.preset.render(width, tier), chosen = lines.findLastIndex(row => /^\s*›/.test(stripTerminalSequences(row)));
      const room = Math.max(1, height - 2); if (chosen >= this.filterOffset + room) this.filterOffset = chosen - room + 1; else if (chosen >= 0 && chosen < this.filterOffset) this.filterOffset = chosen;
      const frame = fixedFrame([line('◆ history · 筛选', 'fg.primary')], lines, [hintLine(this.filter.preset.hints(), width, { esc: 'Esc 返回上层', tier })], height, this.filterOffset);
      this.filterOffset = frame.offset; return frame.lines;
    }
    const header = [line('◆ history · 历史 · 只读', 'fg.primary')], body: string[] = [], actions = new Map<number, () => void>();
    const s = this.tasks?.session;
    if (s) { header[0] = line(`◆ history  ${this.index.label('session', s.id)} · ${s.workspace ?? '工作区未记录'} · ${status(this.state(s.tail)).label}`, 'fg.primary'); if (s.forkedFrom) header.push(line(`分支自 ${this.index.label('session', s.forkedFrom.sessionId)} 任务 ${s.forkedFrom.number}`)); }
    if (this.body) {
      const b = this.body, runId = b.row.task?.runId;
      header.push(line(`只读 · 不能提交${b.row.task ? ` · 任务 ${b.row.task.number} · ${this.index.label('run', b.row.task.runId)}` : ' · 未运行'}`, 'fg.label'));
      if (runId && this.removed.has(runId)) header.push(line('存储已清理 · 宿主正文保留', 'ac.warn'));
      if (runId && this.originals.has(runId)) header.push(line('部分原文已清理 · 可读正文照常显示', 'ac.warn'));
      let previous: string | undefined;
      const entries = runId ? this.view(runId).project(b.records, { active: false }) : [];
      if (!runId) body.push(...userLines(clean(b.row.queued?.input ?? ''), width, false, tier), line('未运行 · 没有模型与工具执行记录'));
      for (const entry of entries) {
        if (previous && !(previous === 'tool' && entry.kind === 'tool')) body.push(line(''));
        previous = entry.kind;
        if (entry.kind === 'user') body.push(...userLines(clean(entry.text), width, entry.steer, tier));
        else if (entry.kind === 'assistant') body.push(...assistantLines(clean(entry.text) + (entry.limited ? ' … [显示截断，t 在 trace 原文中继续阅读]' : ''), width, tier));
        else if (entry.kind === 'notice') body.push(...plainLines(`${entry.title}\n${clean(entry.text)}`, width, 'fg.muted', tier));
        else {
          const id = entry.attemptId, tool = toolLines({ ...entry, args: clean(entry.args), ...(entry.output ? { output: { ...entry.output, lines: entry.output.lines.map(clean) } } : {}), diff: entry.diff?.map(clean) }, width, b.expanded !== b.toggled.has(id), Date.now(), 0, tier);
          actions.set(body.length, () => { if (!b.toggled.delete(id)) b.toggled.add(id); });
          body.push(tool.row, ...tool.body);
          if (tool.paging) { actions.set(body.length, () => this.host.details?.(runId!, id)); body.push(tool.paging); }
        }
      }
      const footer = hintLine(['↑↓ 滚动', 'n/p 窗口', 'Ctrl+O 工具', 't trace'], width, { esc: 'Esc 返回上层', tier });
      const frame = fixedFrame(header, body, [footer], height, b.offset); b.offset = frame.offset;
      for (const [at, action] of actions) if (at >= b.offset && at < b.offset + height - header.length - 1) this.hits.set(header.length + at - b.offset, action);
      return frame.lines;
    }
    const pos = this.tasks ?? this.list;
    if (this.tasks) {
      this.tasks.rows.slice(this.tasks.page * pageSize, (this.tasks.page + 1) * pageSize).forEach((row, i) => {
        const t = row.task, state = t ? status(this.state(t)) : { glyph: '○', label: '未运行', fg: 'fg.muted' as TokenName };
        const changed = t && runVersionChanged(this.root, t.runId, this.chains) ? ' · 执行版本已变' : '';
        const cleaned = t && this.removed.has(t.runId) ? ' · 存储已清理' : t && this.originals.has(t.runId) ? ' · 部分原文已清理' : '';
        const tail = `${changed}${cleaned}${t && width >= 100 ? ` · ${this.metric(t)}` : ''}`;
        body.push(this.row(t ? `任务 ${t.number} · ${state.glyph} · ` : '未运行 · ', first(t?.input ?? row.queued?.input ?? ''), tail, width, i === pos.selected, state.fg, tier));
        actions.set(i, () => { pos.selected = i; pos.follow = true; this.openBody(row); });
      });
    } else {
      header.push(line(historyCommand(this.scope)));
      this.list.items.forEach((session, i) => {
        const state = status(this.state(session.tail)), own = this.chains.contextRunIds(session.tailRunId).filter(id => this.chains.sessionOfRun(id)?.id === session.id);
        const cleaned = own.some(id => this.removed.has(id)) ? ' · 存储已清理' : '';
        let usage = ''; if (width >= 100) { try { const total = sumUsage(own.map(id => this.view(id).usage())); usage = ` · ${tokenCount(total.tokens)} tok ${formatCostTotals(total.totals)}`; } catch { usage = ' · 用量未记录'; } }
        const tail = `${cleaned}${width >= 60 ? ` · ${session.tasks} 个任务 · ${session.lastAt.slice(0, 16).replace('T', ' ')}` : ''}${usage}`;
        body.push(this.row(`${state.glyph} ${this.index.label('session', session.id)} · ${session.kind === 'improve' ? 'improve · ' : ''}`, first(session.first.input), tail, width, i === pos.selected, state.fg, tier));
        actions.set(i, () => { pos.selected = i; pos.follow = true; this.openSession(session.id); });
      });
    }
    if (!body.length) body.push(line(`在${this.scope.project ? basename(this.scope.project) : '全部项目'}的所选范围内没有${this.tasks ? '任务' : '会话'} · / 调整范围`, 'fg.muted'));
    const hints = ['↑↓ 选择', `Enter ${this.tasks ? '正文' : '会话'}`, 'c 接续', 't trace', ...this.tasks && this.host.annotate ? ['a 补记'] : [], ...!this.tasks ? ['/ 筛选'] : [], 'n/p 翻页'];
    const room = Math.max(1, height - header.length - 1);
    if (pos.follow) { if (pos.selected < pos.offset) pos.offset = pos.selected; if (pos.selected >= pos.offset + room) pos.offset = pos.selected - room + 1; pos.follow = false; }
    const frame = fixedFrame(header, body, [hintLine(hints, width, { esc: this.tasks ? 'Esc 返回上层' : 'Esc 返回会话', tier })], height, pos.offset); pos.offset = frame.offset;
    for (const [at, action] of actions) if (at >= pos.offset && at < pos.offset + room) this.hits.set(header.length + at - pos.offset, action);
    return frame.lines;
  }
}
