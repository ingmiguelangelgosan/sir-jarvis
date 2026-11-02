import { z } from 'zod';
import { types } from 'node:util';

import { AgentGatewayError, safeAgentMessage } from './errors.ts';
import { canonicalJson, jsonObjectSnapshot } from './json.ts';
import type {
  AgentCapability,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentOperationQuery,
  AgentRegistration,
  JsonObject,
} from './protocol.ts';

export const identifierSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => value === value.trim());
const capabilityRef = z.strictObject({
  name: identifierSchema,
  version: identifierSchema,
});
const envelope = {
  protocol_version: z.literal('1.0'),
  instance_id: identifierSchema,
  agent_id: identifierSchema,
  subject_ref: identifierSchema,
  correlation_id: identifierSchema,
};
const errorSchema = z.strictObject({
  code: z.enum([
    'UNSUPPORTED_PROTOCOL',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'UNKNOWN_CAPABILITY',
    'VALIDATION_FAILED',
    'IDEMPOTENCY_CONFLICT',
    'RATE_LIMITED',
    'TIMEOUT',
    'UNAVAILABLE',
    'INTERNAL_ERROR',
  ]),
  message: z.string().min(1).max(512),
  retryable: z.boolean(),
  retry_after_ms: z.number().int().min(1).max(86_400_000).optional(),
});
const resultBase = {
  ...envelope,
  kind: z.literal('execution-result'),
  request_id: identifierSchema,
};
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...resultBase,
    status: z.literal('completed'),
    output: z.unknown(),
  }),
  z.strictObject({
    ...resultBase,
    status: z.literal('pending'),
    operation_id: identifierSchema,
    poll_after_ms: z.number().int().min(1).max(86_400_000),
  }),
  z.strictObject({
    ...resultBase,
    status: z.literal('failed'),
    error: errorSchema,
  }),
]);
const requestSchema = z.strictObject({
  ...envelope,
  kind: z.literal('execute'),
  request_id: identifierSchema,
  idempotency_key: identifierSchema,
  capability: capabilityRef,
  deadline_at: z.iso
    .datetime()
    .refine((value) => Number.isFinite(Date.parse(value))),
  cost_policy: z.literal('no-paid-services'),
  input: z.unknown(),
});
const querySchema = z.strictObject({
  ...envelope,
  request_id: identifierSchema,
  operation_id: identifierSchema,
});
const registrationSchema = z.strictObject({
  instance_id: identifierSchema,
  descriptor: z.strictObject({
    protocol_version: z.literal('1.0'),
    agent_id: identifierSchema,
    agent_version: identifierSchema,
    name: z.string().min(1).max(128),
    capabilities: z
      .array(
        z.strictObject({
          ...capabilityRef.shape,
          description: z.string().max(512),
          effect: z.enum(['read', 'write']),
          supports_idempotency: z.boolean(),
          input_schema_id: identifierSchema,
          output_schema_id: identifierSchema,
        }),
      )
      .min(1)
      .max(128),
  }),
  enabled: z.boolean(),
  availability: z.enum(['unknown', 'available', 'unavailable']),
  connection: z.strictObject({
    base_url: z.string().max(2048),
    request_credential_ref: identifierSchema,
    event_key_ref: identifierSchema,
  }),
  permissions: z
    .array(
      z.strictObject({
        subject_ref: identifierSchema,
        capabilities: z.array(capabilityRef).min(1).max(128),
      }),
    )
    .max(128),
});

export interface PayloadSchemaDefinition {
  readonly id: string;
  readonly schema: { parse(value: unknown): unknown };
}

/** Validadores de confianza configurados en código local, nunca recibidos de un agente. */
export class CapabilitySchemaCatalog {
  readonly #schemas = new Map<string, (value: unknown) => unknown>();

  constructor(definitions: readonly PayloadSchemaDefinition[]) {
    try {
      if (definitions.length > 256) throw new Error();
      for (const definition of definitions) {
        identifierSchema.parse(definition.id);
        if (
          this.#schemas.has(definition.id) ||
          typeof definition.schema.parse !== 'function'
        )
          throw new Error();
        this.#schemas.set(
          definition.id,
          definition.schema.parse.bind(definition.schema),
        );
      }
    } catch {
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    }
  }

  has(id: string): boolean {
    return this.#schemas.has(id);
  }

  validate(id: string, value: unknown): JsonObject {
    try {
      const parse = this.#schemas.get(id);
      if (!parse) throw new Error();
      const input = jsonObjectSnapshot(value);
      const parsed = parse(input);
      if (types.isPromise(parsed)) {
        // Configuración exclusivamente síncrona. Consumir el rechazo sin conservar
        // su contenido para no generar unhandledRejection con datos privados.
        void parsed.then(
          () => undefined,
          () => undefined,
        );
        throw new Error();
      }
      const result = jsonObjectSnapshot(parsed);
      // Rechazar coerción, defaults, transformaciones y campos descartados silenciosamente.
      if (canonicalJson(result) !== canonicalJson(input)) throw new Error();
      return result;
    } catch {
      throw new AgentGatewayError('VALIDATION_FAILED');
    }
  }
}

export function parseExecutionRequest(value: unknown): AgentExecutionRequest {
  try {
    const input = jsonObjectSnapshot(value);
    if (
      input.protocol_version !== undefined &&
      input.protocol_version !== '1.0'
    )
      throw new AgentGatewayError('UNSUPPORTED_PROTOCOL');
    const result = requestSchema.parse(input);
    return jsonObjectSnapshot({
      ...result,
      input: jsonObjectSnapshot(result.input),
    }) as unknown as AgentExecutionRequest;
  } catch (error) {
    if (
      error instanceof AgentGatewayError &&
      error.code === 'UNSUPPORTED_PROTOCOL'
    )
      throw error;
    throw new AgentGatewayError('VALIDATION_FAILED');
  }
}

export function parseOperationQuery(value: unknown): AgentOperationQuery {
  try {
    return Object.freeze(querySchema.parse(jsonObjectSnapshot(value)));
  } catch {
    throw new AgentGatewayError('VALIDATION_FAILED');
  }
}

export function parseRegistration(value: unknown): AgentRegistration {
  try {
    return jsonObjectSnapshot(
      registrationSchema.parse(jsonObjectSnapshot(value)),
    ) as unknown as AgentRegistration;
  } catch {
    throw new AgentGatewayError('INVALID_CONFIGURATION');
  }
}

export function parseExecutionResult(
  value: unknown,
  expected: Pick<
    AgentExecutionRequest,
    'instance_id' | 'agent_id' | 'subject_ref' | 'request_id' | 'correlation_id'
  >,
  capability: AgentCapability,
  schemas: CapabilitySchemaCatalog,
): AgentExecutionResult {
  try {
    const result = resultSchema.parse(jsonObjectSnapshot(value));
    for (const key of [
      'instance_id',
      'agent_id',
      'subject_ref',
      'request_id',
      'correlation_id',
    ] as const) {
      if (result[key] !== expected[key]) throw new Error();
    }
    const safe =
      result.status === 'completed'
        ? {
            ...result,
            output: schemas.validate(
              capability.output_schema_id,
              result.output,
            ),
          }
        : result.status === 'failed'
          ? {
              ...result,
              error: {
                ...result.error,
                message: safeAgentMessage(result.error.code),
              },
            }
          : result;
    return jsonObjectSnapshot(safe) as unknown as AgentExecutionResult;
  } catch {
    throw new AgentGatewayError('INVALID_RESPONSE', 'uncertain');
  }
}
