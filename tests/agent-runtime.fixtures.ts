import { z } from 'zod';

import type {
  AgentExecutionRequest,
  AgentRegistration,
} from '../src/agents/protocol.ts';
import { InMemoryAgentRegistry } from '../src/agents/registry.ts';
import { CapabilitySchemaCatalog } from '../src/agents/validation.ts';

export const origin = 'https://echo.example.invalid';
export const actor = { instance_id: 'jarvis-demo', subject_ref: 'owner-demo' };

export function schemas(): CapabilitySchemaCatalog {
  return new CapabilitySchemaCatalog([
    {
      id: 'demo.input.v1',
      schema: z.strictObject({ text: z.string().min(1).max(128) }),
    },
    {
      id: 'demo.output.v1',
      schema: z.strictObject({ text: z.string().min(1).max(128) }),
    },
  ]);
}

export function registration(
  overrides: Partial<AgentRegistration> = {},
): AgentRegistration {
  return {
    instance_id: actor.instance_id,
    descriptor: {
      protocol_version: '1.0',
      agent_id: 'demo.echo',
      agent_version: '0.1.0',
      name: 'Fixture local',
      capabilities: [
        {
          name: 'echo.reply',
          version: '1.0',
          description: 'Ficticia',
          effect: 'read',
          supports_idempotency: true,
          input_schema_id: 'demo.input.v1',
          output_schema_id: 'demo.output.v1',
        },
      ],
    },
    enabled: true,
    availability: 'available',
    connection: {
      base_url: origin,
      request_credential_ref: 'unused-request-reference',
      event_key_ref: 'unused-event-reference',
    },
    permissions: [
      {
        subject_ref: actor.subject_ref,
        capabilities: [{ name: 'echo.reply', version: '1.0' }],
      },
    ],
    ...overrides,
  };
}

export function request(
  overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
  return {
    protocol_version: '1.0',
    kind: 'execute',
    instance_id: actor.instance_id,
    subject_ref: actor.subject_ref,
    agent_id: 'demo.echo',
    request_id: 'request-demo',
    correlation_id: 'flow-demo',
    idempotency_key: 'effect-demo',
    capability: { name: 'echo.reply', version: '1.0' },
    deadline_at: new Date(Date.now() + 10_000).toISOString(),
    cost_policy: 'no-paid-services',
    input: { text: 'Texto ficticio.' },
    ...overrides,
  };
}

export function completed(value: AgentExecutionRequest) {
  return {
    protocol_version: value.protocol_version,
    kind: 'execution-result' as const,
    instance_id: value.instance_id,
    subject_ref: value.subject_ref,
    agent_id: value.agent_id,
    request_id: value.request_id,
    correlation_id: value.correlation_id,
    status: 'completed' as const,
    output: { text: 'Resultado ficticio.' },
  };
}

export function registry(value = registration()) {
  const catalog = schemas();
  return {
    catalog,
    registry: new InMemoryAgentRegistry([value], catalog, [origin]),
  };
}
