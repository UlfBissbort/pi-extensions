# Agent installation guide

This repository is a collection of independently installable Pi extensions. Currently only `investigate` is included. Help the user install the requested extension, not the whole collection by default.

## Install investigate

1. Read the root README and `extensions/investigate/README.md`. Check that `pi` is installed with `pi --version`. This package was checked against Pi 1.2.0; do not claim untested versions work.
2. Resolve this clone to an absolute path. Run `pi list` and check whether the extension or the whole collection is already registered. Also check for a separately installed `investigate` tool before introducing a duplicate. Do not delete existing extensions or rewrite the user's settings wholesale.
3. Unless the user requests project-local installation, run `pi install /absolute/path/to/this/clone/extensions/investigate`. For project-local installation, run that command with `--local` from the target project's directory, respecting project trust. Do not run `npm install`, copy the extension into another directory, or install the repository root unnecessarily.
4. Keep the default `openai/gpt-6-luna` model unless the user requests another. If they request Haiku or another model, determine the exact provider and model ID available in their Pi installation. Do not guess an ID or silently substitute a model.
5. For customization, create or carefully merge `extensions/investigate/config.local.json`. It is an optional, git-ignored top-level override of `config.json`. Set `provider`, `model`, and an appropriate `thinkingLevel` (use `off` for a model without thinking support). Preserve unrelated local overrides. Nested sections must be supplied in full. Do not put credentials in this repository; use Pi's authentication flow.
6. Explain that investigation makes additional model calls, can send source contents to the selected provider, and has shell access by default without sandboxing. If the user wants the general shell disabled, set `tools` to `{ "allowBash": false }` in their local override.
7. Verify registration with `pi list`. Tell the user to run `/reload` or restart Pi. Registration alone does not prove the tool has loaded or that model credentials work. Check for extension-loading errors after reload when possible.
8. Report the installed source path, configuration changes, chosen provider/model, and any remaining authentication or reload steps. Do not make a live model request unless the user explicitly approves it.

## Maintenance boundaries

Keep each extension's entry point and manifest inside its own directory. The root manifest must list only intended public extensions. Do not add personal prompts, repository maps, credentials, sessions, database files, or other installed extensions without review.

The local clone is the installed source: moving or deleting it breaks the registration. Use `git pull --ff-only` to update, then reload Pi. Do not overwrite local configuration or unrelated user changes. Do not commit `config.local.json`.

For code changes, run the offline tests with `npm test` from the root. The Pi installation path can be overridden with `PI_INVESTIGATE_HOST`. Never run the opt-in live smoke test without permission. Do not publish, tag a release, or change the license unless asked.
