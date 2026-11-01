import { randomUUID } from 'node:crypto';
import { ModelRuntime, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig, loadWorkerContext } from './config.mjs';
import { createSemaphore, limitsForEffort, normalizeRequest, zeroUsage } from './core.mjs';
import { requestSchema, runInvestigation } from './worker.ts';
import { createProgressReporter } from './progress.ts';
import { renderInvestigationCall, renderInvestigationResult } from './render.ts';

export async function registerInvestigation(pi: ExtensionAPI, root: string, dependencies = {
  createRuntime: (signal: AbortSignal) => ModelRuntime.create({ signal }),
}) {
  const initial = await loadConfig(root);
  const slots = createSemaphore(initial.config.limits.maxConcurrentInvestigations);
  const active = new Set<{ controller: AbortController; done: Promise<void> }>();
  let closed = false;

  pi.on('before_agent_start', async event => {
    if (event.systemPromptOptions.selectedTools.includes('investigate')) {
      const snapshot = await loadConfig(root);
      event.systemPromptOptions.sections.investigation = snapshot.parentPrompt;
    } else delete event.systemPromptOptions.sections.investigation;
  });
  pi.on('session_shutdown', async () => {
    closed = true;
    for (const call of active) call.controller.abort(new Error('Investigation extension shut down'));
    await Promise.allSettled([...active].map(call => call.done));
  });
  pi.registerTool({
    name: 'investigate', label: 'Investigate',
    description: 'Default information-gathering tool: delegate lookups, code/library exploration, and note retrieval to an isolated smaller model. Supply a self-contained question; it cannot see this conversation. Returns final text and optional exact source excerpts, never the exploration trace. Issue independent calls together for parallel investigation.',
    promptSnippet: 'Gather information in isolated context; return a focused answer and selected exact source excerpts',
    promptGuidelines: ['Prefer investigate for information gathering, including ordinary lookups. Ask independent questions in parallel calls.'],
    parameters: requestSchema,
    executionMode: 'parallel',
    renderCall: renderInvestigationCall,
    renderResult: renderInvestigationResult,
    // Unrestricted shell is available by default, so do not claim read-only safety.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async execute(_id, args, signal, onUpdate, ctx) {
      if (closed) throw new Error('Investigation extension is shutting down');
      const controller = new AbortController();
      const cancel = () => controller.abort(signal?.reason ?? new Error('Investigation cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const call = { controller, done };
      active.add(call);
      const started = Date.now();
      const requestId = randomUUID();
      const progress = createProgressReporter(requestId, started, state => {
        // Partial updates are UI events, not parent-model transcript messages.
        onUpdate?.({ content: [], details: { requestId, progress: state } });
      });
      progress.emit({ type: 'phase', phase: 'queued', text: 'Request accepted; waiting for an investigation slot.' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let release = () => {};
      try {
        const snapshot = await loadConfig(root);
        controller.signal.throwIfAborted();
        const request = normalizeRequest(args, snapshot.config);
        const remaining = limitsForEffort(snapshot.config, request.effort).timeoutSeconds * 1000 - (Date.now() - started);
        if (remaining <= 0) throw new Error('Investigation deadline exceeded');
        timer = setTimeout(() => controller.abort(new Error('Investigation deadline exceeded')), remaining);
        slots.setLimit(snapshot.config.limits.maxConcurrentInvestigations);
        release = await slots.acquire(controller.signal);
        progress.emit({ type: 'phase', phase: 'starting', text: 'Preparing model access and fresh starting context.', model: `${snapshot.config.provider}/${snapshot.config.model}` });
        const modelRuntime = await dependencies.createRuntime(controller.signal);
        // Re-read after admission: queued workers receive the current starting
        // instructions and repo skill, not the versions present before waiting.
        const freshSnapshot = { ...snapshot, ...await loadWorkerContext(root, snapshot.config) };
        controller.signal.throwIfAborted();
        progress.emit({ type: 'entry', key: 'context', kind: 'context loaded', text: `Initial prompt: ${snapshot.config.instructionsFile}\nRepo overview: ${snapshot.config.repositoryMapFile}` });
        const result = await runInvestigation({ snapshot: freshSnapshot, request, cwd: ctx.cwd, signal: controller.signal, modelRuntime, onProgress: progress.emit });
        progress.emit({ type: 'phase', phase: 'completed', text: `Investigation finished; ${result.excerpts.length} excerpts included${result.warnings.length ? `, ${result.warnings.length} evidence warnings` : ''}.` });
        return {
          content: [{ type: 'text' as const, text: result.text }],
          details: { requestId, progress: progress.snapshot(), model: result.model, turns: result.turns, elapsedMs: Date.now() - started, excerpts: result.excerpts, incompleteEvidence: result.warnings.length > 0 },
          usage: result.usage,
        };
      } catch (error) {
        const e = error as Error & { usage?: ReturnType<typeof zeroUsage>; turns?: number };
        progress.emit({ type: 'phase', phase: controller.signal.aborted ? 'cancelled' : 'failed', text: e.message });
        return {
          content: [{ type: 'text' as const, text: `Investigation failed or incomplete: ${e.message}` }],
          details: { requestId, progress: progress.snapshot(), turns: e.turns ?? 0, elapsedMs: Date.now() - started },
          usage: e.usage ?? zeroUsage(), isError: true,
        };
      } finally {
        progress.close();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        release(); active.delete(call); finish();
      }
    },
  });
}
