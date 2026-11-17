import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentGatewayError } from '../agents/errors.ts';
import { authorizeExecution } from '../agents/registry.ts';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRegistry,
  JsonObject,
} from '../agents/protocol.ts';
import { expenseSchema } from '../agents/finance-expense-profile.ts';
import {
  identifierSchema,
  parseExecutionRequest,
} from '../agents/validation.ts';
import { jsonObjectSnapshot } from '../agents/json.ts';
import type { AgentExecutionService } from './agent-execution.ts';
import type {
  Confirmation,
  ConfirmationChange,
  ConfirmationScope,
  ConfirmationStore,
  ExpenseDraft,
} from './confirmation-store.ts';

const scopeSchema = z.strictObject({
  instance_id: identifierSchema,
  subject_ref: identifierSchema,
  conversation_ref: z.string().regex(/^[a-f0-9]{64}$/),
});
const sourceSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Experimental opt-in orchestration; no startup/loader imports this service. */
export class ExpenseConfirmationService {
  readonly #store: ConfirmationStore;
  readonly #execution: Pick<AgentExecutionService, 'execute'>;
  readonly #registry: AgentRegistry;
  readonly #agentId: string;
  readonly #now: () => number;
  readonly #executionNow: () => number;
  constructor(options: {
    readonly store: ConfirmationStore;
    readonly execution: Pick<AgentExecutionService, 'execute'>;
    readonly registry: AgentRegistry;
    readonly agentId: string;
    readonly now?: () => number;
    readonly executionNow?: () => number;
  }) {
    this.#store = options.store;
    this.#execution = options.execution;
    this.#registry = options.registry;
    this.#agentId = identifierSchema.parse(options.agentId);
    this.#now = options.now ?? Date.now;
    this.#executionNow = options.executionNow ?? this.#now;
  }
  #authorize(
    value: ConfirmationScope,
    capability: 'record' | 'lookup',
  ): ConfirmationScope {
    const scope = scopeSchema.parse(value);
    authorizeExecution(this.#registry, {
      instance_id: scope.instance_id,
      subject_ref: scope.subject_ref,
      agent_id: this.#agentId,
      capability: { name: `finance.expense.${capability}`, version: '1.0' },
    });
    return scope;
  }
  #time(): number {
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - 300000
    )
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    return now;
  }
  #change(
    row: Confirmation,
    change: ConfirmationChange,
    event: string,
    source: string,
  ): Confirmation {
    return (
      this.#store.change(
        row.scope,
        row.reference,
        row.version,
        change,
        event,
        source,
        this.#time(),
      ) ?? this.#store.get(row.scope, row.reference)
    );
  }
  #evidence(row: Confirmation, value: unknown): JsonObject {
    const expense = expenseSchema.parse(value);
    const [whole = '0', fraction = ''] = row.draft.amount.split('.');
    const minor = (whole + fraction.padEnd(2, '0')).replace(/^0+/, '');
    if (
      expense.amount.minor !== minor ||
      expense.categoryId !== row.draft.categoryId ||
      expense.occurredOn !== row.draft.occurredOn
    )
      throw new AgentGatewayError('INVALID_RESPONSE', 'uncertain');
    return jsonObjectSnapshot(expense);
  }
  prepare(
    value: ConfirmationScope,
    draft: ExpenseDraft,
    sourceRef: string,
  ): Confirmation {
    const scope = this.#authorize(value, 'record');
    return this.#store.prepare(
      scope,
      draft,
      sourceSchema.parse(sourceRef),
      this.#time(),
    );
  }
  pending(value: ConfirmationScope): Confirmation | undefined {
    const scope = this.#authorize(value, 'lookup');
    return this.#store.active(scope);
  }
  inspect(value: ConfirmationScope, reference: string): Confirmation {
    return this.#store.get(this.#authorize(value, 'lookup'), reference);
  }
  cancel(
    value: ConfirmationScope,
    reference: string,
    sourceRef: string,
  ): Confirmation {
    const scope = this.#authorize(value, 'record'),
      source = sourceSchema.parse(sourceRef);
    const row = this.#store.get(scope, reference);
    if (row.state === 'cancelled') return row;
    if (row.state !== 'awaiting_confirmation')
      throw new AgentGatewayError('IDEMPOTENCY_CONFLICT', 'uncertain');
    return this.#change(
      row,
      { state: 'cancelled', reason: 'cancelled' },
      'cancelled',
      source,
    );
  }
  async confirm(
    value: ConfirmationScope,
    reference: string,
    sourceRef: string,
    signal: AbortSignal,
  ): Promise<Confirmation> {
    const scope = this.#authorize(value, 'record'),
      source = sourceSchema.parse(sourceRef);
    const row = this.#store.get(scope, reference);
    if (row.state !== 'awaiting_confirmation') return row;
    const now = this.#time();
    if (row.expiresAt <= now)
      return this.#change(
        row,
        { state: 'cancelled', reason: 'expired' },
        'expired',
        source,
      );
    if (signal.aborted) throw new AgentGatewayError('CANCELLED');
    const request = parseExecutionRequest({
      protocol_version: '1.0',
      kind: 'execute',
      instance_id: scope.instance_id,
      subject_ref: scope.subject_ref,
      agent_id: this.#agentId,
      request_id: row.requestId,
      correlation_id: row.correlationId,
      idempotency_key: row.intentKey,
      capability: { name: 'finance.expense.record', version: '1.0' },
      deadline_at: new Date(this.#executionNow() + 20000).toISOString(),
      cost_policy: 'no-paid-services',
      input: {
        amount: row.draft.amount,
        currency: row.draft.currency,
        categoryId: row.draft.categoryId,
        occurredOn: row.draft.occurredOn,
      },
    });
    const claimed = this.#store.change(
      scope,
      reference,
      row.version,
      {
        state: 'executing',
        request,
        consentSourceRef: source,
        consentedAt: now,
      },
      'confirmed',
      source,
      now,
    );
    if (!claimed) return this.#store.get(scope, reference);
    let result: AgentExecutionResult;
    try {
      result = await this.#execution.execute(
        { instance_id: scope.instance_id, subject_ref: scope.subject_ref },
        request,
        signal,
      );
    } catch (error) {
      const outcome =
        error instanceof AgentGatewayError ? error.outcome : 'uncertain';
      const definitive = outcome === 'not-started' || outcome === 'failed';
      return this.#change(
        claimed,
        { state: definitive ? 'failed' : 'uncertain', outcome },
        'execution-result',
        source,
      );
    }
    if (result.status === 'completed') {
      let evidence: JsonObject;
      try {
        evidence = this.#evidence(claimed, result.output.expense);
      } catch {
        return this.#change(
          claimed,
          { state: 'uncertain', outcome: 'uncertain' },
          'execution-result',
          source,
        );
      }
      return this.#change(
        claimed,
        { state: 'completed', outcome: 'completed', evidence },
        'execution-result',
        source,
      );
    }
    return this.#change(
      claimed,
      {
        state: result.status === 'failed' ? 'failed' : 'uncertain',
        outcome: result.status === 'failed' ? 'failed' : 'pending',
      },
      'execution-result',
      source,
    );
  }
  async recover(
    value: ConfirmationScope,
    reference: string,
    sourceRef: string,
    signal: AbortSignal,
  ): Promise<Confirmation> {
    const scope = this.#authorize(value, 'lookup'),
      source = sourceSchema.parse(sourceRef);
    let row = this.#store.get(scope, reference);
    if (!['executing', 'uncertain'].includes(row.state)) return row;
    if (row.state === 'executing')
      row = this.#change(
        row,
        { state: 'uncertain', outcome: 'uncertain' },
        'recovery-started',
        source,
      );
    const readId = `lookup.${randomUUID()}`;
    const request: AgentExecutionRequest = parseExecutionRequest({
      protocol_version: '1.0',
      kind: 'execute',
      instance_id: scope.instance_id,
      subject_ref: scope.subject_ref,
      agent_id: this.#agentId,
      request_id: readId,
      correlation_id: readId,
      idempotency_key: readId,
      capability: { name: 'finance.expense.lookup', version: '1.0' },
      deadline_at: new Date(this.#executionNow() + 20000).toISOString(),
      cost_policy: 'no-paid-services',
      input: { write_intent_id: row.intentKey },
    });
    let result: AgentExecutionResult;
    try {
      result = await this.#execution.execute(
        { instance_id: scope.instance_id, subject_ref: scope.subject_ref },
        request,
        signal,
      );
    } catch {
      return this.#store.get(scope, reference);
    }
    if (result.status === 'completed' && result.output.found === true) {
      let evidence: JsonObject;
      try {
        evidence = this.#evidence(row, result.output.expense);
      } catch {
        return this.#store.get(scope, reference);
      }
      return this.#change(
        row,
        {
          state: row.outcome === 'completed' ? 'completed' : 'uncertain',
          evidence,
        },
        'evidence-found',
        source,
      );
    }
    return this.#change(
      row,
      { state: 'uncertain' },
      'recovery-not-found',
      source,
    );
  }
}
