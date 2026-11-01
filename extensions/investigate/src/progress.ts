import { stripVTControlCharacters } from 'node:util';

export type ProgressPhase = 'queued' | 'starting' | 'running' | 'assembling' | 'completed' | 'failed' | 'cancelled';
export type ProgressEntry = { key: string; at: number; kind: string; text: string };
export type InvestigationProgress = {
  requestId: string; startedAt: number; phase: ProgressPhase; model?: string;
  turns: number; entries: ProgressEntry[]; omitted: number;
};
export type ProgressEvent =
  | { type: 'phase'; phase: ProgressPhase; text: string; model?: string }
  | { type: 'turn'; turn: number }
  | { type: 'entry'; key: string; kind: string; text: string };

const MAX_ENTRIES = 80;
const MAX_TEXT = 6000;
const MAX_TOTAL_TEXT = 24000;

// Terminal-facing only: never transform model-facing answers or file content.
export function safeDisplay(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
function boundedText(value: string): string {
  const text = safeDisplay(value);
  return text.length <= MAX_TEXT ? text : `${text.slice(0, 2000)}\n… [UI preview shortened] …\n${text.slice(-3900)}`;
}
export function initialProgress(requestId: string, startedAt: number): InvestigationProgress {
  return { requestId, startedAt, phase: 'queued', turns: 0, entries: [], omitted: 0 };
}
export function reduceProgress(state: InvestigationProgress, event: ProgressEvent, now = Date.now()): InvestigationProgress {
  const next = { ...state, entries: [...state.entries] };
  if (event.type === 'turn') next.turns = event.turn;
  const entry = event.type === 'entry' ? event : event.type === 'phase'
    ? { key: `phase:${event.phase}`, kind: event.phase, text: event.text } : undefined;
  if (event.type === 'phase') {
    next.phase = event.phase;
    if (event.model) next.model = event.model;
  }
  if (entry) {
    const index = next.entries.findIndex(e => e.key === entry.key);
    const previous = index >= 0 ? next.entries[index] : undefined;
    const updated = { key: entry.key, kind: entry.kind, text: boundedText(entry.text), at: previous?.at ?? now };
    if (index >= 0) next.entries[index] = updated;
    else next.entries.push(updated);
  }
  let total = next.entries.reduce((n, e) => n + e.text.length, 0);
  while (next.entries.length > MAX_ENTRIES || total > MAX_TOTAL_TEXT) {
    total -= next.entries.shift()!.text.length;
    next.omitted++;
  }
  return next;
}

export function describeTool(name: string, args: Record<string, unknown> = {}): string {
  const path = args.path ?? args.file_path ?? '.';
  if (name === 'read') {
    const offset = typeof args.offset === 'number' ? args.offset : 1;
    const range = typeof args.limit === 'number' ? `${offset}–${offset + args.limit - 1}` : `${offset} onward`;
    return `read ${path} (requested lines ${range})`;
  }
  if (name === 'grep') return `grep ${args.pattern ?? ''} in ${path}`;
  if (name === 'find') return `find ${args.pattern ?? ''} in ${path}`;
  if (name === 'ls') return `ls ${path}`;
  if (name === 'bash') return `$ ${args.command ?? ''}`;
  if (name === 'submit_answer') return `submit_answer (${Array.isArray(args.excerpts) ? args.excerpts.length : 0} excerpt selections)`;
  return name;
}

export function createWorkerProgress(emit: (event: ProgressEvent, immediate?: boolean) => void) {
  const pendingTools = new Map<string, string>();
  return (event: any, turn: number) => {
    if (event.type === 'tool_execution_start') {
      const description = safeDisplay(describeTool(event.toolName, event.args)).slice(0, MAX_TEXT);
      pendingTools.set(event.toolCallId, description);
      emit({ type: 'entry', key: `tool:${event.toolCallId}`, kind: 'tool started', text: description });
    } else if (event.type === 'tool_execution_end') {
      const description = pendingTools.get(event.toolCallId) ?? event.toolName;
      pendingTools.delete(event.toolCallId);
      // Do not forward raw read/search results or command output to the UI log.
      const truncated = event.result?.details?.truncation?.truncated ? ' [tool output truncated]' : '';
      emit({ type: 'entry', key: `tool:${event.toolCallId}`, kind: event.isError ? 'tool failed' : 'tool completed', text: description + truncated });
    } else if (event.type === 'message_update' || event.type === 'message_end') {
      const update = event.assistantMessageEvent;
      // Only public assistant text and parsed submission arguments. Never forward
      // thinking blocks, raw argument JSON fragments, or provider reasoning events.
      if (event.type === 'message_update' && !['text_start', 'text_delta', 'text_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end'].includes(update?.type)) return;
      const message = event.type === 'message_update' ? update.partial : event.message;
      if (message?.role !== 'assistant') return;
      message.content.forEach((block: any, index: number) => {
        if (block.type === 'text' && block.text) {
          emit({ type: 'entry', key: `text:${turn}:${index}`, kind: 'writing', text: block.text }, event.type === 'message_end');
        } else if (block.type === 'toolCall' && block.name === 'submit_answer' && typeof block.arguments?.text === 'string') {
          emit({ type: 'entry', key: `answer:${turn}:${index}`, kind: 'answer draft', text: block.arguments.text }, event.type === 'message_end');
        }
      });
    }
  };
}

export function progressLines(state: InvestigationProgress, expanded: boolean): string[] {
  const id = `inv-${state.requestId.slice(0, 8)}`;
  const prefix = `[${id}]`;
  const header = `${prefix} ${state.phase}${state.model ? ` · ${safeDisplay(state.model)}` : ''} · ${state.turns} model requests`;
  const lines = [header];
  if (expanded) lines.push(`${prefix} UID: ${state.requestId}`);
  if (state.omitted) lines.push(`${prefix} ${state.omitted} earlier activity entries omitted from bounded UI history`);
  const entries = expanded ? state.entries : state.entries.slice(-5);
  if (!expanded && state.entries.length > entries.length) lines.push(`${prefix} Expand tool output for earlier activity`);
  for (const entry of entries) {
    const seconds = Math.max(0, (entry.at - state.startedAt) / 1000).toFixed(1);
    const body = expanded ? entry.text.split('\n') : entry.text.split('\n').slice(-3).map(s => s.length > 180 ? `${s.slice(0, 177)}…` : s);
    body.forEach((line, i) => lines.push(`${prefix} ${i === 0 ? `+${seconds}s ${entry.kind}: ` : '  '}${line}`));
  }
  return lines;
}

// Batched text deltas refresh at most every 100 ms; discrete events flush
// immediately. The snapshot is immutable, so partial results cannot mutate later.
export function createProgressReporter(requestId: string, startedAt: number, publish?: (progress: InvestigationProgress) => void) {
  let state = initialProgress(requestId, startedAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!closed && publish) {
      try { publish(state); } catch { /* UI failure must not abort a paid investigation. */ }
    }
  };
  return {
    emit(event: ProgressEvent, immediate = true) {
      if (closed) return;
      state = reduceProgress(state, event);
      if (immediate) flush();
      else if (!timer) timer = setTimeout(flush, 100);
    },
    snapshot: () => state,
    close() { if (timer) clearTimeout(timer); timer = undefined; closed = true; },
  };
}
