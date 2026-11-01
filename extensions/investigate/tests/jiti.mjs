// Loads the extension's TypeScript against the installed Pi, as Pi itself does.
import { createRequire } from 'node:module';
import { host } from './host.mjs';

const requireHost = createRequire(`${host}/package.json`);
const { createJiti } = requireHost('jiti');
export const tuiPath = `${host}/node_modules/@earendil-works/pi-tui/dist/index.js`;
export const jiti = createJiti(import.meta.url, {
  alias: {
    '@earendil-works/pi-coding-agent': `${host}/dist/index.js`,
    'typebox': requireHost.resolve('typebox'),
    '@earendil-works/pi-tui': tuiPath,
    '@earendil-works/pi-ai': `${host}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
  },
});
