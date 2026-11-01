# Pi extensions

Extensions for the Pi coding agent, packaged so each can be installed separately from a local clone. Currently this repository contains only `investigate`.

## Install with your agent

Clone the repository:

```bash
git clone https://github.com/UlfBissbort/pi-extensions.git
cd pi-extensions
```

Then ask your agent:

> Read AGENTS.md in this repository and install only the investigate extension for my user. Keep its default model, or ask me which provider and model to use. Preserve my existing Pi settings and do not make paid test requests.

The installation instructions are also included below. No build step, npm publication, Zef installation, or copying into Pi's extensions directory is required.

## Available extensions

| Extension | Purpose | Install from the repository root |
| --- | --- | --- |
| `investigate` | Research in a fresh model session; return a focused answer and exact source excerpts rather than the exploration trace. | `pi install ./extensions/investigate` |

Use the individual extension path to avoid automatically enabling other extensions added to this collection in the future.

## Manual installation

Prerequisite: a working Pi installation with the required extension/SDK APIs. This version has been checked against Pi **1.2.0**; older versions are not verified. The package imports the `@earendil-works/pi-*` host packages and `typebox`, which Pi supplies. You do not need to run `npm install` for normal use.

From the repository root:

```bash
pi install ./extensions/investigate
```

This registers the local directory in your personal Pi settings; it does not copy the source. Keep the clone in a stable location. Run `/reload` in Pi or start a new session after installation. Avoid loading another copy of `investigate` at the same time.

For installation in one project only, run the following from that project's directory, using the actual absolute path to your clone:

```bash
pi install /absolute/path/to/pi-extensions/extensions/investigate --local
```

Project-local extensions are subject to Pi's project trust rules. Do not bypass those rules automatically.

The entire collection can also be installed with `pi install git:github.com/UlfBissbort/pi-extensions`. That selects every extension in the root manifest, including future additions, so cloning and installing a specific directory is the recommended path.

## Choose the investigation model

The default is provider `openai`, model `gpt-6-luna`, with `medium` thinking. This is a configured model ID, not a promise that every account has access to it. Authenticate through Pi using your own account. The extension does not include credentials.

To override the model, create `extensions/investigate/config.local.json`:

```json
{
  "provider": "anthropic",
  "model": "REPLACE_WITH_YOUR_AVAILABLE_HAIKU_MODEL_ID",
  "thinkingLevel": "off"
}
```

Ask Pi to list available models, or use its model picker, and copy the exact provider and model ID. The placeholder above must be replaced before use. `off` is a conservative choice for models without thinking support. There is no silent model fallback; missing models or credentials produce an error.

The optional local file overrides top-level keys from `extensions/investigate/config.json` and is ignored by Git. Nested objects are replaced in full, not deep-merged. Keep secrets out of both files. Reload Pi after configuration changes. Deleting the local override restores the checked-in defaults.

## Update and remove

Update a local clone with `git pull --ff-only`, then reload Pi. Local overrides remain untracked; back them up separately if needed. Do not install both the individual extension and the whole collection.

Use `pi list` to inspect registered sources. Remove the individual installation with `pi remove /absolute/path/to/pi-extensions/extensions/investigate`, using the registered path. Reload Pi afterward. Removing the registration does not delete the clone or its configuration.

## Safety and behavior

`investigate` starts a separate model session and can incur additional provider costs. It receives the task and configured repository overview, not the parent's conversation history. When enabled, it adds system-prompt guidance encouraging the parent to use investigation for lookups; users should review that guidance before enabling it.

The investigator has Pi's filesystem permissions. Shell access is enabled by default, and the instruction not to mutate files is **not a sandbox**. To disable the general shell tool, include `"tools": { "allowBash": false }` in the local override. Files read during investigation may be sent to the configured model provider. Review privacy requirements before using it on sensitive sources.

## Development and verification

Run `npm test` from the repository root for the offline suite. It uses scripted responses and makes no paid model requests. The tests locate Pi through `npm root -g`; for another installation method, set `PI_INVESTIGATE_HOST` to the installed Pi package directory. `npm run typecheck` requires a recent TypeScript compiler; set `PI_TYPESCRIPT` to its `tsc` JavaScript file if it is not on PATH.

Live smoke testing is optional and requires explicit permission because it uses model credentials and can incur charges: run `npm run test:live` from `extensions/investigate`. Passing offline tests does not establish model access, answer quality, or compatibility with every Pi version.

## Packaging references

The package uses Pi's native `pi.extensions` manifest. Comparable public repositories include https://github.com/narumiruna/pi-extensions and https://github.com/ogulcancelik/pi-extensions for collections, and https://github.com/nicobailon/pi-subagents for a standalone package. No source code from those repositories was copied.

## License

A license has not yet been selected. Public availability is not an open-source license grant; do not assume permission to redistribute or sublicense this code.
