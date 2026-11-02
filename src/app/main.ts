import { resolve } from 'node:path';

import { runCli } from '../channels/cli/run.ts';
import { loadEnvironment } from '../infrastructure/environment.ts';
import { parseConfig } from './config.ts';
import { diagnose } from './diagnostics.ts';

process.exitCode = runCli(
  process.argv.slice(2),
  () => {
    const environment = loadEnvironment(
      process.env,
      resolve(process.cwd(), '.env'),
    );
    return diagnose(parseConfig(environment));
  },
  {
    write: (message) => process.stdout.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  },
);
