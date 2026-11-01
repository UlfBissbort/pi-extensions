// Investigation agents as plain data. An agent is an identity (__uid) whose value
// is an append-only array of facts (context_). Everything here is pure: the model
// context, status, usage, and the next step are all derived from that array.
// Strings for the model are built only in render().
import type { AssistantMessage, Context, Message, ToolCall, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import { addUsage, zeroUsage } from './core.mjs';

export type Uid = `🍃-${string}`;
export type Limits = {
  maxTurns: number; timeoutSeconds: number; maxAnswerCharacters: number; maxResponseCharacters: number;
  maxExcerpts: number; maxExcerptCharacters: number; maxFileBytes: number;
};
export type ToolDeclaration = { name: string; description: string; parameters: any; constrainedSampling?: unknown };

export type InvestigationConfig = {
  __type: 'ET.InvestigationConfig'; __uid: Uid;
  provider: string; model: string; thinkingLevel: string; sessionId: string;
  workerPrompt: string; repositoryMapSource: string; repositoryMap: string;
  cwd: string; tools: ToolDeclaration[]; timestamp: number;
};
export type InvestigationRequest = {
  __type: 'ET.InvestigationRequest'; __uid: Uid;
  request: Record<string, unknown>; limits: Limits; timestamp: number;
};
export type HostInstruction = { __type: 'ET.HostInstruction'; __uid: Uid; content: string; timestamp: number };
export type LLMResponse = { __type: 'ET.LLMResponse'; __uid: Uid } & Omit<AssistantMessage, 'role'>;
export type ToolResult = { __type: 'ET.ToolResult'; __uid: Uid } & Omit<ToolResultMessage, 'role'>;
export type RunEndReason = 'submitted' | 'budget_exhausted' | 'cancelled' | 'error';
export type RunEnded = { __type: 'ET.RunEnded'; __uid: Uid; reason: RunEndReason; message?: string; timestamp: number };

export type Entry = InvestigationConfig | InvestigationRequest | HostInstruction | LLMResponse | ToolResult | RunEnded;
export type InvestigationAgent = { __type: 'ET.InvestigationAgent'; __uid: Uid; context_: Entry[] };

export const SUBMIT = 'submit_answer';
export const CORRECTIVE_INSTRUCTION = 'You ended without submit_answer. Submit your final answer now, explicitly identifying any incomplete findings. Use submit_answer alone.';
export const MIXED_BATCH_REASON = 'submit_answer must be the only call in the final batch. None of this batch was executed.';

export const append = (agent: InvestigationAgent, entry: Entry): InvestigationAgent =>
  ({ ...agent, context_: [...agent.context_, entry] });

const lastIndexOf = (entries: Entry[], type: Entry['__type']) => {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].__type === type) return i;
  return -1;
};

export function currentRun(agent: InvestigationAgent): Entry[] {
  const start = lastIndexOf(agent.context_, 'ET.InvestigationRequest');
  return start < 0 ? [] : agent.context_.slice(start);
}
export function config(agent: InvestigationAgent): InvestigationConfig {
  const found = agent.context_[lastIndexOf(agent.context_, 'ET.InvestigationConfig')];
  if (found?.__type !== 'ET.InvestigationConfig') throw new Error('Agent has no configuration');
  return found;
}
export function runLimits(agent: InvestigationAgent): Limits {
  const start = currentRun(agent)[0];
  if (start?.__type !== 'ET.InvestigationRequest') throw new Error('Agent has no active run');
  return start.limits;
}
export const responses = (entries: Entry[]) => entries.filter((e): e is LLMResponse => e.__type === 'ET.LLMResponse');
export const turnsInRun = (agent: InvestigationAgent) => responses(currentRun(agent)).length;
export const usage = (entries: Entry[]): Usage => responses(entries).reduce((u, r) => addUsage(u, r.usage), zeroUsage());
export const toolCalls = (response: LLMResponse): ToolCall[] =>
  response.content.filter((b): b is ToolCall => b.type === 'toolCall');

export type Submission = { text: string; warnings: string[]; excerpts: unknown[] };
export function acceptedSubmission(agent: InvestigationAgent): Submission | undefined {
  const result = currentRun(agent).find((e): e is ToolResult => e.__type === 'ET.ToolResult' && e.toolName === SUBMIT && !e.isError);
  return (result?.details as { response?: Submission } | undefined)?.response;
}

