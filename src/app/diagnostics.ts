import type { AppConfig } from './config.ts';

export interface DiagnosticReport {
  readonly application: 'jarvis';
  readonly phase: 0;
  readonly status: 'bootstrap-ready';
  readonly checks: {
    readonly configuration: 'valid';
  };
  readonly capabilities: {
    readonly telegram: 'not-implemented';
    readonly persistence: 'not-implemented';
    readonly finance: 'not-implemented';
    readonly ai: 'disabled';
  };
}

export function diagnose(config: AppConfig): DiagnosticReport {
  return {
    application: 'jarvis',
    phase: 0,
    status: 'bootstrap-ready',
    checks: { configuration: 'valid' },
    capabilities: {
      telegram: 'not-implemented',
      persistence: 'not-implemented',
      finance: 'not-implemented',
      ai: config.aiMode,
    },
  };
}
