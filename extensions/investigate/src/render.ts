// Rendering of the tool display. renderDisplay is a pure function of display
// state, width, and theme: it returns terminal lines and, per line, the step a
// click on it belongs to. The Pi edge at the bottom turns renderResult arguments
// and clicks into display events, runs the reducer, and executes its commands.
import { stripVTControlCharacters } from 'node:util';
import { mixColors, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Step, StepId } from './run.ts';
import {
  eventsFromRender, initDisplay, isOpen, reduceAll, reduceDisplay, RESULT_ID,
  type DisplayCommand, type DisplayEvent, type DisplayState,
} from './display.ts';
import { keepScrollPosition } from './scroll.ts';

export type Style = Pick<Theme, 'fg' | 'bg' | 'bold' | 'style' | 'colors'>;
type Fg = Parameters<Theme['fg']>[0];
type Bg = Parameters<Theme['bg']>[0];

const PREVIEW_LINES = 3;
const LABEL_WIDTH = 8;
// A semantic colour lane, not another background: existing request/tool/result
// colours remain intact. The index is stored in the snapshot for session replay.
const RAIL_COLORS: readonly Fg[] = ['accent', 'warning', 'success', 'mdLink'];
const RAIL_WIDTH = 2; // one coloured cell and one cell of space
// Sessions saved before colour lanes existed still get a deterministic rail.
const legacyRailIndex = (requestId: string) => {
  let hash = 0;
  for (const char of requestId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % RAIL_COLORS.length;
};

// Terminal-facing only: never transform model-facing answers or file content.
export function safeDisplay(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function describeTool(name: string, args: Record<string, unknown> = {}): string {
  const path = args.path ?? args.file_path ?? '.';
  if (name === 'read') {
    const offset = typeof args.offset === 'number' ? args.offset : 1;
    const range = typeof args.limit === 'number' ? `${offset}–${offset + args.limit - 1}` : `${offset} onward`;
    return `read ${path} (lines ${range})`;
  }
  if (name === 'grep') return `grep ${args.pattern ?? ''} in ${path}`;
  if (name === 'find') return `find ${args.pattern ?? ''} in ${path}`;
  if (name === 'ls') return `ls ${path}`;
  if (name === 'bash') return `$ ${args.command ?? ''}`;
  return name;
}

// How one step looks: a coloured box with a label, a title, a status marker, and a body.
type Status = 'info' | 'pending' | 'ok' | 'error';
type Box = { id: StepId; label: string; color: Fg; title: string; status: Status; body: string; durationMs?: number;
  tool?: { argumentsText: string; resultText?: string } };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const outcomeStatus = (outcome: 'pending' | 'ok' | 'error'): Status => outcome;

function stepBox(step: Step): Box {
  switch (step.kind) {
    case 'request': return { id: step.id, label: 'request', color: 'muted', title: '', status: 'info', body: step.question };
    case 'model': return { id: step.id, label: 'model', color: 'accent', title: '', status: step.live ? 'pending' : 'info', body: step.text };
    case 'tool': return {
      id: step.id, label: 'tool', color: 'toolTitle', title: describeTool(step.name, step.args), status: outcomeStatus(step.outcome), body: '',
      // Old session snapshots predate argumentsText/resultText; keep them replayable.
      tool: { argumentsText: step.argumentsText ?? JSON.stringify(step.args ?? {}, null, 2), resultText: step.resultText ?? (step as Step & { error?: string }).error },
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
    };
    case 'submit': return {
      id: step.id, label: 'submit', color: 'success', title: `submit_answer · ${plural(step.excerpts, 'excerpt')}`, status: outcomeStatus(step.outcome),
      body: step.error ? `${step.answer}\n\nRejected: ${step.error}` : step.answer,
    };
    case 'host': return { id: step.id, label: 'host', color: 'warning', title: '', status: 'info', body: step.text };
    case 'end': return { id: step.id, label: 'end', color: 'muted', title: `run ended · ${step.reason}`, status: step.reason === 'submitted' ? 'ok' : 'error', body: step.message ?? '' };
  }
}
const resultBox = (final: { text: string; failed: boolean }): Box =>
  ({ id: RESULT_ID, label: 'result', color: 'success', title: 'returned to the parent', status: final.failed ? 'error' : 'ok', body: final.text });

function background(box: Box): Bg {
  if (box.status === 'error') return 'toolErrorBg';
  if (box.label === 'request') return 'userMessageBg';
  if (box.label === 'model' || box.label === 'host') return 'customMessageBg';
  return box.status === 'ok' ? 'toolSuccessBg' : 'toolPendingBg';
}
function marker(box: Box): string {
  const seconds = box.durationMs === undefined ? '' : ` ${(box.durationMs / 1000).toFixed(1)}s`;
  if (box.status === 'ok') return `✓${seconds}`;
  if (box.status === 'error') return `✗${seconds}`;
  if (box.status === 'pending') return '…';
  return '';
}

// A click target: the step a line belongs to, and whether clicking it changes anything.
export type Target = { id: StepId; toggles: boolean };
export type Rendered = { lines: string[]; targets: (Target | undefined)[] };

// Closed: header and at most the last PREVIEW_LINES body lines. Open: the whole body.
function boxLines(box: Box, open: boolean, style: Style, width: number): Rendered {
  const fill = (line: string) => style.bg(background(box), truncateToWidth(` ${line} `, width, '…', true));
  const wrapBody = (text: string) => safeDisplay(text).split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - LABEL_WIDTH - 2)));
  const body = box.body.trim() ? wrapBody(box.body.trim()) : [];
  // Tool rows are always expandable, even while pending or with a short result.
  const toggles = !!box.tool || body.length > PREVIEW_LINES;
  const status = [marker(box), toggles ? (open ? '▾' : '▸') : ''].filter(Boolean).join(' ');
  const head = `${style.fg(box.color, style.bold(box.label.padEnd(LABEL_WIDTH)))}${safeDisplay(box.title)}`;
  const lines = [fill(status ? `${truncateToWidth(head, width - visibleWidth(status) - 3, '…', true)} ${style.fg(box.color, status)}` : head)];
  if (box.tool && open) {
    lines.push(fill('  arguments'));
    lines.push(...wrapBody(box.tool.argumentsText).map(line => fill(`${' '.repeat(LABEL_WIDTH)}${line}`)));
    // Derive a nearby green from the active theme, rather than hard-coding ANSI
    // or assuming that another semantic background token is green.
    const resultBg = box.status === 'ok'
      ? mixColors(style.colors.toolSuccessBg, style.colors.customMessageBg, 0.35)
      : undefined;
    const fillResult = (line: string) => {
      const text = truncateToWidth(` ${line} `, width, '…', true);
      return resultBg ? style.style(text, { bg: resultBg }) : style.bg(background(box), text);
    };
    lines.push(fillResult('  result'));
    const result = box.tool.resultText ?? 'waiting for result…';
    lines.push(...wrapBody(result).map(line => fillResult(`${' '.repeat(LABEL_WIDTH)}${line}`)));
  } else {
    const hidden = body.length - PREVIEW_LINES;
    const shown = toggles && !open ? [style.fg('dim', `… ${plural(hidden, 'more line')}`), ...body.slice(-PREVIEW_LINES)] : body;
    lines.push(...shown.map(line => fill(`${' '.repeat(LABEL_WIDTH)}${line}`)));
  }
  // The blank line above each box belongs to it, so a click there never reaches Pi's own toggle.
  return { lines: ['', ...lines], targets: [{ id: box.id, toggles: false }, ...lines.map(() => ({ id: box.id, toggles }))] };
}