export type AgentStatus = 'running' | 'answered' | 'resumable' | 'empty';
export function status(agent: InvestigationAgent): AgentStatus {
  const last = agent.context_.at(-1);
  if (!last) return 'empty';
  if (last.__type !== 'ET.RunEnded') return 'running';
  return last.reason === 'submitted' ? 'answered' : 'resumable';
}

// What the run loop should do next, decided from data alone.
export type Step =
  | { kind: 'call_model' }
  | { kind: 'execute_tools'; calls: ToolCall[] }
  | { kind: 'block_batch'; calls: ToolCall[]; reason: string }
  | { kind: 'instruct'; content: string }
  | { kind: 'end'; reason: RunEndReason; message?: string };

export function nextStep(agent: InvestigationAgent): Step {
  const last = agent.context_.at(-1);
  const limits = runLimits(agent);
  const turns = turnsInRun(agent);
  const callModel = (): Step => turns >= limits.maxTurns
    ? { kind: 'end', reason: 'budget_exhausted', message: `Investigation exceeded ${limits.maxTurns} model requests` }
    : { kind: 'call_model' };
  if (!last || last.__type === 'ET.RunEnded') throw new Error('Agent has no active run');
  if (last.__type === 'ET.LLMResponse') {
    if (last.stopReason === 'error' || last.stopReason === 'aborted') {
      return { kind: 'end', reason: 'error', message: last.errorMessage || `Worker ${last.stopReason}` };
    }
    const calls = toolCalls(last);
    if (calls.some(c => c.name === SUBMIT) && calls.length !== 1) return { kind: 'block_batch', calls, reason: MIXED_BATCH_REASON };
    if (calls.length) return { kind: 'execute_tools', calls };
    const corrected = currentRun(agent).some(e => e.__type === 'ET.HostInstruction');
    if (!corrected && turns < limits.maxTurns) return { kind: 'instruct', content: CORRECTIVE_INSTRUCTION };
    return { kind: 'end', reason: 'error', message: `Incomplete investigation: no valid submit_answer after ${turns} requests` };
  }
  if (last.__type === 'ET.ToolResult' && acceptedSubmission(agent)) return { kind: 'end', reason: 'submitted' };
  return callModel();
}

export function systemPrompt(c: InvestigationConfig, limits: Limits): string {
  return `${c.workerPrompt}\n\n# Latest repository overview skill\nSource: ${c.repositoryMapSource}\n\n${c.repositoryMap}\n\n# Hard limits\nAt most ${limits.maxTurns} model requests. Final answer: ${limits.maxAnswerCharacters} characters. Total returned response including excerpts: ${limits.maxResponseCharacters} characters. At most ${limits.maxExcerpts} excerpts, each ${limits.maxExcerptCharacters} characters; they must also fit the total response budget. No recursive investigation.`;
}

// The model-facing projection. The leading system message carries the prompt and
// tool declarations, as Pi sends them; the request JSON becomes the first user turn.
export function render(agent: InvestigationAgent): Context {
  const messages: Message[] = [];
  let latestConfig: InvestigationConfig | undefined;
  for (const e of agent.context_) {
    switch (e.__type) {
      case 'ET.InvestigationConfig': latestConfig = e; break;
      case 'ET.InvestigationRequest': {
        if (!latestConfig) throw new Error('Request precedes configuration');
        messages.push({
          role: 'system', content: '', timestamp: latestConfig.timestamp,
          sections: { preamble: systemPrompt(latestConfig, e.limits), cwd: `<cwd>\n${latestConfig.cwd}\n</cwd>` },
          toolsAdded: latestConfig.tools,
        } as Message);
        messages.push({ role: 'user', content: [{ type: 'text', text: requestText(e.request) }], timestamp: e.timestamp });
        break;
      }
      case 'ET.HostInstruction': messages.push({ role: 'user', content: [{ type: 'text', text: e.content }], timestamp: e.timestamp }); break;
      case 'ET.LLMResponse': { const { __type, __uid, ...m } = e; messages.push({ role: 'assistant', ...m } as AssistantMessage); break; }
      case 'ET.ToolResult': { const { __type, __uid, ...m } = e; messages.push({ role: 'toolResult', ...m } as ToolResultMessage); break; }
      case 'ET.RunEnded': break;
    }
  }
  return { messages };
}

// Same text the session-based worker sent; the prefix originally kept user data
// from being treated as an extension slash command.
export const requestText = (request: Record<string, unknown>) => `Investigation request (task data):\n${JSON.stringify(request, null, 2)}`;
