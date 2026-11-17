import type { ExecutionOutcome } from '../agents/errors.ts';
import type { AgentExecutionRequest, JsonObject } from '../agents/protocol.ts';

export interface ConfirmationScope {
  readonly instance_id: string;
  readonly subject_ref: string;
  /** Server-derived HMAC of the authenticated conversation, never a raw channel ID. */
  readonly conversation_ref: string;
}
export interface ExpenseDraft {
  readonly amount: string;
  readonly currency: 'COP';
  readonly categoryId: string;
  readonly occurredOn: string;
  readonly label: string;
}
export type ConfirmationState =
  | 'awaiting_confirmation'
  | 'cancelled'
  | 'executing'
  | 'completed'
  | 'uncertain'
  | 'failed';
export interface Confirmation {
  readonly reference: string;
  readonly scope: ConfirmationScope;
  readonly draft: ExpenseDraft;
  readonly revision: number;
  readonly version: number;
  readonly state: ConfirmationState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly sourceRef: string;
  readonly consentSourceRef: string | null;
  readonly consentedAt: number | null;
  readonly requestId: string;
  readonly correlationId: string;
  readonly intentKey: string;
  readonly request: AgentExecutionRequest | null;
  readonly outcome: ExecutionOutcome | null;
  readonly evidence: JsonObject | null;
  readonly reason: string | null;
}
export interface ConfirmationChange {
  readonly state: ConfirmationState;
  readonly request?: AgentExecutionRequest;
  readonly outcome?: ExecutionOutcome;
  readonly evidence?: JsonObject;
  readonly reason?: string;
  readonly consentSourceRef?: string;
  readonly consentedAt?: number;
}
export interface ConfirmationAudit {
  readonly sequence: number;
  readonly reference: string;
  readonly fromState: ConfirmationState | null;
  readonly toState: ConfirmationState;
  readonly event: string;
  readonly sourceRef: string;
  readonly at: number;
  readonly version: number;
}
/** Separate conversation state; never repurpose the delivery/execution journal. */
export interface ConfirmationStore {
  prepare(
    scope: ConfirmationScope,
    draft: ExpenseDraft,
    sourceRef: string,
    now: number,
  ): Confirmation;
  get(scope: ConfirmationScope, reference: string): Confirmation;
  active(scope: ConfirmationScope): Confirmation | undefined;
  change(
    scope: ConfirmationScope,
    reference: string,
    expectedVersion: number,
    change: ConfirmationChange,
    event: string,
    sourceRef: string,
    now: number,
  ): Confirmation | undefined;
  history(
    scope: ConfirmationScope,
    reference: string,
  ): readonly ConfirmationAudit[];
  close(): void;
}
