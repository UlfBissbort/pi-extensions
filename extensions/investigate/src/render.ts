// Edge: turns an AgentView (plain data) into terminal lines. renderView is a pure
// function of view, options, theme, and width; the components only adapt it to Pi.
import { stripVTControlCharacters } from 'node:util';
import { truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentView, Block } from './view.ts';

export type Style = Pick<Theme, 'fg' | 'bg' | 'bold'>;
type Fg = Parameters<Theme['fg']>[0];
type Bg = Parameters<Theme['bg']>[0];
export type RenderOptions = { expanded: boolean; final?: string };

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

function blockLines(block: Block, style: Style, width: number, expanded: boolean): string[] {
  const [label, color] = LABEL[block.kind];
  const fill = (line: string) => style.bg(background(block), truncateToWidth(` ${line} `, width, '…', true));
  const status = marker(block);
  const head = `${style.fg(color, style.bold(label.padEnd(8)))}${safeDisplay(block.title)}`;
  const lines = [fill(status ? `${truncateToWidth(head, width - status.length - 3, '…', true)} ${style.fg(color, status)}` : head)];
  const text = safeDisplay(block.text).trim();
  if (text) {
    let body = text.split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 10)));
    if (!expanded && body.length > COLLAPSED_LINES) body = ['…', ...body.slice(-COLLAPSED_LINES)];
    lines.push(...body.map(line => fill(`${' '.repeat(8)}${line}`)));
  }
  return lines;
}

export function renderView(view: AgentView, style: Style, width: number, options: RenderOptions): string[] {
  const w = Math.max(20, width);
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
  for (const block of shown) lines.push('', ...blockLines(block, style, w, options.expanded));
  if (options.final !== undefined && options.expanded) {
    lines.push('', style.fg('muted', 'Result returned to the parent:'), ...safeDisplay(options.final).split('\n').flatMap(l => wrapTextWithAnsi(l, w)));
  }
  return lines;
}

class Lines implements Component {
  draw: (width: number) => string[] = () => [];
  render(width: number) { return this.draw(width); }
  invalidate() {}
}
const reuse = (last: unknown) => last instanceof Lines ? last : new Lines();
const padded = (draw: (width: number) => string[], pad: number) => (width: number) =>
  draw(Math.max(1, width - 2 * pad)).map(line => ' '.repeat(pad) + line);

// Once the call is running, the result view carries the whole chain, including the question.
export const renderInvestigationCall: NonNullable<ToolDefinition['renderCall']> = (args, theme, context) => {
  const component = reuse(context.lastComponent);
  const input = args as { question?: unknown } | undefined;
  const text = `${theme.fg('toolTitle', theme.bold('investigate '))}${safeDisplay(input?.question ?? 'Preparing question…')}`;
  component.draw = context.executionStarted ? () => [] : padded(width => wrapTextWithAnsi(text, width), context.outputPad);
  return component;
};

export const renderInvestigationResult: NonNullable<ToolDefinition['renderResult']> = (result, options, theme, context) => {
  const component = reuse(context.lastComponent);
  const view = (result.details as { view?: AgentView } | undefined)?.view;
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  component.draw = padded(width => view
    ? renderView(view, theme, width, { expanded: options.expanded, ...(options.isPartial ? {} : { final: text }) })
    : wrapTextWithAnsi(theme.fg(context.isError ? 'error' : 'muted', safeDisplay(text || 'Starting investigation…')), width), context.outputPad);
  return component;
};
