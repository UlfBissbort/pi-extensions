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
  name?: string;                       // drawn by the host at launch; absent in older records
  railIndex?: number;                  // the agent's colour lane, kept across its runs
};
export type InvestigationRequest = {
  __type: 'ET.InvestigationRequest'; __uid: Uid;
  request: Record<string, unknown>; limits: Limits; timestamp: number;
  from?: 'user';                       // the human user resumed the agent directly; otherwise the parent asked
};
export type HostInstruction = { __type: 'ET.HostInstruction'; __uid: Uid; content: string; timestamp: number };
// A message the human user sent to this investigator while it was running.
export type UserMessage = { __type: 'ET.UserMessage'; __uid: Uid; content: string; timestamp: number };
export type LLMResponse = { __type: 'ET.LLMResponse'; __uid: Uid } & Omit<AssistantMessage, 'role'>;
export type ToolResult = { __type: 'ET.ToolResult'; __uid: Uid } & Omit<ToolResultMessage, 'role'>;
export type RunEndReason = 'submitted' | 'budget_exhausted' | 'cancelled' | 'user_stopped' | 'user_hard_stopped' | 'error';
export const isUserStop = (reason?: RunEndReason) => reason === 'user_stopped' || reason === 'user_hard_stopped';
export type RunEnded = { __type: 'ET.RunEnded'; __uid: Uid; reason: RunEndReason; message?: string; timestamp: number; partial?: AssistantMessage['content']; usage?: Usage; interruptedModel?: boolean };
export type Handoff = {
  __type: 'ET.Handoff'; __uid: Uid; timestamp: number;
  trigger: '/stop' | '/stopp'; instruction: string; response?: AssistantMessage;
  outcome: 'summary' | 'fallback'; text: string; usage: Usage; error?: string;
};

export type Entry = InvestigationConfig | InvestigationRequest | HostInstruction | UserMessage | LLMResponse | ToolResult | RunEnded | Handoff;
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
export const agentName = (agent: InvestigationAgent): string | undefined => config(agent).name;
export const railOf = (agent: InvestigationAgent): number | undefined => config(agent).railIndex;
export function lastRequest(agent: InvestigationAgent): InvestigationRequest | undefined {
  const found = agent.context_[lastIndexOf(agent.context_, 'ET.InvestigationRequest')];
  return found?.__type === 'ET.InvestigationRequest' ? found : undefined;
}
export const userMessages = (entries: Entry[]) => entries.filter((e): e is UserMessage => e.__type === 'ET.UserMessage');
export const responses = (entries: Entry[]) => entries.filter((e): e is LLMResponse => e.__type === 'ET.LLMResponse');
export const turnsInRun = (agent: InvestigationAgent) => currentRun(agent).reduce((n, e) => n + (e.__type === 'ET.LLMResponse' || (e.__type === 'ET.RunEnded' && e.interruptedModel) ? 1 : 0), 0);
export const usage = (entries: Entry[]): Usage => entries.reduce((u, e) =>
  'usage' in e && e.usage ? addUsage(u, e.usage) : u, zeroUsage());
export const handoffOf = (agent?: InvestigationAgent): Handoff | undefined => agent && currentRun(agent).find((e): e is Handoff => e.__type === 'ET.Handoff');
export const toolCalls = (response: LLMResponse): ToolCall[] =>
  response.content.filter((b): b is ToolCall => b.type === 'toolCall');

export type Submission = { text: string; warnings: string[]; excerpts: unknown[] };
export function acceptedSubmission(agent: InvestigationAgent): Submission | undefined {
  const result = currentRun(agent).find((e): e is ToolResult => e.__type === 'ET.ToolResult' && e.toolName === SUBMIT && !e.isError);
  return (result?.details as { response?: Submission } | undefined)?.response;
}

