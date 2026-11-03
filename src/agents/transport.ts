import type { AgentExecutionRequest, AgentOperationQuery } from './protocol.ts';

/** Puerto inyectado: fake local o adaptador HTTPS; sin reglas de dominio. */
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
