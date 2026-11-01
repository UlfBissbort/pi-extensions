import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Type } from 'typebox';
import { validateToolCall, type Context, type Model, type ToolCall } from '@earendil-works/pi-ai';
import {
  createBashTool, createExtensionRuntime, createFindTool, createGrepTool, createLsTool, createReadTool,
  type ModelRuntime, type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { assembleResponse, limitsForEffort, validateSubmission, zeroUsage } from './core.mjs';
import type { EntryDraft, RunCommand, RunEvent } from './run.ts';
import { createRunStore, type RunStore } from './store.ts';
import {
  acceptedSubmission, currentRun, SUBMIT, turnsInRun, usage,
  type Entry, type InvestigationAgent, type LLMResponse, type ToolDeclaration, type ToolResult, type Uid,
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

// Boundary: runs one investigation. The reducer (run.ts) decides every step from
// the agent record; this function only performs the commands it returns (model
// call, tool batch, recording an entry) and feeds each outcome back as an event.
// Facts get their UIDs and timestamps here, where they arrive.
export async function runInvestigation({ snapshot, request, cwd, signal, modelRuntime, store = createRunStore(randomUUID()) }: {
  snapshot: any; request: any; cwd: string; signal: AbortSignal; modelRuntime: ModelRuntime; store?: RunStore;
}) {
  const { config, workerPrompt, repositoryMap } = snapshot;
  const limits = limitsForEffort(config, request.effort ?? config.defaults.effort);
  const abortMessage = () => String(signal.reason?.message ?? signal.reason ?? 'Investigation cancelled');
  const failure = (agent: InvestigationAgent | undefined, message: string) =>
    Object.assign(new Error(message), agent ? { usage: usage(currentRun(agent)), turns: turnsInRun(agent), agent } : { usage: zeroUsage(), turns: 0 });

  let model: Model<any>, level: string, tools: ExecutableTool[];
  try {
    signal.throwIfAborted();
    model = modelRuntime.getModel(config.provider, config.model)!;
    if (!model) throw new Error(`Unknown investigator model: ${config.provider}/${config.model}`);
    const available = await modelRuntime.getAvailable(config.provider, { signal });
    signal.throwIfAborted();
    if (!available.some(m => m.id === model.id && m.provider === model.provider)) throw new Error(`No available credentials for ${config.provider}/${config.model}`);
    level = config.thinkingLevel;
    const levelMap = (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
    if (!THINKING_LEVELS.includes(level) || (level !== 'off' && (!model.reasoning || levelMap?.[level] === null))) {
      throw new Error(`Unsupported thinking level ${level} for ${config.provider}/${config.model}`);
    }
  } catch (error) {
    throw failure(undefined, signal.aborted ? abortMessage() : String((error as Error).message ?? error));
  }

  const root = resolve(cwd);
  const submit: ExecutableTool = {
    name: SUBMIT,
    description: 'Finish the investigation with final text and optional exact file selections. Must be the only tool call in this batch. Lines are 1-based and inclusive.',
    parameters: submissionSchema,
    async execute(_id, args, toolSignal) {
      const accepted = validateSubmission(args, limits);
      // Reading excerpts touches the file system, so the captured text is part of this fact.
      const response = await assembleResponse(accepted, root, limits, toolSignal);
      return { content: [{ type: 'text', text: 'Answer accepted.' }], details: { submission: accepted, response } };
    },
  };
  tools = [
    createReadTool(root), createGrepTool(root), createFindTool(root), createLsTool(root),
    ...(config.tools.allowBash ? [createBashTool(root)] : []),
  ].map(t => t as unknown as ExecutableTool).concat(submit);
  const declarations = tools.map(declaration);
  const byName = new Map(tools.map(t => [t.name, t]));
  const stamp = (draft: EntryDraft): Entry => ({ ...draft, __uid: newUid(), timestamp: Date.now() }) as Entry;

  const callModel = async (context: Context, sessionId: string): Promise<LLMResponse> => {
    const stream = modelRuntime.streamSimple(model, context, {
      reasoning: level === 'off' ? undefined : level, sessionId, signal,
      transport: 'auto', timeoutMs: 300000, maxRetries: 0, maxRetryDelayMs: 60000,
    } as any);
    for await (const event of stream) {
      // Pi's partial is one live object it keeps mutating; the state gets a copy.
      // Blocks are copied shallowly: providers replace arguments, never mutate them.
      if ('partial' in event) dispatch({ type: 'streamed', content: event.partial.content.map(block => ({ ...block })) });
    }
    const message = await stream.result();
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
  // Each effect yields exactly one event. Calls in a batch run concurrently; their
  // results are recorded together, in call order.
  const perform = async (command: RunCommand): Promise<RunEvent> => {
    switch (command.type) {
      case 'callModel': return { type: 'appended', entries: [await callModel(command.context, command.sessionId)] };
      case 'executeTools': return { type: 'appended', entries: await Promise.all(command.calls.map(runTool)) };
      case 'record': return { type: 'appended', entries: command.drafts.map(stamp) };
      default: throw new Error(`Not an effect: ${command.type}`);
    }
  };

  const queue: RunCommand[] = [];
  const dispatch = (event: RunEvent) => { queue.push(...store.dispatch(event)); };
  const interrupt = () => dispatch({ type: 'interrupted', reason: 'cancelled', message: abortMessage() });
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    const now = Date.now();
    const agent: InvestigationAgent = { __type: 'ET.InvestigationAgent', __uid: newUid(), context_: [
      {
        __type: 'ET.InvestigationConfig', __uid: newUid(),
        provider: model.provider, model: model.id, thinkingLevel: level, sessionId: randomUUID(),
        workerPrompt, repositoryMapSource: config.repositoryMapFile, repositoryMap,
        cwd: root, tools: declarations, timestamp: now,
      },
      { __type: 'ET.InvestigationRequest', __uid: newUid(), request, limits, timestamp: now },
    ] };
    dispatch({ type: 'started', agent });
    if (signal.aborted) interrupt();
    for (let command = queue.shift(); command && command.type !== 'done'; command = queue.shift()) {
      let event: RunEvent;
      try { event = await perform(command); } catch (error) {
        event = signal.aborted
          ? { type: 'failed', reason: 'cancelled', message: abortMessage() }
          : { type: 'failed', reason: 'error', message: String((error as Error).message ?? error) };
      }
      dispatch(event);
    }
  } finally {
    signal.removeEventListener('abort', interrupt);
  }

  const agent = store.state().agent!;
  const ended = agent.context_.at(-1);
  if (ended?.__type !== 'ET.RunEnded') throw failure(agent, 'Investigation stopped without ending its run');
  if (ended.reason !== 'submitted') throw failure(agent, ended.message ?? `Investigation ended: ${ended.reason}`);
  const response = acceptedSubmission(agent)!;
  return { ...response, usage: usage(currentRun(agent)), turns: turnsInRun(agent), model: `${model.provider}/${model.id}`, agent };
}
