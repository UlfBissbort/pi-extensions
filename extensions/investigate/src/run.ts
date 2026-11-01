// One investigation run in the Elm style. Everything that happens is an event
// (plain data); reduceRun is the only thing that changes RunState and returns the
// commands the edge should execute next. Steps and snapshots are pure selectors.
//
// The worker loop lives here too: after every recorded fact the reducer derives
// the next step from the agent record (nextStep in agent.ts) and returns it as a
// command. The edge (worker.ts) performs the I/O and feeds the outcome back as an
// event. Facts get their UIDs and timestamps at the edge, so commands that add
// entries carry drafts.
import type { AssistantMessage, Context, ToolCall } from '@earendil-works/pi-ai';
import {
  config, nextStep, render, status, SUBMIT, turnsInRun,
  type AgentStatus, type Entry, type InvestigationAgent, type RunEndReason, type ToolResult,
} from './agent.ts';

export type Phase = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StreamingContent = AssistantMessage['content'];
type Effect = 'model' | 'tools' | 'record';

export type RunState = {
  requestId: string; railIndex: number; phase: Phase; note?: string; model?: string;
  agent?: InvestigationAgent;          // the append-only record; source of truth for facts
  streaming?: StreamingContent;        // partial model response, not yet a fact
  awaiting?: Effect;                   // the effect the edge is performing for this run
  stop?: { reason: RunEndReason; message: string };   // requested end, applied at the next step
};

export type RunEvent =
  | { type: 'phase'; phase: Phase; note?: string; model?: string }
  | { type: 'started'; agent: InvestigationAgent }            // config and request recorded
  | { type: 'appended'; entries: Entry[] }                    // facts; a tool batch arrives at once
  | { type: 'streamed'; content: StreamingContent }
  | { type: 'interrupted'; reason: RunEndReason; message: string }   // e.g. abort; the current effect may still finish
  | { type: 'failed'; reason: RunEndReason; message: string };       // the current effect threw

// Entries as decided by the reducer, before the edge gives them identity and time.
type Unstamped<E> = E extends Entry ? Omit<E, '__uid' | 'timestamp'> : never;
export type EntryDraft = Unstamped<Entry>;

export type RunCommand =
  | { type: 'publish'; throttle: boolean }
  | { type: 'callModel'; context: Context; sessionId: string }
  | { type: 'executeTools'; calls: ToolCall[] }
  | { type: 'record'; drafts: EntryDraft[] }
  | { type: 'done' };

export const initRun = (requestId: string, railIndex = 0): RunState => ({ requestId, railIndex, phase: 'queued' });

const without = <T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> => {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
};

// What the run does next, from data alone. A requested stop wins over the record's own next step.
function next(state: RunState): RunCommand[] {
  const agent = state.agent;
  if (!agent || status(agent) !== 'running') return [{ type: 'done' }];
  if (state.stop) return [{ type: 'record', drafts: [{ __type: 'ET.RunEnded', reason: state.stop.reason, message: state.stop.message }] }];
  const step = nextStep(agent);
  switch (step.kind) {
    case 'call_model': return [{ type: 'callModel', context: render(agent), sessionId: config(agent).sessionId }];
    case 'execute_tools': return [{ type: 'executeTools', calls: step.calls }];
    case 'block_batch': return [{ type: 'record', drafts: step.calls.map(call => ({
      __type: 'ET.ToolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: step.reason }], details: {}, isError: true,
    }) as EntryDraft) }];
    case 'instruct': return [{ type: 'record', drafts: [{ __type: 'ET.HostInstruction', content: step.content }] }];
    case 'end': return [{ type: 'record', drafts: [{ __type: 'ET.RunEnded', reason: step.reason, ...(step.message === undefined ? {} : { message: step.message }) }] }];
  }
}
const awaiting = (commands: RunCommand[]): Effect | undefined => {
  const c = commands.find(c => c.type === 'callModel' || c.type === 'executeTools' || c.type === 'record');
  return c?.type === 'callModel' ? 'model' : c?.type === 'executeTools' ? 'tools' : c?.type === 'record' ? 'record' : undefined;
};
const proceed = (state: RunState): [RunState, RunCommand[]] => {
  const commands = next(state);
  const effect = awaiting(commands);
  return [effect ? { ...state, awaiting: effect } : without(state, 'awaiting'), [{ type: 'publish', throttle: false }, ...commands]];
};

