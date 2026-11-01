import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Type } from 'typebox';
import { validateToolCall, type ToolCall } from '@earendil-works/pi-ai';
import {
  createBashTool, createExtensionRuntime, createFindTool, createGrepTool, createLsTool, createReadTool,
  type ModelRuntime, type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { assembleResponse, limitsForEffort, validateSubmission } from './core.mjs';
import { createWorkerProgress, type ProgressEvent } from './progress.ts';
import {
  acceptedSubmission, append, config as agentConfig, currentRun, nextStep, render, status, SUBMIT, turnsInRun, usage,
  type Entry, type InvestigationAgent, type LLMResponse, type RunEnded, type RunEndReason, type ToolDeclaration, type ToolResult, type Uid,
} from './agent.ts';

export const requestSchema = Type.Object({
  question: Type.String({ minLength: 1, description: 'Self-contained information need; the investigator cannot see your conversation.' }),
  context: Type.Optional(Type.String({ description: 'Relevant background and constraints only.' })),
  scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: 'Repository/collection aliases or paths to prioritize.' })),
  detail: Type.Optional(Type.Union([Type.Literal('brief'), Type.Literal('standard'), Type.Literal('detailed')], { description: 'Answer detail, not search depth. Default standard.' })),
  include_references: Type.Optional(Type.Boolean({ description: 'Optional further-reading links. Default true. Excerpts always retain provenance.' })),
  effort: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: 'Research and response budget, 0–10. Default 4; controls model requests, deadline, answer size, and excerpt count.' })),
}, { additionalProperties: false });

export const submissionSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  excerpts: Type.Optional(Type.Array(Type.Object({
    path: Type.String({ minLength: 1 }),
    start_line: Type.Optional(Type.Integer({ minimum: 1 })),
    end_line: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false }))),
}, { additionalProperties: false });

export function isolatedResources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const newUid = (): Uid => `🍃-${randomBytes(10).toString('hex')}`;
const errorText = (error: unknown) => [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }];

type ExecutableTool = ToolDeclaration & {
  execute(id: string, args: any, signal?: AbortSignal): Promise<{ content: ToolResult['content']; details?: unknown }>;
};
const declaration = ({ name, description, parameters, constrainedSampling }: ExecutableTool): ToolDeclaration =>
  ({ name, description, parameters, ...(constrainedSampling === undefined ? {} : { constrainedSampling }) });

