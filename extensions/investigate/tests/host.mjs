import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Override for non-npm installations; never assume a Homebrew prefix.
export const host = process.env.PI_INVESTIGATE_HOST || join(
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
  '@earendil-works/pi-coding-agent',
);
