import { AgentGatewayError } from './errors.ts';
import { jsonObjectSnapshot } from './json.ts';
import type {
  AgentCapability,
  AgentExecutionRequest,
  AgentRegistration,
  AgentRegistry,
} from './protocol.ts';
import {
  type CapabilitySchemaCatalog,
  parseRegistration,
} from './validation.ts';

function origin(value: string): string {
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      value.includes('?') ||
      value.includes('#') ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      ['169.254.169.254', 'metadata.google.internal'].includes(url.hostname)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AgentGatewayError('INVALID_CONFIGURATION');
  }
}

export class InMemoryAgentRegistry implements AgentRegistry {
  readonly #entries = new Map<string, AgentRegistration>();

  constructor(
    registrations: readonly unknown[],
    schemas: CapabilitySchemaCatalog,
    allowedOrigins: readonly string[],
  ) {
    try {
      if (registrations.length > 256 || allowedOrigins.length > 256)
        throw new Error();
      const allowed = new Set(allowedOrigins.map(origin));
      for (const value of registrations) {
        const registration = parseRegistration(value);
        const baseUrl = origin(registration.connection.base_url);
        if (!allowed.has(baseUrl)) throw new Error();
        const key = JSON.stringify([
          registration.instance_id,
          registration.descriptor.agent_id,
        ]);
        if (this.#entries.has(key)) throw new Error();
        const capabilities = new Set<string>();
        for (const capability of registration.descriptor.capabilities) {
          const reference = JSON.stringify([
            capability.name,
            capability.version,
          ]);
          if (
            capabilities.has(reference) ||
            !schemas.has(capability.input_schema_id) ||
            !schemas.has(capability.output_schema_id)
          )
            throw new Error();
          capabilities.add(reference);
        }
        const subjects = new Set<string>();
        for (const grant of registration.permissions) {
          if (subjects.has(grant.subject_ref)) throw new Error();
          subjects.add(grant.subject_ref);
          const grants = new Set<string>();
          for (const capability of grant.capabilities) {
            const reference = JSON.stringify([
              capability.name,
              capability.version,
            ]);
            if (!capabilities.has(reference) || grants.has(reference))
              throw new Error();
            grants.add(reference);
          }
        }
        const snapshot = jsonObjectSnapshot({
          ...registration,
          connection: { ...registration.connection, base_url: baseUrl },
        });
        this.#entries.set(key, snapshot as unknown as AgentRegistration);
      }
    } catch {
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    }
  }

  get(instanceId: string, agentId: string): AgentRegistration | undefined {
    return this.#entries.get(JSON.stringify([instanceId, agentId]));
  }

  list(instanceId: string): readonly AgentRegistration[] {
    return Object.freeze(
      [...this.#entries.values()].filter(
        (entry) => entry.instance_id === instanceId,
      ),
    );
  }
}

export function authorizeExecution(
  registry: AgentRegistry,
  request: Pick<
    AgentExecutionRequest,
    'instance_id' | 'subject_ref' | 'agent_id' | 'capability'
  >,
): AgentCapability {
  const registration = registry.get(request.instance_id, request.agent_id);
  if (!registration) throw new AgentGatewayError('UNKNOWN_AGENT');
  if (!registration.enabled) throw new AgentGatewayError('AGENT_DISABLED');
  const grant = registration.permissions.find(
    (permission) => permission.subject_ref === request.subject_ref,
  );
  if (!grant) throw new AgentGatewayError('FORBIDDEN');
  const capability = registration.descriptor.capabilities.find(
    (entry) =>
      entry.name === request.capability.name &&
      entry.version === request.capability.version,
  );
  if (!capability) throw new AgentGatewayError('UNKNOWN_CAPABILITY');
  if (
    !grant.capabilities.some(
      (entry) =>
        entry.name === capability.name && entry.version === capability.version,
    )
  )
    throw new AgentGatewayError('FORBIDDEN');
  if (registration.availability !== 'available')
    throw new AgentGatewayError('AGENT_UNAVAILABLE');
  return capability;
}

export function authorizeSubject(
  registry: AgentRegistry,
  query: {
    readonly instance_id: string;
    readonly agent_id: string;
    readonly subject_ref: string;
  },
): void {
  const registration = registry.get(query.instance_id, query.agent_id);
  if (!registration) throw new AgentGatewayError('UNKNOWN_AGENT');
  if (!registration.enabled) throw new AgentGatewayError('AGENT_DISABLED');
  if (
    !registration.permissions.some(
      (grant) => grant.subject_ref === query.subject_ref,
    )
  )
    throw new AgentGatewayError('FORBIDDEN');
  if (registration.availability !== 'available')
    throw new AgentGatewayError('AGENT_UNAVAILABLE');
}
