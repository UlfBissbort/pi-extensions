// Edge: turns an AgentView (plain data) into terminal lines. renderView is a pure
// function of view, options, theme, and width; the components only adapt it to Pi.
import { stripVTControlCharacters } from 'node:util';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentView, Block } from './view.ts';

export type Style = Pick<Theme, 'fg' | 'bg' | 'bold'>;
type Fg = Parameters<Theme['fg']>[0];
type Bg = Parameters<Theme['bg']>[0];
export type RenderOptions = { expanded: boolean; final?: string; open?: ReadonlySet<string> };

const COLLAPSED_BLOCKS = 5;
const COLLAPSED_LINES = 3;

// Terminal-facing only: never transform model-facing answers or file content.
export function safeDisplay(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

const LABEL: Record<Block['kind'], [string, Fg]> = {
  request: ['request', 'muted'], model: ['model', 'accent'], tool: ['tool', 'toolTitle'],
  submit: ['submit', 'success'], note: ['host', 'warning'], end: ['end', 'muted'],
};
function background(block: Block): Bg {
  if (block.status === 'error') return 'toolErrorBg';
  if (block.kind === 'request') return 'userMessageBg';
  if (block.kind === 'model' || block.kind === 'note') return 'customMessageBg';
  return block.status === 'ok' ? 'toolSuccessBg' : 'toolPendingBg';
}
function marker(block: Block): string {
  const seconds = block.durationMs === undefined ? '' : ` ${(block.durationMs / 1000).toFixed(1)}s`;
  if (block.status === 'ok') return `✓${seconds}`;
  if (block.status === 'error') return `✗${seconds}`;
  if (block.status === 'running' || block.status === 'streaming') return '…';
  return '';
}

// Which blocks show their full text is UI state, toggled per block by clicking it.
export type OpenBlocks = ReadonlySet<string>;
export const toggleBlock = (open: OpenBlocks, key: string): OpenBlocks => {
  const next = new Set(open);
  if (!next.delete(key)) next.add(key);
  return next;
};

// Rendered lines plus, per line, the key of the block a click on it toggles.
export type Rendered = { lines: string[]; hits: (string | undefined)[] };

function blockLines(block: Block, style: Style, width: number, open: boolean): Rendered {
  const [label, color] = LABEL[block.kind];
  const fill = (line: string) => style.bg(background(block), truncateToWidth(` ${line} `, width, '…', true));
  const text = safeDisplay(block.text).trim();
  const body = text ? text.split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 10))) : [];
  const collapsible = body.length > COLLAPSED_LINES;
  const toggle = collapsible ? (open ? '▾' : '▸') : '';
  const status = [marker(block), toggle].filter(Boolean).join(' ');
  const head = `${style.fg(color, style.bold(label.padEnd(8)))}${safeDisplay(block.title)}`;
  const lines = [fill(status ? `${truncateToWidth(head, width - visibleWidth(status) - 3, '…', true)} ${style.fg(color, status)}` : head)];
  const hidden = body.length - COLLAPSED_LINES;
  const shown = collapsible && !open ? [style.fg('dim', `… ${hidden} more line${hidden === 1 ? '' : 's'}`), ...body.slice(-COLLAPSED_LINES)] : body;
  lines.push(...shown.map(line => fill(`${' '.repeat(8)}${line}`)));
  return { lines, hits: lines.map(() => collapsible ? block.key : undefined) };
}

