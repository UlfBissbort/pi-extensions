# Investigate

A Pi tool for bounded research in a fresh model session. The caller supplies a self-contained question; the investigator searches and reads, then returns its answer and optional exact file excerpts. The parent conversation does not receive the exploration trace.

## Install this extension only

From the repository root, run `pi install ./extensions/investigate`, then `/reload` in Pi or start a new session. Pi loads `index.ts` directly; no compilation or npm installation is needed. Keep the clone in place because Pi registers the local source path rather than copying it. Do not load a second copy of the extension.

## Model and local configuration

Defaults in `config.json` are `provider: "openai"`, `model: "gpt-6-luna"`, and `thinkingLevel: "medium"`. Use your own Pi provider login. Availability depends on your account and configured model registry.

Create an optional `config.local.json` in this directory to change the model without editing tracked files:

```json
{
  "provider": "anthropic",
  "model": "REPLACE_WITH_YOUR_AVAILABLE_HAIKU_MODEL_ID",
  "thinkingLevel": "off"
}
```

Replace the placeholder using the exact model ID available in Pi. There is no automatic fallback. Supported thinking-level values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`, but the chosen model must support the requested level. Reload after changes.

Local overrides are shallow: any supplied nested section replaces that entire default section. For example, `"tools": { "allowBash": false }` disables the general shell tool. Do not put API keys in configuration; use Pi's authentication mechanism.

The default repository overview is generic and starts from the caller's current directory. To supply your own repository orientation, set `repositoryMapFile` to an absolute path to a Markdown file. Relative paths resolve against this extension directory. Custom prompt paths follow the same rule. Do not commit personal repository maps or prompts.

## Tool API

```typescript
investigate({
  question: "Where is request cancellation implemented, and how is it tested?",
  context: "We need to understand existing behavior before changing it.",
  scope: ["./src", "./tests"],
  detail: "standard",
  include_references: true,
  effort: 4
})
```

Only `question` is required. `detail` is `brief`, `standard`, or `detailed`. `effort` is an integer from 0 to 10 (default 4), controlling request, time, output, and excerpt budgets. Scope indicates where to prioritize research, not an access restriction. The default permits three simultaneous investigations. Edit the full defaults in `config.json` only when the simple local override is insufficient.

Every result whose investigator exists starts with its name, handle, and status, for example `richard_the_lionheart = ET.InvestigationAgent('🍃-…') answered`. Names are drawn from `src/names.json` at launch and shown in the TUI from then on. A name is never issued twice in a session, also not after a reload: names from earlier results in the session file stay taken. Once all are used, numbered rounds follow (`erasmus_the_learned_2`). Investigators running at the same time get different first parts where possible. The status is `answered` (an answer follows), `resumable` (stopped by budget, deadline, cancellation, or error; the reason follows), or `running` (this call did not start because the investigator is busy with an earlier one).

To continue an investigator, pass its name or handle as `agent` with the follow-up as `question`:

```typescript
investigate({
  agent: "richard_the_lionheart",
  question: "How are nested sections of config.local.json combined?",
  effort: 2
})
```

It continues with its full previous context, including the files it read and its earlier answers. Its model, tools, working directory, and leading prompt are kept; `detail`, `include_references`, and `effort` (with its budgets and deadline) apply to the new call. An investigator handles one call at a time. Finished investigators stay available for continuing, resuming, and `@` completion, also after a reload: after each run, the entries added to its record are saved as a custom entry in the parent session (not part of the parent's model context), and the active branch's records are loaded when the session starts. The most recent 100 are kept in memory; an unknown name or handle returns an error. These records hold the worker's whole conversation, including the file contents and command output it saw, so the session file grows with them and contains that material.

While an investigator runs, you can write to it from Pi's editor with `@name message`, for example `@richard_the… look in the tests instead`. Typing `@` at the start of the message suggests investigators: running ones first, then finished ones. Any part of a name matches (`@lion`), and a unique prefix is enough, with or without a trailing ellipsis. The message bypasses the parent and enters the investigator's conversation at its next turn boundary, after any running tool calls finish and before its next model request; the header shows how many are waiting. The parent's result lists the messages the investigator read. An `@` address that matches no investigator is passed to the parent as ordinary text.

Use `@name /status` for a local notice showing state, operation, model-request count, and unread-message count; inactive notices describe the last run where available. It never calls a model or resumes work. Use `@name /stop` for a graceful stop: let the current model request or tool batch finish, but start no new research. Use `@name /stopp` to immediately signal cancellation of the current request and tools. Tool cancellation is cooperative, and client cancellation cannot guarantee immediate termination of provider-side computation. Queued work is cancelled before starting. Repeated stops are harmless; `/stopp` escalates a pending `/stop`; finished investigators report “Not running”.

After research stops, one reporting call receives the full recorded context plus a handoff instruction. It uses the investigator's own model, reasoning level, session ID, original system prompt, and unchanged tool declarations to preserve the cacheable prefix. No tools are executed during reporting, and no source excerpts are fetched. The parent receives the partial handoff through the usual tool-result/report route. If reporting fails, times out, exceeds the context window, or is hard-stopped, a deterministic activity log is returned instead, with an explicit shortening notice if necessary. Actual provider cache hits are not guaranteed: handoff details and the transcript show cache-read and uncached-input usage. The handoff is persisted with the investigator for later resumption.

`/status` shows “handing off” during reporting; `/stop` then has no effect, and `/stopp` aborts reporting and returns the fallback. Unread messages are reported and never automatically restart a stopped run. A run stopped before model work needs no reporting call; an already-accepted final answer wins a race with a stop. The default reporting budget is `handoff: { "timeoutSeconds": 60, "maxOutputTokens": 4096 }`, additionally capped by the original run deadline. This single reporting call is outside the research request-count budget, but its usage is included in the result. Local overrides must supply the whole `handoff` section. Deadlines, shutdown, and parent cancellation still abort all stages and do not independently trigger handoffs.

Completing `@name /` suggests `/stop`, `/stopp`, and `/status`; there is no separate slash-command namespace. Unknown leading `/word` commands, extra arguments, and unknown or ambiguous command targets warn locally instead of reaching the parent. Paths such as `@name /Users/ulf/dev is here` remain ordinary messages.

Writing to a finished investigator resumes it with its full context; so does a message that arrives while it is submitting its final answer. Such a run belongs to no tool call: while it works, its chain is shown as a live widget above the editor, with the agent's name and rail colour. When it ends, the finished chain is added to the end of the transcript, and the same message gives the result to the parent. If the parent is idle, the message starts a parent turn; if it is busy, the message follows its current run. The run uses the effort, detail, and reference preference of the investigator's previous run. An investigator keeps its rail colour across all its runs.

The tool returns the answer followed by selected file ranges with provenance. Excerpts are read at submission time and can differ from earlier inspected content. Missing or oversized excerpts are reported. In the TUI, each investigation has a persistent coloured rail down its left edge, so adjacent or parallel agents remain distinguishable. A single click on a tool step opens its call arguments and the result returned to the investigator inside the same box; a second click closes it. Every step remains visible in order, even in long investigations; long arguments and text results are shortened per step, and non-text content such as images gets a placeholder. The snapshot grows with the number of steps. The parent model sees only the final answer, not these intermediate tool results, but Pi persists UI snapshots (including displayed results) in the parent session's tool details; a closed box is not a privacy boundary. Private model reasoning is never shown.

## Boundaries

The worker uses read, grep, find, ls, optionally bash, and its completion tool. It does not inherit the parent transcript or automatically load its extensions, skills, or general instructions. The parent receives prompt guidance encouraging frequent use of this tool while it is active; inspect the bundled prompts if that policy matters to you.

This is not a sandbox or a guarantee of read-only execution. Shell access is enabled by default, and even with bash disabled the worker can read files accessible to Pi. Source contents may be sent to the model provider. Requests incur usage on the configured account. Do not use live smoke tests without permission.

## Checks

`npm test` in this directory runs offline tests with scripted model responses. `npm run typecheck` checks TypeScript using a recent compiler. The tests discover the global npm Pi installation; set `PI_INVESTIGATE_HOST` for another location. Set `PI_TYPESCRIPT` to a compiler's `tsc` JavaScript file when needed. `npm run test:live` is an explicit opt-in authenticated model request using a temporary fixture.

Checked against Pi 1.2.0. Older versions and other providers are not automatically certified by the offline suite.
