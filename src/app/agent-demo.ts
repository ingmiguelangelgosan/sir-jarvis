import { z } from 'zod';

import { AgentGatewayError } from '../agents/errors.ts';
import { InMemoryAgentGateway } from '../agents/gateway.ts';
import { InMemoryAgentRegistry } from '../agents/registry.ts';
import type { AgentTransport } from '../agents/transport.ts';
import { CapabilitySchemaCatalog } from '../agents/validation.ts';
import { AgentExecutionService } from './agent-execution.ts';

// Composición LOCAL de ejemplo, sin .env, credenciales, red ni agente servidor.
const schemas = new CapabilitySchemaCatalog([
  {
    id: 'demo.echo.input.v1',
    schema: z.strictObject({ text: z.string().min(1).max(128) }),
  },
  {
    id: 'demo.echo.output.v1',
    schema: z.strictObject({ text: z.string().min(1).max(128) }),
  },
]);
const registry = new InMemoryAgentRegistry(
  [
    {
      instance_id: 'jarvis-demo',
      descriptor: {
        protocol_version: '1.0',
        agent_id: 'demo.echo',
        agent_version: '0.1.0',
        name: 'Demo local',
        capabilities: [
          {
            name: 'echo.reply',
            version: '1.0',
            description: 'Respuesta ficticia',
            effect: 'read',
            supports_idempotency: true,
            input_schema_id: 'demo.echo.input.v1',
            output_schema_id: 'demo.echo.output.v1',
          },
        ],
      },
      enabled: true,
      availability: 'available',
      connection: {
        base_url: 'https://echo.example.invalid',
        request_credential_ref: 'demo-unused-request',
        event_key_ref: 'demo-unused-event',
      },
      permissions: [
        {
          subject_ref: 'owner-demo',
          capabilities: [{ name: 'echo.reply', version: '1.0' }],
        },
      ],
    },
  ],
  schemas,
  ['https://echo.example.invalid'],
);
const transport: AgentTransport = {
  execute: async (request) => ({
    protocol_version: '1.0',
    kind: 'execution-result',
    instance_id: request.instance_id,
    agent_id: request.agent_id,
    subject_ref: request.subject_ref,
    request_id: request.request_id,
    correlation_id: request.correlation_id,
    status: 'completed',
    output: { text: 'Resultado simulado.' },
  }),
  getOperation: async () => {
    throw new AgentGatewayError('UNKNOWN_OPERATION');
  },
};
const gateway = new InMemoryAgentGateway(registry, schemas, transport, {
  resultCacheMs: 60_000,
  maxRecords: 16,
});
try {
  const service = new AgentExecutionService(registry, gateway);
  const result = await service.execute(
    { instance_id: 'jarvis-demo', subject_ref: 'owner-demo' },
    {
      protocol_version: '1.0',
      kind: 'execute',
      instance_id: 'jarvis-demo',
      agent_id: 'demo.echo',
      subject_ref: 'owner-demo',
      request_id: 'request-demo',
      correlation_id: 'flow-demo',
      idempotency_key: 'effect-demo',
      capability: { name: 'echo.reply', version: '1.0' },
      deadline_at: new Date(Date.now() + 10_000).toISOString(),
      cost_policy: 'no-paid-services',
      input: { text: 'Texto ficticio.' },
    },
    new AbortController().signal,
  );
  process.stdout.write(
    `${JSON.stringify({ mode: 'simulated', status: result.status })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof AgentGatewayError ? error.code : 'INTERNAL_ERROR'}\n`,
  );
  process.exitCode = 1;
} finally {
  gateway.close();
}
