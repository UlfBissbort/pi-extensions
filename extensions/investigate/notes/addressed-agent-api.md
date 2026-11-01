# Addressed investigator API

> [!info] Status
> Implemented with offline reducer, SDK, routing, persistence, cancellation, and cache-prefix tests. Provider cache hits have not been measured live. The stop/handoff design note records the implementation and its limits.

## Goal

Let the user message, inspect, and stop an investigator directly from Pi's editor, without going through the parent model. Use one addressing syntax and a small, fixed set of commands. A stopped investigator must still leave the parent with something it can use: a summary of what it was doing and found.

## Syntax

| Input | Behavior |
|---|---|
| `@agent_name message` | Send a message to a running investigator, or resume a finished one with its retained context. |
| `@agent_name /stop` | Graceful stop. Let the current model request or tool batch finish, start no new research, then hand off to the parent. |
| `@agent_name /stopp` | Hard stop. Abort the current model request or tool batch immediately, then hand off to the parent. |
| `@agent_name /status` | Show a local status notice. No model call, no resumption, no message to the parent. |

Exact names and unique prefixes use the existing address resolution. Typing `@agent_name /` suggests `/stop`, `/stopp`, and `/status`. There is no separate `/investigator` command, and no `/pause`, `/kill`, or `/resume`; sending a message already resumes an investigator.

## Stop semantics

- Both stops are acknowledged at once ("Stop requested" or "Stopping now") and cancel a queued run before it starts.
- `/stop` lets an operation that is already running finish and keeps its outcome. If the model's last response proposes tool calls, they are recorded as not executed.
- `/stopp` signals cancellation to the running model request and tools, and waits only for them to settle. Partial model output is kept as incomplete text, never as a recorded response. Tool cancellation is cooperative: a tool that ignores the signal delays the stop.
- After either stop, a separate handoff call summarizes the frozen record for the parent, using the investigator's own model and preserving the cacheable prefix of its previous requests; actual cache hits depend on the provider. If that call fails, an activity log built from the record is sent instead. The parent always gets a result marked as partial work, through the usual route: the tool result for a run the parent started, or a report message for one the user resumed.
- `/stopp` during a handoff aborts it and the activity log is sent. `/stop` during a handoff has no effect.
- Stops are idempotent. `/stopp` turns an earlier `/stop` into a hard stop. Stopping a finished investigator reports "Not running" and never resumes it.
- Unread messages, including those sent during the handoff, are listed in the result and never restart a stopped investigator.
- The investigator keeps its context, including the handoff, and can be resumed later with `@name message`.

## Status semantics

Show the state (queued, running, stopping, stopping now, handing off, answered, or resumable), plus the operation in progress, the model-request count, and the number of unread messages where available. For an investigator that is not running, show the last run's request count and why it ended.

## Parsing

A command-shaped `/word` right after the address is reserved; it ends at whitespace or the end of input. Unknown commands and extra arguments produce a warning instead of being sent to the investigator as messages. A command addressed to an unknown or ambiguous investigator also produces a warning and is not passed to the parent.

| Example | Interpretation |
|---|---|
| `@name /stop` | Graceful stop. |
| `@name /stopp` | Hard stop. |
| `@name /status` | Status. |
| `@name /stpo` | Unknown-command warning. |
| `@name /stop extra` | Usage warning; no stop. |
| `@name /Users/ulf/dev is here` | Ordinary message; the path continues past the command word. |
| `@name please explain /stop` | Ordinary message. |
