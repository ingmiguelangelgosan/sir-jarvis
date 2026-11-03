import { AgentGatewayError } from './errors.ts';
import { identifierSchema } from './validation.ts';

/** Server-only resolver. The reference is local configuration, never a payload. */
export interface AgentCredentialResolver {
  resolve(reference: string, signal: AbortSignal): Promise<string>;
}

/** Explicit reference -> environment variable mapping, with no ambient discovery. */
export class EnvironmentAgentCredentials implements AgentCredentialResolver {
  readonly #variables = new Map<string, string>();
  readonly #read: (name: string) => string | undefined;

  constructor(
    mapping: Readonly<Record<string, string>>,
    read: (name: string) => string | undefined = (name) => process.env[name],
  ) {
    try {
      const entries = Object.entries(mapping);
      if (entries.length > 256) throw new Error();
      for (const [reference, variable] of entries) {
        identifierSchema.parse(reference);
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(variable)) throw new Error();
        this.#variables.set(reference, variable);
      }
      this.#read = read;
    } catch {
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    }
  }

  async resolve(reference: string, signal: AbortSignal): Promise<string> {
    try {
      if (signal.aborted) throw new AgentGatewayError('CANCELLED');
      const variable = this.#variables.get(reference);
      const token = variable ? this.#read(variable) : undefined;
      if (!validBearerToken(token)) throw new Error();
      return token;
    } catch (error) {
      if (error instanceof AgentGatewayError) throw error;
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    }
  }
}

export function validBearerToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  );
}
