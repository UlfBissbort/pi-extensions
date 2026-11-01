// Uses an existing TypeScript installation; does not install dependencies.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { host } from './host.mjs';
const root = new URL('../', import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), 'investigate-typecheck-'));
try {
  const config = {
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
      noEmit: true, allowImportingTsExtensions: true, allowJs: true, checkJs: false,
      skipLibCheck: true, types: ['node'], typeRoots: [`${host}/node_modules/@types`],
      paths: { '@earendil-works/pi-coding-agent': [`${host}/dist/index.d.ts`], 'typebox': [`${host}/node_modules/typebox/build/index.d.mts`], '@earendil-works/pi-tui': [`${host}/node_modules/@earendil-works/pi-tui/dist/index.d.ts`], '@earendil-works/pi-ai': [`${host}/node_modules/@earendil-works/pi-ai/dist/compat.d.ts`] },
    },
    include: [`${root}/src/**/*.ts`, `${root}/src/**/*.mjs`, `${root}/index.ts`],
  };
  const configPath = join(dir, 'tsconfig.json');
  await writeFile(configPath, JSON.stringify(config));
  const compiler = process.env.PI_TYPESCRIPT;
  const command = compiler ? process.execPath : 'tsc';
  const args = [...(compiler ? [compiler] : []), '-p', configPath];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }
