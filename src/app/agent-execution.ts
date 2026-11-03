import { z } from 'zod';

import { AgentGatewayError } from '../agents/errors.ts';
import { jsonObjectSnapshot } from '../agents/json.ts';
import type {
  AgentExecutionResult,
  AgentGateway,
  AgentRegistry,
} from '../agents/protocol.ts';
import { authorizeExecution, authorizeSubject } from '../agents/registry.ts';
import {
  identifierSchema,
  parseExecutionRequest,
  parseOperationQuery,
} from '../agents/validation.ts';

/** Identidad ya autenticada por el adaptador servidor; no se obtiene del mensaje. */
export interface AgentActor {
  readonly instance_id: string;
  readonly subject_ref: string;
}

function actorSnapshot(value: unknown): AgentActor {
  try {
    return Object.freeze(
      z
        .strictObject({
          instance_id: identifierSchema,
          subject_ref: identifierSchema,
        })
        .parse(jsonObjectSnapshot(value)),
    );
  } catch {
    throw new AgentGatewayError('FORBIDDEN');
  }
}

export class AgentExecutionService {
  readonly #registry: AgentRegistry;
  readonly #gateway: AgentGateway;

  constructor(registry: AgentRegistry, gateway: AgentGateway) {
    this.#registry = registry;
    this.#gateway = gateway;
  }

  async execute(
    actorValue: unknown,
    value: unknown,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const actor = actorSnapshot(actorValue);
    const request = parseExecutionRequest(value);
    if (
      actor.instance_id !== request.instance_id ||
      actor.subject_ref !== request.subject_ref
    )
      throw new AgentGatewayError('FORBIDDEN');
    authorizeExecution(this.#registry, request);
    try {
      return await this.#gateway.execute(request, signal);
    } catch (error) {
      throw error instanceof AgentGatewayError
        ? error
        : new AgentGatewayError('UNAVAILABLE', 'uncertain');
    }
  }

  async getOperation(
    actorValue: unknown,
    value: unknown,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const actor = actorSnapshot(actorValue);
    const query = parseOperationQuery(value);
    if (
      actor.instance_id !== query.instance_id ||
      actor.subject_ref !== query.subject_ref
    )
      throw new AgentGatewayError('FORBIDDEN');
    authorizeSubject(this.#registry, query);
    // El Gateway comprueba además la capacidad y la vinculación al pending original.
    try {
      return await this.#gateway.getOperation(query, signal);
    } catch (error) {
      throw error instanceof AgentGatewayError
        ? error
        : new AgentGatewayError('UNAVAILABLE', 'uncertain');
    }
  }
}
