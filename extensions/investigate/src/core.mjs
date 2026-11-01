import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
export function nonblank(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
export function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
export function normalizeRequest(raw, config) {
  exactKeys(raw, ['question', 'context', 'scope', 'detail', 'include_references', 'effort'], 'request');
  nonblank(raw.question, 'question');
  if (raw.context !== undefined && typeof raw.context !== 'string') throw new Error('context must be a string');
  if (raw.effort !== undefined && (!Number.isSafeInteger(raw.effort) || raw.effort < 0 || raw.effort > 10)) throw new Error('effort must be an integer from 0 to 10');
  if (raw.scope !== undefined) {
    if (!Array.isArray(raw.scope)) throw new Error('scope must be an array');
    raw.scope.forEach(s => nonblank(s, 'scope entry'));
  }
  const result = {
    ...raw, question: raw.question.trim(), scope: raw.scope ?? [],
    detail: raw.detail ?? config.defaults.detail,
    include_references: raw.include_references ?? config.defaults.includeReferences,
    effort: raw.effort ?? config.defaults.effort,
  };
  if (!['brief', 'standard', 'detailed'].includes(result.detail)) throw new Error('Invalid detail');
  if (typeof result.include_references !== 'boolean') throw new Error('include_references must be boolean');
  if (JSON.stringify(result).length > config.limits.maxRequestCharacters) throw new Error('Request exceeds maxRequestCharacters');
  return result;
}

export const EFFORT_FIELDS = ['maxTurns', 'timeoutSeconds', 'maxAnswerCharacters', 'maxResponseCharacters', 'maxExcerpts'];

export function limitsForEffort(config, effort) {
  if (!Number.isSafeInteger(effort) || effort < 0 || effort > 10) throw new Error('effort must be an integer from 0 to 10');
  const { minimum, maximum, exponent } = config.effortScale;
  const pivot = 4;
  /*
   * Effort is the parent's single research-and-response budget, not a target answer
   * length. The configured limits are the pivot (effort 4), with independently
   * configurable floors (0) and ceilings (10). Below the pivot we interpolate
   * linearly so small lookups remain useful. Above it, a mildly convex curve
   * (fraction ** exponent, default 1.3) reserves the largest budgets for 9–10
   * without making 8 trivial. Round each operational cap to a whole unit.
   * The text and excerpt limits are ceilings, not quotas: a concise answer is
   * preferred, and total response space can prevent all excerpts from fitting.
   * A deadline is likewise a ceiling, not a guarantee that every call completes.
   */
  const fraction = effort <= pivot ? effort / pivot : ((effort - pivot) / (10 - pivot)) ** exponent;
  const from = effort <= pivot ? minimum : config.limits;
  const to = effort <= pivot ? config.limits : maximum;
  return { ...config.limits, ...Object.fromEntries(EFFORT_FIELDS.map(key => [key, Math.round(from[key] + (to[key] - from[key]) * fraction)])) };
}

export function validateSubmission(raw, limits) {
  exactKeys(raw, ['text', 'excerpts'], 'submission');
  nonblank(raw.text, 'text');
  if (raw.text.length > limits.maxAnswerCharacters) throw new Error('Answer exceeds maxAnswerCharacters; shorten it and resubmit');
  const excerpts = raw.excerpts ?? [];
  if (!Array.isArray(excerpts) || excerpts.length > limits.maxExcerpts) throw new Error('Invalid or excessive excerpts');
  for (const e of excerpts) {
    exactKeys(e, ['path', 'start_line', 'end_line'], 'excerpt');
    nonblank(e.path, 'excerpt path');
    if (e.path.includes('\0') || e.path.length > 4096) throw new Error('Invalid excerpt path');
    for (const key of ['start_line', 'end_line']) if (e[key] !== undefined) positive(e[key], key);
    if (e.start_line !== undefined && e.end_line !== undefined && e.start_line > e.end_line) throw new Error('Reversed line range');
  }
  return { text: raw.text, excerpts: excerpts.map(e => ({ ...e })) };
}

// Splitting retains original line terminators, including CRLF. A final newline is
// part of its preceding line, not an extra empty line.
export function selectLines(text, selection) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (!lines.length) {
    if (selection.start_line !== undefined || selection.end_line !== undefined) throw new Error('Empty file has no numbered lines');
    return { text: '', start: 0, end: 0 };
  }
  const start = selection.start_line ?? 1;
  const end = selection.end_line ?? lines.length;
  positive(start, 'start_line'); positive(end, 'end_line');
  if (start > end || end > lines.length) throw new Error(`Range outside file (1–${lines.length})`);
  return { text: lines.slice(start - 1, end).join(''), start, end };
}