export function renderView(view: AgentView, style: Style, width: number, options: RenderOptions): Rendered {
  const w = Math.max(20, width);
  const open = options.open ?? new Set<string>();
  const identity = view.handle ? style.fg('accent', style.bold(view.handle)) : style.fg('toolTitle', style.bold('investigate'));
  // While a run is active the phase says most; once it ends, the agent's status does.
  const state = ['queued', 'starting', 'running'].includes(view.phase) ? view.phase : view.agentStatus ?? view.phase;
  const facts = [state, `${view.turns} model request${view.turns === 1 ? '' : 's'}`, options.expanded ? view.model : undefined].filter(Boolean).join(' · ');
  const lines = [truncateToWidth(`◆ ${identity} ${style.fg('dim', `· ${safeDisplay(facts)}`)}`, w, '…')];
  if (view.note && view.phase !== 'running') {
    const color: Fg = view.phase === 'failed' || view.phase === 'cancelled' ? 'error' : 'muted';
    lines.push(...wrapTextWithAnsi(style.fg(color, safeDisplay(view.note)), w));
  }
  const shown = options.expanded ? view.blocks : view.blocks.slice(-COLLAPSED_BLOCKS);
  const hidden = view.omitted + view.blocks.length - shown.length;
  if (hidden) lines.push(style.fg('dim', truncateToWidth(`  ${hidden} earlier step${hidden === 1 ? '' : 's'}${options.expanded ? ' omitted from bounded UI history' : ' · expand tool output to see more'}`, w, '…')));
  const hits: (string | undefined)[] = lines.map(() => undefined);
  for (const block of shown) {
    const rendered = blockLines(block, style, w, open.has(block.key));
    lines.push('', ...rendered.lines);
    hits.push(undefined, ...rendered.hits);
  }
  if (options.final !== undefined && options.expanded) {
    const final = ['', style.fg('muted', 'Result returned to the parent:'), ...safeDisplay(options.final).split('\n').flatMap(l => wrapTextWithAnsi(l, w))];
    lines.push(...final);
    hits.push(...final.map(() => undefined));
  }
  return { lines, hits };
}

// Adapts a pure draw function to Pi. A click on a block line toggles that block
// and is handled here; other clicks fall through to Pi's whole-tool expand toggle.
class Lines implements Component {
  draw: (width: number) => Rendered = () => ({ lines: [], hits: [] });
  onToggle?: (key: string) => void;
  private hits: (string | undefined)[] = [];
  render(width: number) {
    const { lines, hits } = this.draw(width);
    this.hits = hits;
    return lines;
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    const key = this.hits[event.y];
    if (key === undefined || !this.onToggle) return undefined;
    this.onToggle(key);
    return { handled: true };
  }
  invalidate() {}
}
const reuse = (last: unknown) => last instanceof Lines ? last : new Lines();
const padded = (draw: (width: number) => Rendered, pad: number) => (width: number): Rendered => {
  const { lines, hits } = draw(Math.max(1, width - 2 * pad));
  return { lines: lines.map(line => ' '.repeat(pad) + line), hits };
};
const textLines = (text: string) => (width: number): Rendered => {
  const lines = wrapTextWithAnsi(text, width);
  return { lines, hits: lines.map(() => undefined) };
};

// Once the call is running, the result view carries the whole chain, including the question.
export const renderInvestigationCall: NonNullable<ToolDefinition['renderCall']> = (args, theme, context) => {
  const component = reuse(context.lastComponent);
  const input = args as { question?: unknown } | undefined;
  const text = `${theme.fg('toolTitle', theme.bold('investigate '))}${safeDisplay(input?.question ?? 'Preparing question…')}`;
  component.draw = context.executionStarted ? () => ({ lines: [], hits: [] }) : padded(textLines(text), context.outputPad);
  return component;
};

export const renderInvestigationResult: NonNullable<ToolDefinition['renderResult']> = (result, options, theme, context) => {
  const component = reuse(context.lastComponent);
  // Pi keeps context.state for the lifetime of this tool display.
  const ui = context.state as { open?: OpenBlocks };
  const view = (result.details as { view?: AgentView } | undefined)?.view;
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  component.onToggle = key => { ui.open = toggleBlock(ui.open ?? new Set(), key); context.invalidate(); };
  component.draw = padded(view
    ? width => renderView(view, theme, width, { expanded: options.expanded, open: ui.open, ...(options.isPartial ? {} : { final: text }) })
    : textLines(theme.fg(context.isError ? 'error' : 'muted', safeDisplay(text || 'Starting investigation…'))), context.outputPad);
  return component;
};
