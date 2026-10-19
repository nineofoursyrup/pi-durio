/** Local, explicit export destination picker. No record write or execution permission is required. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { matchesKey } from '@earendil-works/pi-tui';
import { COLOR_TIER, styledLine, type ColorTier } from './theme.js';
import { SingleLineInput, LoadingState, clean, fixedFrame, hintLine } from './view-stack.js';

export interface ExportConfig { title: string; value: unknown; suggestedPath: string; cwd: string }
export interface ExportHost {
  copy(text: string): Promise<boolean | string>;
  feedback(text: string): void;
  changed(): void;
  done(): void;
}
/** The JSON is captured at construction. Enter performs the selected export directly, without a second confirmation. */
export class ExportDialog {
  private destination = 0;
  private readonly path: SingleLineInput;
  private loading?: LoadingState;
  private busy = false;
  private cancelled = false;
  private readonly text: string;
  constructor(readonly config: ExportConfig, private readonly host: ExportHost) {
    this.path = new SingleLineInput(config.suggestedPath);
    this.text = JSON.stringify(config.value, null, 2) + '\n';
  }
  cancel(): void { this.cancelled = true; this.loading?.cancel(); }
  get isEditing() { return this.destination === 1; }
  async handleInput(data: string): Promise<void> {
    if (this.busy || this.cancelled) return;
    if (matchesKey(data, 'up')) this.destination = 0;
    else if (matchesKey(data, 'down') || matchesKey(data, 'tab')) this.destination = this.destination === 0 ? 1 : 0;

    else if (matchesKey(data, 'enter')) {
      this.busy = true; this.loading = new LoadingState('导出', undefined, () => this.host.changed()); this.host.changed();
      try {
        if (this.destination === 0) {
          const result = await this.host.copy(this.text);
          if (this.cancelled) return;
          if (result !== true) throw Error(`复制失败 · ${String(result)}`);
          this.host.feedback(`已复制 JSON · ${Buffer.byteLength(this.text)} B`);
        } else {
          if (!this.path.getValue().trim()) throw Error('文件名不能为空');
          const target = resolve(this.config.cwd, this.path.getValue());
          await writeFile(target, this.text, { flag: 'wx', encoding: 'utf8' });
          if (this.cancelled) return;
          this.host.feedback(`已导出 ${target}`);
        }
        this.host.done();
      } catch (error) {
        if (!this.cancelled) this.host.feedback((error as NodeJS.ErrnoException).code === 'EEXIST' ? '文件已存在 · 请修改文件名，不覆盖已有文件' : clean(String(error)));
      } finally { this.busy = false; this.loading?.complete(); this.loading = undefined; if (!this.cancelled) this.host.changed(); }
      return;
    } else if (this.destination === 1) this.path.handleInput(data);
    this.host.changed();
  }
  render(width: number, height: number, tier: ColorTier = COLOR_TIER): string[] {
    const row = (text: string, selected = false) => styledLine([{ text, fg: selected ? 'fg.primary' : 'fg.body' }], width, selected ? 'bg.selected' : undefined, tier);
    return fixedFrame([row(`◆ ${this.config.title} · 导出 JSON`)], [
      '', row(`${this.destination === 0 ? '› ◉' : '  ○'} 复制到剪贴板`, this.destination === 0),
      row(`${this.destination === 1 ? '› ◉' : '  ○'} 存成文件`, this.destination === 1),
      row(`    ${this.destination === 1 ? this.path.render(Math.max(1, width - 4))[0] : this.path.getValue()}`),
      row('文件不覆盖已有内容 · 不调用模型 · 不写记录'),
      ...this.loading?.isShowing ? [this.loading.renderLine(width, tier)] : [],
    ], [hintLine(['↑↓ 目的地', ...(this.destination === 1 ? ['输入文件名', 'Ctrl+A 清空'] : []), 'Enter 导出'], width, { esc: 'Esc 返回上层', tier })], height, 0).lines;
  }
}