// Every step is always shown; opening or closing one box changes only its own height.
export function renderDisplay(state: DisplayState, width: number, style: Style): Rendered {
  const w = Math.max(20, width);
  const innerWidth = w - RAIL_WIDTH;
  const view = state.snapshot;
  const index = view?.railIndex ?? legacyRailIndex(view?.requestId ?? '');
  const token = RAIL_COLORS[index % RAIL_COLORS.length] ?? RAIL_COLORS[0];
  const rail = style.fg(token, '▌') + ' ';
  if (!view) {
    const lines = wrapTextWithAnsi(style.fg(state.final?.failed ? 'error' : 'muted', safeDisplay(state.final?.text || 'Starting investigation…')), innerWidth);
    return { lines: lines.map(line => rail + line), targets: lines.map(() => undefined) };
  }
  const identity = view.handle ? style.fg('accent', style.bold(view.handle)) : style.fg('toolTitle', style.bold('investigate'));
  // While a run is active the phase says most; once it ends, the agent's status does.
  const phase = ['queued', 'starting', 'running'].includes(view.phase) ? view.phase : view.agentStatus ?? view.phase;
  const facts = [phase, plural(view.turns, 'model request'), state.defaultOpen ? view.model : undefined].filter(Boolean).join(' · ');
  const lines = [truncateToWidth(`◆ ${identity} ${style.fg('dim', `· ${safeDisplay(facts)}`)}`, innerWidth, '…')];
  if (view.note && view.phase !== 'running') {
    const color: Fg = view.phase === 'failed' || view.phase === 'cancelled' ? 'error' : 'muted';
    lines.push(...wrapTextWithAnsi(style.fg(color, safeDisplay(view.note)), innerWidth));
  }
  if (view.omitted) lines.push(style.fg('dim', truncateToWidth(`  ${plural(view.omitted, 'earlier step')} omitted from bounded UI history`, innerWidth, '…')));
  const targets: (Target | undefined)[] = lines.map(() => undefined);
  const boxes = view.steps.map(stepBox);
  if (state.final) boxes.push(resultBox(state.final));
  for (const box of boxes) {
    const rendered = boxLines(box, isOpen(state, box.id), style, innerWidth);
    lines.push(...rendered.lines);
    targets.push(...rendered.targets);
  }
  return { lines: lines.map(line => rail + line), targets };
}

