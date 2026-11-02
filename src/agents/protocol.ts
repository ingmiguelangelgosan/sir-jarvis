/** Perfil de protocolo propuesto. Solo tipos; no valida JSON ni conecta agentes. */
export type ProtocolVersion = '1.0';
export type JsonValue =
  string | number | boolean | null | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface CapabilityRef {
  readonly name: string;
  readonly version: string;
}

export interface AgentCapability extends CapabilityRef {
  readonly description: string;
  readonly effect: 'read' | 'write';
  readonly supports_idempotency: boolean;
  readonly input_schema_id: string;
  readonly output_schema_id: string;
}

export interface AgentDescriptor {
  readonly protocol_version: ProtocolVersion;
  readonly agent_id: string;
  readonly agent_version: string;
  readonly name: string;
  readonly capabilities: readonly AgentCapability[];
}

/** Configuración LOCAL, nunca un mensaje del protocolo ni una credencial. */
export interface AgentRegistration {
  readonly instance_id: string;
  readonly descriptor: AgentDescriptor;
  readonly enabled: boolean;
  readonly availability: 'unknown' | 'available' | 'unavailable';
  readonly connection: {
    readonly base_url: string;
    readonly request_credential_ref: string;
    readonly event_key_ref: string;
  };
  readonly permissions: readonly {
    readonly subject_ref: string;
    readonly capabilities: readonly CapabilityRef[];
  }[];
}

export interface AgentEnvelope {
  readonly protocol_version: ProtocolVersion;
  readonly instance_id: string;
  readonly agent_id: string;
  readonly subject_ref: string;
  readonly correlation_id: string;
}

export interface AgentExecutionRequest extends AgentEnvelope {
  readonly kind: 'execute';
  readonly request_id: string;
  readonly idempotency_key: string;
  readonly capability: CapabilityRef;
  readonly deadline_at: string;
  readonly cost_policy: 'no-paid-services';
  readonly input: JsonObject;
}

export type AgentErrorCode =
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'UNKNOWN_CAPABILITY'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface AgentError {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retry_after_ms?: number;
}

interface ExecutionResultBase extends AgentEnvelope {
  readonly kind: 'execution-result';
  readonly request_id: string;
}

export type AgentExecutionResult =
  | (ExecutionResultBase & {
      readonly status: 'completed';
      readonly output: JsonObject;
      readonly operation_id?: never;
      readonly poll_after_ms?: never;
      readonly error?: never;
    })
  | (ExecutionResultBase & {
      readonly status: 'pending';
      readonly operation_id: string;
      readonly poll_after_ms: number;
      readonly output?: never;
      readonly error?: never;
    })
  | (ExecutionResultBase & {
      readonly status: 'failed';
      readonly error: AgentError;
      readonly operation_id?: never;
      readonly poll_after_ms?: never;
      readonly output?: never;
    });

interface EventBase extends AgentEnvelope {
  readonly event_id: string;
  readonly occurred_at: string;
}

export type AgentEvent =
  | (EventBase & {
      readonly kind: 'operation.completed';
      readonly request_id: string;
      readonly operation_id: string;
      readonly output: JsonObject;
      readonly error?: never;
    })
  | (EventBase & {
      readonly kind: 'operation.failed';
      readonly request_id: string;
      readonly operation_id: string;
      readonly error: AgentError;
      readonly output?: never;
    })
  | (EventBase & {
      readonly kind: 'notification';
      readonly subscription_id: string;
      readonly capability: CapabilityRef;
      readonly event_type: string;
      readonly payload: JsonObject;
      readonly request_id?: never;
      readonly operation_id?: never;
    });

export interface AgentOperationQuery extends AgentEnvelope {
  readonly request_id: string;
  readonly operation_id: string;
}

/** Puertos para Fase 1B; todavía no existen implementaciones. */
export interface AgentRegistry {
  get(instanceId: string, agentId: string): AgentRegistration | undefined;
  list(instanceId: string): readonly AgentRegistration[];
}

export interface AgentGateway {
  execute(
    request: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult>;
  getOperation(
    query: AgentOperationQuery,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult>;
}
