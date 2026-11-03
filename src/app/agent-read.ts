import { z } from 'zod';

import { AgentGatewayError } from '../agents/errors.ts';
import type {
  AgentCapability,
  AgentExecutionRequest,
  AgentRegistry,
} from '../agents/protocol.ts';
import { authorizeExecution } from '../agents/registry.ts';
import { identifierSchema } from '../agents/validation.ts';
import type { AgentExecutionService, AgentActor } from './agent-execution.ts';

export const echoTextSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value),
  );

export type AgentActionIds = Pick<
  AgentExecutionRequest,
  'request_id' | 'correlation_id' | 'idempotency_key'
>;
const actorSchema = z.strictObject({
  instance_id: identifierSchema,
  subject_ref: identifierSchema,
});
const inputSchema = z.strictObject({
  agentId: identifierSchema,
  capability: identifierSchema,
  text: echoTextSchema,
  ids: z.strictObject({
    request_id: identifierSchema,
    correlation_id: identifierSchema,
    idempotency_key: identifierSchema,
  }),
});

function supported(capability: AgentCapability): boolean {
  return (
    capability.effect === 'read' &&
    capability.name === 'echo.reply' &&
    capability.version === '1.0' &&
    capability.input_schema_id === 'demo.input.v1' &&
    capability.output_schema_id === 'demo.output.v1'
  );
}

export function agentReadError(error: unknown): string {
  if (!(error instanceof AgentGatewayError))
    return 'No pude obtener una respuesta del agente.';
  if (error.code === 'RESULT_EXPIRED' && error.outcome === 'completed')
    return 'La consulta ya terminó; su contenido no se conserva y no volveré a ejecutarla.';
  if (error.code === 'TIMEOUT')
    return 'Se agotó el tiempo de espera. El resultado no está confirmado; no repetiré la solicitud automáticamente.';
  if (error.code === 'CANCELLED')
    return 'Se canceló la espera. Esto no confirma la cancelación en el agente.';
  if (error.outcome === 'uncertain')
    return 'No pude confirmar el resultado del agente. No repetiré la solicitud automáticamente.';
  if (
    ['UNKNOWN_AGENT', 'AGENT_DISABLED', 'AGENT_UNAVAILABLE'].includes(
      error.code,
    )
  )
    return 'Ese agente no está disponible para esta consulta.';
  if (['FORBIDDEN', 'UNKNOWN_CAPABILITY', 'UNAUTHORIZED'].includes(error.code))
    return 'No tienes acceso a esa capacidad de lectura.';
  if (error.code === 'VALIDATION_FAILED')
    return 'La consulta no es válida. Usa texto simple de 1 a 128 caracteres.';
  if (error.code === 'RATE_LIMITED')
    return 'El agente alcanzó su límite de solicitudes. Prueba más tarde.';
  if (error.code === 'CAPACITY_EXCEEDED')
    return 'Jarvis no puede admitir más consultas de agentes en este momento.';
  if (error.code === 'IDEMPOTENCY_CONFLICT')
    return 'Este mensaje ya corresponde a otra consulta. No ejecutaré una segunda operación.';
  return 'No pude obtener una respuesta del agente.';
}

/** Deterministic read-only vertical slice; no Telegram IDs or domain effects here. */
export class AgentReadService {
  readonly #registry: AgentRegistry;
  readonly #execution: AgentExecutionService;

  constructor(registry: AgentRegistry, execution: AgentExecutionService) {
    this.#registry = registry;
    this.#execution = execution;
  }

  list(actorValue: AgentActor): string {
    try {
      const actor = actorSchema.parse(actorValue);
      const lines = ['Agentes y capacidades de lectura disponibles:'];
      for (const entry of this.#registry.list(actor.instance_id)) {
        for (const capability of entry.descriptor.capabilities) {
          if (!supported(capability)) continue;
          try {
            authorizeExecution(this.#registry, {
              ...actor,
              agent_id: entry.descriptor.agent_id,
              capability,
            });
          } catch {
            continue;
          }
          const line = `${entry.descriptor.agent_id} · ${capability.name} (${capability.version})`;
          if (lines.join('\n').length + line.length + 1 > 3400)
            return `${lines.join('\n')}\nLista limitada; consulta la configuración local.`;
          lines.push(line);
        }
      }
      return lines.length > 1
        ? lines.join('\n')
        : 'No tienes agentes de lectura disponibles.';
    } catch {
      return 'No tienes agentes de lectura disponibles.';
    }
  }

  async invoke(
    actorValue: AgentActor,
    value: unknown,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const actor = actorSchema.parse(actorValue);
      const parsed = inputSchema.safeParse(value);
      if (!parsed.success) throw new AgentGatewayError('VALIDATION_FAILED');
      const input = parsed.data;
      if (signal.aborted) throw new AgentGatewayError('CANCELLED');
      const capability = authorizeExecution(this.#registry, {
        ...actor,
        agent_id: input.agentId,
        capability: { name: input.capability, version: '1.0' },
      });
      if (!supported(capability)) throw new AgentGatewayError('FORBIDDEN');
      const result = await this.#execution.execute(
        actor,
        {
          protocol_version: '1.0',
          kind: 'execute',
          ...actor,
          agent_id: input.agentId,
          ...input.ids,
          capability: { name: capability.name, version: capability.version },
          deadline_at: new Date(Date.now() + 10_000).toISOString(),
          cost_policy: 'no-paid-services',
          input: { text: input.text },
        },
        signal,
      );
      if (result.status === 'pending')
        return 'El agente aceptó la consulta y sigue pendiente. Aún no hay un resultado confirmado.';
      if (result.status === 'failed')
        return agentReadError(
          new AgentGatewayError(result.error.code, 'failed'),
        );
      // The initial echo contract can only reflect the approved input. Never
      // display arbitrary fields, instructions or purported secrets from a peer.
      const output = echoTextSchema.safeParse(result.output.text);
      if (!output.success || output.data !== input.text)
        return 'El agente devolvió una respuesta que no puedo mostrar con seguridad.';
      return `Respuesta del agente: ${output.data}`;
    } catch (error) {
      return agentReadError(error);
    }
  }
}