// --- Pi edge ---------------------------------------------------------------

// Pi keeps context.state for the lifetime of one tool display; DisplayState lives in it.
type Holder = { display?: DisplayState };
type Edge = { holder: Holder; style: Style; pad: number; invalidate: () => void };

function execute(commands: DisplayCommand[], edge: Edge) {
  for (const command of commands) {
    if (command.type === 'holdScroll') keepScrollPosition();
    else edge.invalidate();
  }
}

// The renderer component. It renders the current DisplayState, memoized on state
// and width, and turns clicks into toggle events. A click on any line of a step
// is handled here, even when it changes nothing, so it never falls through to
// Pi's whole-tool expand toggle.
export class StepChain implements Component {
  edge?: Edge;
  private cache?: { edge: Edge; state: DisplayState; width: number; rendered: Rendered };
  render(width: number) {
    const edge = this.edge;
    const state = edge?.holder.display;
    if (!edge || !state) return [];
    if (this.cache?.edge !== edge || this.cache.state !== state || this.cache.width !== width) {
      const inner = renderDisplay(state, Math.max(1, width - 2 * edge.pad), edge.style);
      const pad = ' '.repeat(edge.pad);
      this.cache = { edge, state, width, rendered: { lines: inner.lines.map(line => pad + line), targets: inner.targets } };
    }
    return this.cache.rendered.lines;
  }
  dispatch(event: DisplayEvent) {
    const edge = this.edge;
    if (!edge?.holder.display) return;
    const [next, commands] = reduceDisplay(edge.holder.display, event);
    edge.holder.display = next;
    execute(commands, edge);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    const target = this.cache?.rendered.targets[event.y];
    if (!target) return undefined;
    if (event.type === 'click' && target.toggles) this.dispatch({ type: 'toggle', id: target.id });
    // The press stays unclaimed so text selection keeps working; Pi then
    // synthesizes the click and routes it here.
    return event.type === 'click' ? { handled: true } : undefined;
  }
  invalidate() { this.cache = undefined; }
}

class Text implements Component {
  lines: (width: number) => string[] = () => [];
  render(width: number) { return this.lines(width); }
  invalidate() {}
}

// Once the call is running, the result display carries the whole chain, including the question.
export const renderInvestigationCall: NonNullable<ToolDefinition['renderCall']> = (args, theme, context) => {
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text();
  const input = args as { question?: unknown } | undefined;
  const text = `${theme.fg('toolTitle', theme.bold('investigate '))}${safeDisplay(input?.question ?? 'Preparing question…')}`;
  const pad = ' '.repeat(context.outputPad);
  component.lines = context.executionStarted ? () => [] : width => wrapTextWithAnsi(text, Math.max(1, width - 2 * context.outputPad)).map(line => pad + line);
  return component;
};

// Edge: translates Pi's arguments into display events and runs them through the reducer.
export const renderInvestigationResult: NonNullable<ToolDefinition['renderResult']> = (result, options, theme, context) => {
  const component = context.lastComponent instanceof StepChain ? context.lastComponent : new StepChain();
  const holder = context.state as Holder;
  const edge: Edge = { holder, style: theme, pad: context.outputPad, invalidate: context.invalidate };
  component.edge = edge;
  const state = holder.display ?? initDisplay(options.expanded);
  const details = result.details as { snapshot?: DisplayState['snapshot'] } | undefined;
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const [next, commands] = reduceAll(state, eventsFromRender(state, {
    ...(details?.snapshot ? { snapshot: details.snapshot } : {}), text,
    isPartial: options.isPartial, isError: context.isError, expanded: options.expanded,
  }));
  holder.display = next;
  // Pi renders after renderResult returns, so only the scroll hold is needed here.
  execute(commands.filter(c => c.type !== 'redraw'), edge);
  return component;
};
