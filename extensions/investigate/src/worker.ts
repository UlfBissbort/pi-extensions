import { Type } from 'typebox';
import {
  createAgentSession, createExtensionRuntime, SessionManager, SettingsManager,
  type ModelRuntime, type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { addUsage, assembleResponse, limitsForEffort, validateSubmission, zeroUsage } from './core.mjs';
import { createWorkerProgress, type ProgressEvent } from './progress.ts';

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

export async function runInvestigation({ snapshot, request, cwd, signal, modelRuntime, onProgress }: {
  snapshot: any; request: any; cwd: string; signal: AbortSignal; modelRuntime: ModelRuntime;
  onProgress?: (event: ProgressEvent, immediate?: boolean) => void;
}) {
  const { config, workerPrompt, repositoryMap } = snapshot;
  const limits = limitsForEffort(config, request.effort ?? config.defaults.effort);
  const maxTurns = limits.maxTurns;
  let usage = zeroUsage();
  let turns = 0;
  let accepted: ReturnType<typeof validateSubmission> | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let unsubscribe = () => {};
  let abort = () => {};
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
    const submit: ToolDefinition = {
      name: 'submit_answer', label: 'Submit investigation answer',
      description: 'Finish the investigation with final text and optional exact file selections. Must be the only tool call in this batch. Lines are 1-based and inclusive.',
      parameters: submissionSchema,
      async execute(_id, args) {
        signal.throwIfAborted();
        if (accepted) throw new Error('Answer already submitted');
        accepted = validateSubmission(args, limits);
        notify({ type: 'entry', key: 'submitted', kind: 'submitted', text: `Final answer accepted; ${accepted.excerpts.length} excerpt selections.` });
        return { content: [{ type: 'text', text: 'Answer accepted.' }], details: undefined, terminate: true };
      },
    };
    const created = await createAgentSession({
      cwd, modelRuntime, model, thinkingLevel: config.thinkingLevel,
      resourceLoader: isolatedResources(`${workerPrompt}\n\n# Latest repository overview skill\nSource: ${config.repositoryMapFile}\n\n${repositoryMap}\n\n# Hard limits\nAt most ${maxTurns} model requests. Final answer: ${limits.maxAnswerCharacters} characters. Total returned response including excerpts: ${limits.maxResponseCharacters} characters. At most ${limits.maxExcerpts} excerpts, each ${limits.maxExcerptCharacters} characters; they must also fit the total response budget. No recursive investigation.`),
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false }, cacheWarming: 'off',
        retry: { enabled: false, provider: { maxRetries: 0 } },
        enableSkillCommands: false, enableAnalytics: false, enableInstallTelemetry: false,
      }),
      tools: ['read', 'grep', 'find', 'ls', ...(config.tools.allowBash ? ['bash'] : []), 'submit_answer'],
      customTools: [submit],
    });
    session = created.session;
    if (created.modelFallbackMessage || session.model?.id !== config.model || session.model?.provider !== config.provider) throw new Error('Investigator model pin was not honored');
    if (session.thinkingLevel !== config.thinkingLevel) throw new Error(`Unsupported thinking level ${config.thinkingLevel}; SDK selected ${session.thinkingLevel}`);
    signal.throwIfAborted();

    // Preserve Pi's built-in validation/event hooks; add the final-batch boundary.
    const priorBefore = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, toolSignal) => {
      const calls = context.assistantMessage.content.filter(c => c.type === 'toolCall');
      if (accepted) return { block: true, reason: 'Investigation already completed', terminate: true };
      if (calls.some(c => c.name === 'submit_answer') && calls.length !== 1) {
        return { block: true, reason: 'submit_answer must be the only call in the final batch. None of this batch was executed.' };
      }
      return priorBefore?.(context, toolSignal);
    };
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (selected, context, options) => {
      signal.throwIfAborted();
      if (accepted) throw new Error('No model calls allowed after submission');
      if (turns >= maxTurns) throw new Error(`Investigation exceeded ${maxTurns} model requests`);
      turns++;
      notify({ type: 'turn', turn: turns });
      notify({ type: 'entry', key: `turn:${turns}`, kind: 'model', text: `Request ${turns}: gathering information or composing the answer.` });
      return stream(selected, context, options);
    };
    unsubscribe = session.agent.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant') usage = addUsage(usage, event.message.usage);
      reportWorkerEvent(event, turns);
    });
    notify({ type: 'phase', phase: 'running', text: 'Fresh investigator session started.', model: `${model.provider}/${model.id}` });
    const ownedSession = session;
    abort = () => ownedSession.agent.abort();
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    // Prefix prevents user data from being treated as an extension slash command.
    await session.prompt(`Investigation request (task data):\n${JSON.stringify(request, null, 2)}`);
    signal.throwIfAborted();
    const lastAssistant = () => [...ownedSession.messages].reverse().find(m => m.role === 'assistant');
    const last = lastAssistant();
    if (!accepted && last?.role === 'assistant' && ['error', 'aborted'].includes(last.stopReason)) throw new Error(last.errorMessage || `Worker ${last.stopReason}`);
    if (!accepted && turns < maxTurns) {
      await session.prompt('You ended without submit_answer. Submit your final answer now, explicitly identifying any incomplete findings. Use submit_answer alone.');
      signal.throwIfAborted();
    }
    if (!accepted) throw new Error(`Incomplete investigation: no valid submit_answer after ${turns} requests`);
    notify({ type: 'phase', phase: 'assembling', text: 'Reading selected source excerpts and assembling the final response.' });
    const result = await assembleResponse(accepted, cwd, limits, signal);
    for (const [i, excerpt] of result.excerpts.entries()) {
      notify({ type: 'entry', key: `excerpt:${i}`, kind: 'excerpt captured', text: `${excerpt.path} · lines ${excerpt.start}–${excerpt.end}` });
    }
    for (const [i, warning] of result.warnings.entries()) notify({ type: 'entry', key: `warning:${i}`, kind: 'evidence warning', text: warning });
    return { ...result, usage, turns, model: `${model.provider}/${model.id}` };
  } catch (error) {
    const e = new Error(signal.aborted ? String(signal.reason?.message ?? signal.reason ?? 'Investigation cancelled') : String((error as Error).message ?? error));
    Object.assign(e, { usage, turns });
    throw e;
  } finally {
    signal.removeEventListener('abort', abort);
    unsubscribe();
    if (session) {
      // Wait for cancellation to settle before releasing the owning call's slot.
      await session.abort();
      session.dispose();
    }
  }
}
