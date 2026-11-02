import type { AgentExecutionRequest, AgentOperationQuery } from './protocol.ts';

/** Puerto inyectado. Esta fase solo lo compone con funciones simuladas, nunca HTTP. */
export interface AgentTransport {
  execute(
    request: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
  getOperation(
    query: AgentOperationQuery,
    signal: AbortSignal,
  ): Promise<unknown>;
}