export function reduceRun(state: RunState, event: RunEvent): [RunState, RunCommand[]] {
  switch (event.type) {
    case 'phase': {
      const next = { ...without(state, 'note'), phase: event.phase, ...(event.note === undefined ? {} : { note: event.note }), model: event.model ?? state.model };
      return [next.model === undefined ? without(next, 'model') : next, [{ type: 'publish', throttle: false }]];
    }
    case 'started': {
      const c = config(event.agent);
      return proceed({ ...without(state, 'note', 'streaming', 'stop'), agent: event.agent, phase: 'running', model: `${c.provider}/${c.model}` });
    }
    case 'appended': {
      if (!state.agent) return [state, []];
      const agent = { ...state.agent, context_: [...state.agent.context_, ...event.entries] };
      // A recorded response supersedes its streaming preview.
      const recordedResponse = event.entries.some(e => e.__type === 'ET.LLMResponse');
      return proceed({ ...(recordedResponse ? without(state, 'streaming') : state), agent });
    }
    case 'streamed':
      return [{ ...state, streaming: event.content }, [{ type: 'publish', throttle: true }]];
    case 'interrupted': {
      if (state.stop) return [state, []];
      const stopped = { ...state, stop: { reason: event.reason, message: event.message } };
      // With an effect outstanding, its outcome is recorded first; the stop applies after it.
      return stopped.awaiting ? [stopped, []] : proceed(stopped);
    }
    case 'failed':
      return proceed({ ...without(state, 'awaiting', 'streaming'), stop: state.stop ?? { reason: event.reason, message: event.message } });
  }
}

// Steps: semantic, display-independent units of the chain. Ids come from what a
// step is, so a step keeps its id from streaming to recorded:
// request run:<k>:request · model text turn:<n>:text · tool or submit turn:<n>:call:<id>
// · host instruction its entry uid · run end run:<k>:end. n counts model requests
// within the agent, k counts runs.
export type StepId = string;
export type Outcome = 'pending' | 'ok' | 'error';
export type Step =
  | { id: StepId; kind: 'request'; question: string }
  | { id: StepId; kind: 'model'; text: string; live: boolean }
  | { id: StepId; kind: 'tool'; name: string; args: Record<string, unknown>; argumentsText: string; resultText?: string; outcome: Outcome; live: boolean; durationMs?: number }
  | { id: StepId; kind: 'submit'; answer: string; excerpts: number; outcome: Outcome; live: boolean; error?: string }
  | { id: StepId; kind: 'host'; text: string }
  | { id: StepId; kind: 'end'; reason: RunEndReason; message?: string };

// The terminal can show the model-visible text blocks. Never persist image data
// in the parent's UI snapshot: identify non-text blocks without copying their bytes.
const resultText = (content: ToolResult['content']) => content.map(c =>
  c.type === 'text' ? c.text : `[${c.type} content omitted from text display]`).join('\n') || '[empty result]';
// Only the arguments a step title can show; values are primitives.
const plainArgs = (args: Record<string, unknown> = {}) =>
  Object.fromEntries(Object.entries(args).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)));

// One response: its public text (thinking is never shown), then one step per tool call.
function responseSteps(turn: number, content: StreamingContent, live: boolean): Step[] {
  const out: Step[] = [];
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (text) out.push({ id: `turn:${turn}:text`, kind: 'model', text, live });
  content.forEach((block, index) => {
    if (block.type !== 'toolCall') return;
    const id = `turn:${turn}:call:${block.id || index}`;
    const args = block.arguments ?? {};
    out.push(block.name === SUBMIT
      ? { id, kind: 'submit', answer: typeof args.text === 'string' ? args.text : '', excerpts: Array.isArray(args.excerpts) ? args.excerpts.length : 0, outcome: 'pending', live }
      : { id, kind: 'tool', name: block.name, args: plainArgs(args), argumentsText: JSON.stringify(args, null, 2), outcome: 'pending', live });
  });
  return out;
}