// XML-like framing, not XML serialization: source text is never entity-escaped.
// A deterministic collision-free suffix keeps embedded fake closing tags inert
// as delimiters (but cannot make malicious source safe for a language model).
export function frame(kind, text) {
  let suffix = '';
  let n = 0;
  while (text.includes(`<${kind}${suffix}>`) || text.includes(`</${kind}${suffix}>`)) suffix = `_${++n}`;
  const tag = `${kind}${suffix}`;
  return `<${tag}>\n${text}\n</${tag}>`;
}

export async function readBoundedText(path, maxBytes, signal) {
  signal?.throwIfAborted();
  // O_NONBLOCK avoids hanging on a named pipe before fstat can reject it.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) throw new Error('Binary content is not supported');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, captured: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}

export async function assembleResponse(submission, cwd, limits, signal, read = readBoundedText) {
  const parts = [frame('investigation_answer', submission.text)];
  const warnings = [];
  const snapshots = new Map();
  const metadata = [];
  // Reserve enough room for one compact warning per requested excerpt.
  const reserve = submission.excerpts.length * 180 + 200;
  let length = parts[0].length;
  if (length + reserve > limits.maxResponseCharacters) throw new Error('Answer leaves no room within maxResponseCharacters');
  for (let i = 0; i < submission.excerpts.length; i++) {
    signal?.throwIfAborted();
    const selection = submission.excerpts[i];
    const path = resolve(cwd, selection.path);
    try {
      if (!snapshots.has(path)) snapshots.set(path, await read(path, limits.maxFileBytes, signal));
      const snapshot = snapshots.get(path);
      const selected = selectLines(snapshot.text, selection);
      if (selected.text.length > limits.maxExcerptCharacters) throw new Error('Excerpt exceeds maxExcerptCharacters');
      const lineLabel = selected.start === 0 ? 'empty file (no numbered lines)' : `${selected.start}–${selected.end} (inclusive)`;
      const label = `Excerpt: ${i + 1}\nPath: ${path}\nLines: ${lineLabel}\nCaptured: ${snapshot.captured}\nSnapshot: submission-time read; earlier inspected version not verified.\n${frame('content', selected.text)}`;
      const rendered = frame('source_excerpt', label);
      if (length + rendered.length + 2 + reserve > limits.maxResponseCharacters) throw new Error('Excerpt exceeds total response budget');
      parts.push(rendered); length += rendered.length + 2;
      metadata.push({ path, start: selected.start, end: selected.end, captured: snapshot.captured, sha256: snapshot.sha256 });
    } catch (error) {
      signal?.throwIfAborted();
      // Short path labels prevent adversarial paths/errors from bypassing output limits.
      const short = path.length > 65 ? `…${path.slice(-64)}` : path;
      const reason = String(error.message ?? error).slice(0, 80);
      warnings.push(`Excerpt ${i + 1} omitted (${short}): ${reason}`);
    }
  }
  if (warnings.length) parts.push(frame('evidence_warnings', warnings.join('\n')));
  const text = parts.join('\n\n');
  if (text.length > limits.maxResponseCharacters) throw new Error('Response exceeds maxResponseCharacters');
  return { text, warnings, excerpts: metadata };
}

export function extractPrompt(document, role) {
  const start = `<!-- BEGIN INVESTIGATE ${role} PROMPT -->`;
  const end = `<!-- END INVESTIGATE ${role} PROMPT -->`;
  if (document.split(start).length !== 2 || document.split(end).length !== 2) throw new Error(`Invalid ${role} prompt markers`);
  const from = document.indexOf(start) + start.length;
  if (document.indexOf(end) < from) throw new Error('Reversed prompt markers');
  return nonblank(document.slice(from, document.indexOf(end)).trim(), 'prompt');
}

export function createSemaphore(limit) {
  positive(limit, 'concurrency');
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      entry.signal?.removeEventListener('abort', entry.cancel);
      if (entry.signal?.aborted) { entry.reject(entry.signal.reason); continue; }
      active++;
      let released = false;
      entry.resolve(() => { if (!released) { released = true; active--; drain(); } });
    }
  }
  return {
    setLimit(next) { limit = positive(next, 'concurrency'); drain(); },
    acquire(signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const entry = { resolve, reject, signal, cancel: undefined };
        entry.cancel = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(signal.reason); };
        signal?.addEventListener('abort', entry.cancel, { once: true });
        queue.push(entry); drain();
      });
    },
    stats: () => ({ active, queued: queue.length }),
  };
}

export function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(total, usage) {
  if (!usage) return total;
  const result = zeroUsage();
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) result[key] = total[key] + (usage[key] ?? 0);
  for (const key of Object.keys(result.cost)) result.cost[key] = total.cost[key] + (usage.cost?.[key] ?? 0);
  return result;
}