export type AgentStatus = 'running' | 'answered' | 'resumable' | 'empty';
export function status(agent: InvestigationAgent): AgentStatus {
  const last = [...agent.context_].reverse().find(e => e.__type !== 'ET.Handoff');
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

const limitsText = (limits: Limits) => `At most ${limits.maxTurns} model requests. Final answer: ${limits.maxAnswerCharacters} characters. Total returned response including excerpts: ${limits.maxResponseCharacters} characters. At most ${limits.maxExcerpts} excerpts, each ${limits.maxExcerptCharacters} characters; they must also fit the total response budget. No recursive investigation.`;

export function systemPrompt(c: InvestigationConfig, limits: Limits): string {
  return `${c.workerPrompt}\n\n# Latest repository overview skill\nSource: ${c.repositoryMapSource}\n\n${c.repositoryMap}\n\n# Hard limits\n${limitsText(limits)}`;
}

// The model-facing projection. The leading system message carries the prompt and
// tool declarations, as Pi sends them; the request JSON becomes the first user turn.
// A later request continues the same conversation: it becomes a user turn with its
// own limits, and the leading system message stays unchanged so the cache holds.
export function render(agent: InvestigationAgent): Context {
  const messages: Message[] = [];
  let latestConfig: InvestigationConfig | undefined;
  for (const e of agent.context_) {
    switch (e.__type) {
      case 'ET.InvestigationConfig': latestConfig = e; break;
      case 'ET.InvestigationRequest': {
        if (!latestConfig) throw new Error('Request precedes configuration');
        if (messages.length) {
          const text = e.from === 'user' ? resumedByUserText(String(e.request.question ?? ''), e.limits) : continuationText(e.request, e.limits);
          messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp: e.timestamp });
          break;
        }
        messages.push({
          role: 'system', content: '', timestamp: latestConfig.timestamp,
          sections: { preamble: systemPrompt(latestConfig, e.limits), cwd: `<cwd>\n${latestConfig.cwd}\n</cwd>` },
          toolsAdded: latestConfig.tools,
        } as Message);
        messages.push({ role: 'user', content: [{ type: 'text', text: requestText(e.request) }], timestamp: e.timestamp });
        break;
      }
      case 'ET.HostInstruction': messages.push({ role: 'user', content: [{ type: 'text', text: e.content }], timestamp: e.timestamp }); break;
      case 'ET.UserMessage': messages.push({ role: 'user', content: [{ type: 'text', text: userMessageText(e.content) }], timestamp: e.timestamp }); break;
      case 'ET.LLMResponse': { const { __type, __uid, ...m } = e; messages.push({ role: 'assistant', ...m } as AssistantMessage); break; }
      case 'ET.ToolResult': { const { __type, __uid, ...m } = e; messages.push({ role: 'toolResult', ...m } as ToolResultMessage); break; }
      case 'ET.Handoff': {
        messages.push({ role: 'user', content: [{ type: 'text', text: e.instruction }], timestamp: e.timestamp });
        // Persist the actual response, closing any proposed calls without executing them.
        // This keeps the next continuation's prefix identical to the handoff exchange.
        if (e.response && e.response.stopReason !== 'aborted' && e.response.stopReason !== 'error') {
          messages.push(e.response);
          for (const call of e.response.content.filter((b): b is ToolCall => b.type === 'toolCall')) messages.push({
            role: 'toolResult', toolCallId: call.id, toolName: call.name,
            content: [{ type: 'text', text: call.name === SUBMIT ? 'Handoff recorded; no excerpts were fetched.' : 'Not executed: reporting only.' }],
            isError: call.name !== SUBMIT, timestamp: e.timestamp,
          } as ToolResultMessage);
        } else messages.push({ role: 'user', content: [{ type: 'text', text: `Host-generated handoff fallback:\n${e.text}` }], timestamp: e.timestamp });
        break;
      }
      case 'ET.RunEnded': {
        // A graceful stop can leave proposed calls unexecuted. Close those calls
        // in the model projection when resuming, without inventing recorded work.
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant') as AssistantMessage | undefined;
        for (const call of lastAssistant?.content.filter((b): b is ToolCall => b.type === 'toolCall') ?? []) {
          if (!messages.slice(messages.lastIndexOf(lastAssistant!) + 1).some(m => m.role === 'toolResult' && m.toolCallId === call.id)) messages.push({
            role: 'toolResult', toolCallId: call.id, toolName: call.name,
            content: [{ type: 'text', text: 'Not executed: the investigation ended before this tool batch started.' }],
            isError: true, timestamp: e.timestamp,
          } as ToolResultMessage);
        }
        break;
      }
    }
  }
  return { messages };
}

// Same text the session-based worker sent; the prefix originally kept user data
// from being treated as an extension slash command.
export const requestText = (request: Record<string, unknown>) => `Investigation request (task data):\n${JSON.stringify(request, null, 2)}`;
export const userMessageText = (content: string) =>
  `Message from the human user, sent to you while you were working. It takes precedence over the original request where they conflict; continue accordingly and finish with submit_answer.\n\n${content}`;
export const resumedByUserText = (content: string, limits: Limits) =>
  `The human user resumes this investigation directly with a message. Everything above is your own previous work; build on it and answer the message with submit_answer. The caller receives your answer together with the message. These limits replace the earlier ones.\n\n# Hard limits for this run\n${limitsText(limits)}\n\nMessage from the human user:\n${content}`;
export const continuationText = (request: Record<string, unknown>, limits: Limits) =>
  `The caller continues this investigation. Everything above is your own previous work; build on it rather than repeating it, and answer this follow-up with submit_answer. These limits replace the earlier ones.\n\n# Hard limits for this run\n${limitsText(limits)}\n\nFollow-up request (task data):\n${JSON.stringify(request, null, 2)}`;