export function steps(agent: InvestigationAgent | undefined, streaming?: StreamingContent): Step[] {
  const out: Step[] = [];
  let run = 0, turn = 0;
  for (const e of agent?.context_ ?? []) {
    switch (e.__type) {
      case 'ET.InvestigationRequest': run++; out.push({ id: `run:${run}:request`, kind: 'request', question: String(e.request.question ?? '') }); break;
      case 'ET.LLMResponse': turn++; out.push(...responseSteps(turn, e.content, false)); break;
      case 'ET.ToolResult': {
        // A result resolves its call in the latest response.
        const id = `turn:${turn}:call:${e.toolCallId}`;
        let i = out.length - 1;
        while (i >= 0 && out[i].id !== id) i--;
        const s = out[i];
        if (s?.kind !== 'tool' && s?.kind !== 'submit') break;
        const outcome = { outcome: e.isError ? 'error' as const : 'ok' as const };
        out[i] = s.kind === 'submit'
          ? { ...s, ...outcome, ...(e.isError ? { error: resultText(e.content) } : {}) }
          : { ...s, ...outcome, resultText: resultText(e.content), ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }) };
        break;
      }
      case 'ET.HostInstruction': out.push({ id: e.__uid, kind: 'host', text: e.content }); break;
      case 'ET.RunEnded': out.push({ id: `run:${run}:end`, kind: 'end', reason: e.reason, ...(e.message === undefined ? {} : { message: e.message }) }); break;
    }
  }
  if (streaming) out.push(...responseSteps(turn + 1, streaming, true));
  return out;
}

// The snapshot crosses from the worker to Pi's tool display in tool-result
// details, which Pi stores in the parent session. It holds semantic steps, never
// display strings or the full record, and is bounded so it stays small.
export type Snapshot = {
  requestId: string; railIndex: number; handle?: string;
  phase: Phase; agentStatus?: AgentStatus; note?: string; model?: string;
  turns: number;
  steps: Step[];
  omitted: number;                     // oldest steps dropped by the bounds
};

export const MAX_STEPS = 80;
export const MAX_STEP_TEXT = 6000;
export const MAX_TOTAL_TEXT = 24000;
const MAX_ARG_TEXT = 1000;

const bounded = (text: string, max = MAX_STEP_TEXT) => text.length <= max
  ? text : `${text.slice(0, Math.floor(max / 3))}\n… [UI preview shortened] …\n${text.slice(-Math.floor(max * 0.65))}`;

function boundStep(s: Step): Step {
  switch (s.kind) {
    case 'request': return { ...s, question: bounded(s.question) };
    case 'model': case 'host': return { ...s, text: bounded(s.text) };
    case 'tool': return { ...s, args: Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, typeof v === 'string' ? bounded(v, MAX_ARG_TEXT) : v])), argumentsText: bounded(s.argumentsText), ...(s.resultText === undefined ? {} : { resultText: bounded(s.resultText) }) };
    case 'submit': return { ...s, answer: bounded(s.answer), ...(s.error === undefined ? {} : { error: bounded(s.error) }) };
    case 'end': return s.message === undefined ? s : { ...s, message: bounded(s.message) };
  }
}
export const stepSize = (s: Step) => JSON.stringify(s).length;

// Keep the newest steps within count and size limits; report how many were dropped.
export function boundSteps(all: Step[]): { steps: Step[]; omitted: number } {
  const kept = all.map(boundStep);
  let total = kept.reduce((n, s) => n + stepSize(s), 0);
  let omitted = 0;
  while (kept.length > 1 && (kept.length > MAX_STEPS || total > MAX_TOTAL_TEXT)) {
    total -= stepSize(kept.shift()!);
    omitted++;
  }
  return { steps: kept, omitted };
}

export function snapshot(state: RunState): Snapshot {
  const agent = state.agent;
  const bound = boundSteps(steps(agent, state.streaming));
  return {
    requestId: state.requestId, railIndex: state.railIndex, phase: state.phase, ...bound,
    turns: agent ? turnsInRun(agent) + (state.streaming ? 1 : 0) : 0,
    ...(agent ? { handle: `ET.InvestigationAgent('${agent.__uid}')`, agentStatus: status(agent) } : {}),
    ...(state.note === undefined ? {} : { note: state.note }),
    ...(state.model === undefined ? {} : { model: state.model }),
  };
}