// Boundary: runs one investigation as a loop over plain data. Each fact (model
// response, tool result, run end) is appended to the agent; the next step and the
// next model context are derived from the agent alone.
export async function runInvestigation({ snapshot, request, cwd, signal, modelRuntime, onProgress, onAgent }: {
  snapshot: any; request: any; cwd: string; signal: AbortSignal; modelRuntime: ModelRuntime;
  onProgress?: (event: ProgressEvent, immediate?: boolean) => void;
  onAgent?: (agent: InvestigationAgent) => void;
}) {
  const { config, workerPrompt, repositoryMap } = snapshot;
  const limits = limitsForEffort(config, request.effort ?? config.defaults.effort);
  let agent: InvestigationAgent = { __type: 'ET.InvestigationAgent', __uid: newUid(), context_: [] };
  const record = (entry: Entry) => {
    agent = append(agent, entry);
    try { onAgent?.(agent); } catch { /* Observers cannot alter execution. */ }
  };
  const runEnded = (reason: RunEndReason, message?: string): RunEnded =>
    ({ __type: 'ET.RunEnded', __uid: newUid(), reason, ...(message === undefined ? {} : { message }), timestamp: Date.now() });
  const notify = (event: ProgressEvent, immediate = true) => {
    try { onProgress?.(event, immediate); } catch { /* Progress observers cannot alter execution. */ }
  };
  const reportWorkerEvent = createWorkerProgress(notify);
  try {
    signal.throwIfAborted();
    const model = modelRuntime.getModel(config.provider, config.model);
    if (!model) throw new Error(`Unknown investigator model: ${config.provider}/${config.model}`);
    const available = await modelRuntime.getAvailable(config.provider, { signal });
    signal.throwIfAborted();
    if (!available.some(m => m.id === model.id && m.provider === model.provider)) throw new Error(`No available credentials for ${config.provider}/${config.model}`);
    const level = config.thinkingLevel;
    const levelMap = (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
    if (!THINKING_LEVELS.includes(level) || (level !== 'off' && (!model.reasoning || levelMap?.[level] === null))) {
      throw new Error(`Unsupported thinking level ${level} for ${config.provider}/${config.model}`);
    }

    const root = resolve(cwd);
    const submit: ExecutableTool = {
      name: SUBMIT,
      description: 'Finish the investigation with final text and optional exact file selections. Must be the only tool call in this batch. Lines are 1-based and inclusive.',
      parameters: submissionSchema,
      async execute(_id, args, toolSignal) {
        const accepted = validateSubmission(args, limits);
        notify({ type: 'entry', key: 'submitted', kind: 'submitted', text: `Final answer accepted; ${accepted.excerpts.length} excerpt selections.` });
        notify({ type: 'phase', phase: 'assembling', text: 'Reading selected source excerpts and assembling the final response.' });
        // Reading excerpts touches the file system, so the captured text is part of this fact.
        const response = await assembleResponse(accepted, root, limits, toolSignal);
        return { content: [{ type: 'text', text: 'Answer accepted.' }], details: { submission: accepted, response } };
      },
    };
    const tools: ExecutableTool[] = [
      createReadTool(root), createGrepTool(root), createFindTool(root), createLsTool(root),
      ...(config.tools.allowBash ? [createBashTool(root)] : []),
    ].map(t => t as unknown as ExecutableTool).concat(submit);
    const declarations = tools.map(declaration);
    const byName = new Map(tools.map(t => [t.name, t]));

    const now = Date.now();
    record({
      __type: 'ET.InvestigationConfig', __uid: newUid(),
      provider: model.provider, model: model.id, thinkingLevel: level, sessionId: randomUUID(),
      workerPrompt, repositoryMapSource: config.repositoryMapFile, repositoryMap,
      cwd: root, tools: declarations, timestamp: now,
    });
    record({ __type: 'ET.InvestigationRequest', __uid: newUid(), request, limits, timestamp: now });
    notify({ type: 'phase', phase: 'running', text: 'Fresh investigator session started.', model: `${model.provider}/${model.id}` });

    const callModel = async (): Promise<LLMResponse> => {
      const turn = turnsInRun(agent) + 1;
      notify({ type: 'turn', turn });
      notify({ type: 'entry', key: `turn:${turn}`, kind: 'model', text: `Request ${turn}: gathering information or composing the answer.` });
      const stream = modelRuntime.streamSimple(model, render(agent), {
        reasoning: level === 'off' ? undefined : level, sessionId: agentConfig(agent).sessionId, signal,
        transport: 'auto', timeoutMs: 300000, maxRetries: 0, maxRetryDelayMs: 60000,
      } as any);
      for await (const event of stream) {
        if ('partial' in event) reportWorkerEvent({ type: 'message_update', assistantMessageEvent: event }, turn);
      }
      const message = await stream.result();
      reportWorkerEvent({ type: 'message_end', message }, turn);
      const { role: _role, ...fields } = message;
      return { __type: 'ET.LLMResponse', __uid: newUid(), ...fields, thinkingLevel: level } as LLMResponse;
    };

    const runTool = async (call: ToolCall): Promise<ToolResult> => {
      const base = { __type: 'ET.ToolResult' as const, __uid: newUid(), toolCallId: call.id, toolName: call.name };
      let args: unknown;
      try {
        if (!byName.has(call.name)) throw new Error(`Tool "${call.name}" not found`);
        args = validateToolCall(declarations as any, call);
      } catch (error) {
        return { ...base, content: errorText(error), details: {}, isError: true, timestamp: Date.now() };
      }
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      try {
        const out = await byName.get(call.name)!.execute(call.id, args, signal);
        const details = out.details === undefined ? {} : { details: out.details };
        return { ...base, content: out.content, ...details, isError: false, durationMs: elapsed(), timestamp: Date.now() } as ToolResult;
      } catch (error) {
        return { ...base, content: errorText(error), details: {}, isError: true, durationMs: elapsed(), timestamp: Date.now() };
      }
    };
    const executeTool = async (call: ToolCall): Promise<ToolResult> => {
      const turn = turnsInRun(agent);
      reportWorkerEvent({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments }, turn);
      const result = await runTool(call);
      reportWorkerEvent({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result, isError: result.isError }, turn);
      return result;
    };

    while (true) {
      signal.throwIfAborted();
      const step = nextStep(agent);
      if (step.kind === 'end') { record(runEnded(step.reason, step.message)); break; }
      if (step.kind === 'instruct') record({ __type: 'ET.HostInstruction', __uid: newUid(), content: step.content, timestamp: Date.now() });
      else if (step.kind === 'call_model') record(await callModel());
      else if (step.kind === 'block_batch') {
        for (const call of step.calls) {
          record({ __type: 'ET.ToolResult', __uid: newUid(), toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: step.reason }], details: {}, isError: true, timestamp: Date.now() });
        }
      } else {
        // Calls run concurrently; results are recorded in call order.
        for (const result of await Promise.all(step.calls.map(executeTool))) record(result);
      }
    }

    const ended = agent.context_.at(-1) as RunEnded;
    if (ended.reason !== 'submitted') throw new Error(ended.message ?? `Investigation ended: ${ended.reason}`);
    const response = acceptedSubmission(agent)!;
    for (const [i, excerpt] of (response.excerpts as any[]).entries()) {
      notify({ type: 'entry', key: `excerpt:${i}`, kind: 'excerpt captured', text: `${excerpt.path} · lines ${excerpt.start}–${excerpt.end}` });
    }
    for (const [i, warning] of response.warnings.entries()) notify({ type: 'entry', key: `warning:${i}`, kind: 'evidence warning', text: warning });
    return { ...response, usage: usage(currentRun(agent)), turns: turnsInRun(agent), model: `${model.provider}/${model.id}`, agent };
  } catch (error) {
    const message = signal.aborted ? String(signal.reason?.message ?? signal.reason ?? 'Investigation cancelled') : String((error as Error).message ?? error);
    if (status(agent) === 'running') record(runEnded(signal.aborted ? 'cancelled' : 'error', message));
    const e = new Error(message);
    Object.assign(e, { usage: usage(currentRun(agent)), turns: turnsInRun(agent), agent });
    throw e;
  }
}
