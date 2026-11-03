import type { ExecutionOutcome, GatewayErrorCode } from './errors.ts';
import type { AgentExecutionRequest } from './protocol.ts';

export type DurableExecutionPhase = 'reserved' | 'started' | ExecutionOutcome;
export type DurableContext = Pick<
  AgentExecutionRequest,
  | 'protocol_version'
  | 'instance_id'
  | 'subject_ref'
  | 'agent_id'
  | 'request_id'
  | 'correlation_id'
  | 'capability'
>;
export interface DurableExecution {
  readonly key: string;
  readonly commandHash: string;
  readonly owner: string;
  readonly context: DurableContext;
  readonly phase: DurableExecutionPhase;
  readonly errorCode?: GatewayErrorCode;
  readonly outcome?: ExecutionOutcome;
  readonly operationId?: string;
  readonly pollAfterMs?: number;
  readonly pendingExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type ExecutionTransition = Pick<DurableExecution, 'phase'> &
  Partial<
    Pick<
      DurableExecution,
      | 'errorCode'
      | 'outcome'
      | 'operationId'
      | 'pollAfterMs'
      | 'pendingExpiresAt'
    >
  >;
export type DurableActionPhase =
  | 'reserved'
  | 'result-confirmed'
  | 'delivery-pending'
  | 'delivery-started'
  | 'delivered'
  | 'delivery-uncertain'
  | 'delivery-rejected';
export interface DurableAction {
  readonly key: string;
  readonly commandHash: string;
  readonly owner: string;
  readonly phase: DurableActionPhase;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Provider-neutral atomic operations. No payloads, credentials or channel IDs. */
export interface DurableStateStore {
  bind(namespace: string, fingerprint: string): void;
  reserveExecution(value: DurableExecution): {
    readonly created: boolean;
    readonly record: DurableExecution;
  };
  getExecution(key: string): DurableExecution | undefined;
  findOperation(
    scope: Pick<DurableContext, 'instance_id' | 'agent_id' | 'subject_ref'>,
    operationId: string,
  ): DurableExecution | undefined;
  transitionExecution(
    key: string,
    owner: string,
    change: ExecutionTransition,
    now: number,
  ): void;
  reserveAction(value: DurableAction): {
    readonly created: boolean;
    readonly record: DurableAction;
  };
  transitionAction(
    key: string,
    owner: string,
    phase: DurableActionPhase,
    now: number,
  ): void;
  getAction(key: string): DurableAction | undefined;
  getOffset(namespace: string): number | undefined;
  advanceOffset(namespace: string, offset: number, now: number): void;
  /** Redact aged terminal metadata; keep denial tombstones, pending and uncertain. */
  compact(before: number, now: number): number;
  close(): void;
}
