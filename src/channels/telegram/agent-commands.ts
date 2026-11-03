import { createHmac } from 'node:crypto';

import { type AgentReadService, agentReadError } from '../../app/agent-read.ts';
import type { AgentActor } from '../../app/agent-execution.ts';

export interface TelegramAgentMessage {
  readonly userId: number;
  readonly chatId: number;
  readonly messageId: number;
  readonly botUsername: string;
  readonly botId?: number;
  readonly text: string;
}

export type TelegramAgentCommands = (
  message: TelegramAgentMessage,
  signal: AbortSignal,
) => Promise<string | undefined>;

export function isTelegramAgentCommand(text: string): boolean {
  return /^\/(?:agents|agent)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text);
}

/** Install only from trusted server composition, after allowlist/private-chat checks. */
export function createTelegramAgentCommands(options: {
  readonly instanceId: string;
  readonly bindings: readonly {
    readonly telegram_user_id: number;
    readonly subject_ref: string;
  }[];
  readonly actionKey: string;
  readonly reads: AgentReadService;
}): TelegramAgentCommands {
  const bindings = new Map(
    options.bindings.map((entry) => [
      entry.telegram_user_id,
      entry.subject_ref,
    ]),
  );
  const key = Buffer.from(options.actionKey, 'base64url');
  const instanceId = options.instanceId;
  const reads = options.reads;
  let active = 0;
  return async (message, signal) => {
    if (!isTelegramAgentCommand(message.text)) return undefined;
    if (signal.aborted) return undefined;
    const subject = bindings.get(message.userId);
    if (!subject || message.chatId !== message.userId)
      return 'No tienes un perfil de agentes habilitado.';
    const actor: AgentActor = { instance_id: instanceId, subject_ref: subject };
    const match = /^\/(agents|agent)(?:@([A-Za-z0-9_]+))?(?:[ \t]+(.*))?$/.exec(
      message.text,
    );
    if (
      !match ||
      (match[2] && match[2].toLowerCase() !== message.botUsername.toLowerCase())
    )
      return 'Formato inválido. Usa /agents o /agent <agente> <capacidad> <texto>.';
    if (match[1] === 'agents')
      return match[3] === undefined
        ? reads.list(actor)
        : 'Usa /agents sin parámetros.';
    const args =
      /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+(.+)$/.exec(
        match[3] ?? '',
      );
    if (!args)
      return 'Usa /agent <agente> <capacidad> <texto de 1 a 128 caracteres>.';
    if (active >= 8)
      return 'Jarvis está atendiendo otras consultas. Prueba más tarde.';
    const digest = (namespace: string) =>
      createHmac('sha256', key)
        .update(
          JSON.stringify([
            namespace,
            instanceId,
            subject,
            message.botId ?? message.botUsername.toLowerCase(),
            message.chatId,
            message.messageId,
          ]),
        )
        .digest('hex');
    active += 1;
    try {
      return await reads.invoke(
        actor,
        {
          agentId: args[1],
          capability: args[2],
          text: args[3],
          ids: {
            request_id: `req.${digest('request')}`,
            correlation_id: `flow.${digest('correlation')}`,
            idempotency_key: `action.${digest('action')}`,
          },
        },
        signal,
      );
    } catch (error) {
      return agentReadError(error);
    } finally {
      active -= 1;
    }
  };
}
