// UI in the Elm style: a UI model, messages that update it, and a pure view that
// turns it into plain, bounded data. Terminal rendering of that data lives in
// render.ts; timers and publishing live at the edge in extension.ts.
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { status, SUBMIT, turnsInRun, type InvestigationAgent, type ToolResult } from './agent.ts';

export type Phase = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

// Model: the agent record plus what is not yet a fact (phase, streaming text).
export type UiModel = {
  requestId: string; phase: Phase; note?: string; model?: string;
  agent?: InvestigationAgent;
  streaming?: AssistantMessage['content'];
};
export type UiMsg =
  | { type: 'phase'; phase: Phase; note?: string; model?: string }
  | { type: 'agent'; agent: InvestigationAgent }
  | { type: 'streaming'; content: AssistantMessage['content'] };

export const init = (requestId: string): UiModel => ({ requestId, phase: 'queued' });

export function update(model: UiModel, msg: UiMsg): UiModel {
  switch (msg.type) {
    case 'phase': return { ...model, phase: msg.phase, note: msg.note, model: msg.model ?? model.model };
    // A newly recorded fact supersedes any streaming preview.
    case 'agent': return { ...model, agent: msg.agent, streaming: undefined };
    case 'streaming': return { ...model, streaming: msg.content };
  }
}

// View: plain data, safe to store in tool-result details and bounded in size.
export type BlockKind = 'request' | 'model' | 'tool' | 'submit' | 'note' | 'end' | 'result';
export type BlockStatus = 'info' | 'streaming' | 'running' | 'ok' | 'error';
export type Block = { key: string; kind: BlockKind; status: BlockStatus; title: string; text: string; durationMs?: number };
export type AgentView = {
  requestId: string; handle?: string; phase: Phase; agentStatus?: string; note?: string; model?: string;
  turns: number; blocks: Block[]; omitted: number;
};

export const MAX_BLOCKS = 80;
export const MAX_BLOCK_TEXT = 6000;
export const MAX_TOTAL_TEXT = 24000;

const bounded = (text: string) => text.length <= MAX_BLOCK_TEXT
  ? text : `${text.slice(0, 2000)}\n… [UI preview shortened] …\n${text.slice(-3900)}`;

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

// One response becomes a model block (public text only; thinking is never shown)
// followed by one block per tool call, resolved against its result if recorded.
function responseBlocks(key: string, content: AssistantMessage['content'], results: Map<string, ToolResult>, live: boolean): Block[] {
  const blocks: Block[] = [];
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (text) blocks.push({ key: `${key}:text`, kind: 'model', status: live ? 'streaming' : 'info', title: '', text });
  for (const call of content.filter(b => b.type === 'toolCall')) {
    const result = results.get(call.id);
    const resolved: BlockStatus = !result ? (live ? 'streaming' : 'running') : result.isError ? 'error' : 'ok';
    const durationMs = result?.durationMs;
    if (call.name === SUBMIT) {
      const answer = typeof call.arguments?.text === 'string' ? call.arguments.text : '';
      const excerpts = Array.isArray(call.arguments?.excerpts) ? call.arguments.excerpts.length : 0;
      const rejected = result?.isError ? result.content.map(c => c.type === 'text' ? c.text : '').join('\n') : '';
      blocks.push({ key: `${key}:${call.id}`, kind: 'submit', status: resolved,
        title: `submit_answer · ${excerpts} excerpt${excerpts === 1 ? '' : 's'}`, text: rejected ? `${answer}\n\nRejected: ${rejected}` : answer });
    } else {
      const failure = result?.isError ? result.content.map(c => c.type === 'text' ? c.text : '').join('\n') : '';
      blocks.push({ key: `${key}:${call.id}`, kind: 'tool', status: resolved, title: describeTool(call.name, call.arguments), text: failure,
        ...(durationMs === undefined ? {} : { durationMs }) });
    }
  }
  return blocks;
}

export function agentBlocks(agent: InvestigationAgent): Block[] {
  const results = new Map(agent.context_.filter((e): e is ToolResult => e.__type === 'ET.ToolResult').map(r => [r.toolCallId, r]));
  return agent.context_.flatMap((e): Block[] => {
    switch (e.__type) {
      case 'ET.InvestigationRequest':
        return [{ key: e.__uid, kind: 'request', status: 'info', title: '', text: String(e.request.question ?? '') }];
      case 'ET.LLMResponse': return responseBlocks(e.__uid, e.content, results, false);
      case 'ET.HostInstruction': return [{ key: e.__uid, kind: 'note', status: 'info', title: '', text: e.content }];
      case 'ET.RunEnded':
        return [{ key: e.__uid, kind: 'end', status: e.reason === 'submitted' ? 'ok' : 'error', title: `run ended · ${e.reason}`, text: e.message ?? '' }];
      default: return [];
    }
  });
}

// Keep the newest blocks within count and size limits; report how many were dropped.
export function boundBlocks(blocks: Block[]): { blocks: Block[]; omitted: number } {
  const kept = blocks.map(b => ({ ...b, text: bounded(b.text) }));
  let total = kept.reduce((n, b) => n + b.text.length + b.title.length, 0);
  let omitted = 0;
  while (kept.length > 1 && (kept.length > MAX_BLOCKS || total > MAX_TOTAL_TEXT)) {
    const dropped = kept.shift()!;
    total -= dropped.text.length + dropped.title.length;
    omitted++;
  }
  return { blocks: kept, omitted };
}

export function view(model: UiModel): AgentView {
  const agent = model.agent;
  const recorded = agent ? agentBlocks(agent) : [];
  const live = model.streaming ? responseBlocks('live', model.streaming, new Map(), true) : [];
  const { blocks, omitted } = boundBlocks([...recorded, ...live]);
  return {
    requestId: model.requestId, phase: model.phase, blocks, omitted,
    turns: agent ? turnsInRun(agent) + (model.streaming ? 1 : 0) : 0,
    ...(agent ? { handle: `ET.InvestigationAgent('${agent.__uid}')`, agentStatus: status(agent) } : {}),
    ...(model.note === undefined ? {} : { note: model.note }),
    ...(model.model === undefined ? {} : { model: model.model }),
  };
}

