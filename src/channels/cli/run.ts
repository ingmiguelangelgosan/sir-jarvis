import { ConfigurationError } from '../../app/config.ts';
import type { DiagnosticReport } from '../../app/diagnostics.ts';

interface CliOutput {
  write(message: string): void;
  error(message: string): void;
}

export function runCli(
  args: readonly string[],
  bootstrap: () => DiagnosticReport,
  output: CliOutput,
): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== 'diagnose')) {
    output.error('Uso: jarvis [diagnose]');
    return 1;
  }

  try {
    output.write(JSON.stringify(bootstrap(), null, 2));
    return 0;
  } catch (error) {
    output.error(
      error instanceof ConfigurationError
        ? error.message
        : 'No se pudo iniciar Jarvis.',
    );
    return 1;
  }
}
