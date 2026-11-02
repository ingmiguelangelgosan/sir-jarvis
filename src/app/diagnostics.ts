import type { AppConfig } from './config.ts';

export interface DiagnosticReport {
  readonly application: 'jarvis';
  readonly phase: '1A';
  readonly status: 'bootstrap-ready';
  readonly checks: {
    readonly configuration: 'valid';
  };
  readonly capabilities: {
    readonly telegram: 'available-not-connected';
    readonly persistence: 'not-implemented';
    readonly finance: 'not-implemented';
    readonly ai: 'disabled';
  };
}

export function diagnose(config: AppConfig): DiagnosticReport {
  return {
    application: 'jarvis',
    phase: '1A',
    status: 'bootstrap-ready',
    checks: { configuration: 'valid' },
    capabilities: {
      telegram: 'available-not-connected',
      persistence: 'not-implemented',
      finance: 'not-implemented',
      ai: config.aiMode,
    },
  };
}
