// Comprobaciones estáticas: npm run typecheck. No es un test de runtime o JSON.
import type {
  AgentDescriptor,
  AgentEnvelope,
  AgentError,
  AgentEvent,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRegistration,
} from '../src/agents/protocol.ts';

const descriptor = {
  protocol_version: '1.0',
  agent_id: 'demo.echo',
  agent_version: '0.1.0',
  name: 'Agente de ejemplo ficticio',
  capabilities: [
    {
      name: 'echo.reply',
      version: '1.0',
      description: 'Devuelve datos ficticios para comprobar el contrato.',
      effect: 'read',
      supports_idempotency: true,
      input_schema_id: 'demo.echo.input.v1',
      output_schema_id: 'demo.echo.output.v1',
    },
  ],
} satisfies AgentDescriptor;

const registration = {
  instance_id: 'instance-demo',
  descriptor,
  enabled: false,
  availability: 'unknown',
  connection: {
    base_url: 'https://echo.example.invalid',
    request_credential_ref: 'demo-request-secret-reference',
    event_key_ref: 'demo-event-key-reference',
  },
  permissions: [
    {
      subject_ref: 'subject-demo',
      capabilities: [{ name: 'echo.reply', version: '1.0' }],
    },
  ],
} satisfies AgentRegistration;

const envelope = {
  protocol_version: '1.0',
  instance_id: 'instance-demo',
  agent_id: 'demo.echo',
  subject_ref: 'subject-demo',
  correlation_id: 'flow-demo-001',
} satisfies AgentEnvelope;

const execution = {
  ...envelope,
  kind: 'execute',
  request_id: 'request-demo-001',
  idempotency_key: 'effect-demo-001',
  capability: { name: 'echo.reply', version: '1.0' },
  deadline_at: '2026-11-02T23:00:10Z',
  cost_policy: 'no-paid-services',
  input: { text: 'Texto ficticio sin información privada.' },
} satisfies AgentExecutionRequest;

const resultEnvelope = {
  ...envelope,
  kind: 'execution-result',
  request_id: execution.request_id,
} as const;

const completed = {
  ...resultEnvelope,
  status: 'completed',
  output: { text: 'Respuesta ficticia.' },
} satisfies AgentExecutionResult;

const pending = {
  ...resultEnvelope,
  status: 'pending',
  operation_id: 'operation-demo-001',
  poll_after_ms: 1_000,
} satisfies AgentExecutionResult;

const failed = {
  ...resultEnvelope,
  status: 'failed',
  error: {
    code: 'VALIDATION_FAILED',
    message: 'Faltan datos ficticios para completar el ejemplo.',
    retryable: false,
  },
} satisfies AgentExecutionResult;

const eventEnvelope = {
  ...envelope,
  event_id: 'event-demo-001',
  occurred_at: '2026-11-02T23:00:00Z',
};

const notification = {
  ...eventEnvelope,
  kind: 'notification',
  subscription_id: 'subscription-demo-001',
  capability: { name: 'echo.reply', version: '1.0' },
  event_type: 'echo.reply.ready',
  payload: { text: 'Notificación ficticia solicitada por el operador.' },
} satisfies AgentEvent;

const operationCompleted = {
  ...eventEnvelope,
  kind: 'operation.completed',
  request_id: execution.request_id,
  operation_id: pending.operation_id,
  output: { text: 'Operación ficticia terminada.' },
} satisfies AgentEvent;

const differentVersion = { ...descriptor, protocol_version: '2.0' } as const;
// @ts-expect-error El perfil actual solo admite la versión 1.0.
const rejectedVersion = differentVersion satisfies AgentDescriptor;

const paidExecution = { ...execution, cost_policy: 'paid' } as const;
// @ts-expect-error Ningún mensaje puede habilitar servicios pagos.
const rejectedPaidPolicy = paidExecution satisfies AgentExecutionRequest;

const incompletePending = {
  ...resultEnvelope,
  status: 'pending',
  poll_after_ms: 1_000,
} as const;
// @ts-expect-error Un resultado pendiente exige operation_id.
const rejectedPending = incompletePending satisfies AgentExecutionResult;

const mixedResult = { ...completed, error: failed.error } as const;
// @ts-expect-error Los estados completed y failed no pueden mezclarse.
const rejectedMixedResult = mixedResult satisfies AgentExecutionResult;

const unsolicitedRequest = {
  ...notification,
  request_id: execution.request_id,
} as const;
// @ts-expect-error Una notificación autónoma no es una respuesta a request_id.
const rejectedNotification = unsolicitedRequest satisfies AgentEvent;

const unknownError = { ...failed.error, code: 'UNRECOGNIZED_ERROR' } as const;
// @ts-expect-error Los códigos de error pertenecen al conjunto versionado.
const rejectedError = unknownError satisfies AgentError;

void [
  registration,
  completed,
  pending,
  failed,
  notification,
  operationCompleted,
  rejectedVersion,
  rejectedPaidPolicy,
  rejectedPending,
  rejectedMixedResult,
  rejectedNotification,
  rejectedError,
];
