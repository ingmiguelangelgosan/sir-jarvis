import type { AgentErrorCode } from './protocol.ts';

export type ExecutionOutcome =
  'not-started' | 'uncertain' | 'completed' | 'pending' | 'failed';
export type GatewayErrorCode =
  | AgentErrorCode
  | 'INVALID_CONFIGURATION'
  | 'UNKNOWN_AGENT'
  | 'UNKNOWN_OPERATION'
  | 'AGENT_DISABLED'
  | 'AGENT_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'CANCELLED'
  | 'RESULT_EXPIRED'
  | 'CAPACITY_EXCEEDED';

const messages: Record<GatewayErrorCode, string> = {
  UNSUPPORTED_PROTOCOL: 'Versión de protocolo no soportada.',
  UNAUTHORIZED: 'Origen no autenticado.',
  FORBIDDEN: 'Operación no autorizada.',
  UNKNOWN_CAPABILITY: 'Capacidad no registrada.',
  VALIDATION_FAILED: 'Datos de operación inválidos.',
  IDEMPOTENCY_CONFLICT: 'La clave de idempotencia pertenece a otra operación.',
  RATE_LIMITED: 'Límite de solicitudes alcanzado.',
  TIMEOUT: 'Se agotó el plazo local; no confirma el estado remoto.',
  UNAVAILABLE: 'No se pudo obtener un resultado del transporte.',
  INTERNAL_ERROR: 'No se pudo completar la operación.',
  INVALID_CONFIGURATION: 'Configuración local de agentes inválida.',
  UNKNOWN_AGENT: 'Agente no registrado.',
  UNKNOWN_OPERATION: 'Operación pendiente no registrada en este contexto.',
  AGENT_DISABLED: 'Agente deshabilitado.',
  AGENT_UNAVAILABLE: 'Disponibilidad del agente no confirmada.',
  INVALID_RESPONSE: 'Respuesta del agente inválida.',
  CANCELLED: 'Se canceló la espera local; no confirma cancelación remota.',
  RESULT_EXPIRED:
    'El resultado transitorio caducó; la operación no se ejecutará otra vez.',
  CAPACITY_EXCEEDED: 'Se alcanzó la capacidad local de solicitudes.',
};

const httpStatuses: Record<GatewayErrorCode, number> = {
  UNSUPPORTED_PROTOCOL: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  UNKNOWN_CAPABILITY: 404,
  VALIDATION_FAILED: 422,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  INVALID_CONFIGURATION: 500,
  UNKNOWN_AGENT: 404,
  UNKNOWN_OPERATION: 404,
  AGENT_DISABLED: 503,
  AGENT_UNAVAILABLE: 503,
  INVALID_RESPONSE: 502,
  CANCELLED: 499,
  RESULT_EXPIRED: 410,
  CAPACITY_EXCEEDED: 503,
};

export function safeAgentMessage(code: AgentErrorCode): string {
  return typeof code === 'string' && Object.hasOwn(messages, code)
    ? messages[code]
    : messages.INTERNAL_ERROR;
}

export class AgentGatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly outcome: ExecutionOutcome;
  readonly httpStatus: number;

  constructor(
    code: GatewayErrorCode,
    outcome: ExecutionOutcome = 'not-started',
  ) {
    const safeCode =
      typeof code === 'string' && Object.hasOwn(messages, code)
        ? code
        : 'INTERNAL_ERROR';
    super(messages[safeCode]);
    this.name = 'AgentGatewayError';
    this.code = safeCode;
    this.outcome = [
      'not-started',
      'uncertain',
      'completed',
      'pending',
      'failed',
    ].includes(outcome)
      ? outcome
      : 'uncertain';
    this.httpStatus = httpStatuses[safeCode];
    Object.freeze(this);
  }
}

/** Rechazo simulado explícito; no conserva errores, headers ni URLs originales. */
export class AgentTransportError extends Error {
  readonly kind: 'rate-limit' | 'unavailable';
  readonly retryAfterMs: number | undefined;

  constructor(kind: 'rate-limit' | 'unavailable', retryAfterMs?: number) {
    super('El transporte simulado no devolvió un resultado.');
    this.name = 'AgentTransportError';
    this.kind = kind === 'rate-limit' ? kind : 'unavailable';
    this.retryAfterMs =
      retryAfterMs === undefined || typeof retryAfterMs === 'number'
        ? retryAfterMs
        : Number.NaN;
    Object.freeze(this);
  }
}
