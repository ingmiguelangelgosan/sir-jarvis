import { createHmac, randomUUID } from 'node:crypto';

import { AgentGatewayError } from '../../agents/errors.ts';
import type {
  DurableActionPhase,
  DurableStateStore,
} from '../../agents/state-store.ts';
import type { TelegramAgentMessage } from './agent-commands.ts';

export interface TelegramActionJournal {
  reserve(message: TelegramAgentMessage): string | undefined;
  result(key: string): void;
  deliveryPending(key: string): void;
  deliveryStarted(key: string): void;
  deliveryFinished(
    key: string,
    state: 'delivered' | 'delivery-uncertain' | 'delivery-rejected',
  ): void;
  offset(botId: number): number | undefined;
  advance(botId: number, offset: number): void;
}

/** Channel-local HMAC: no plaintext channel IDs or message bodies in storage. */
export function createDurableTelegramJournal(
  store: DurableStateStore,
  secret: string,
  instanceId: string,
): TelegramActionJournal {
  const key = Buffer.from(secret, 'base64url');
  const owner = randomUUID();
  const hash = (value: unknown) =>
    createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  const namespace = (botId: number) => {
    store.bind('telegram-bot', hash([instanceId, botId]));
    return hash(['offset', instanceId, botId]);
  };
  const phase = (action: string, state: DurableActionPhase) =>
    store.transitionAction(action, owner, state, Date.now());
  return {
    reserve(message) {
      if (!message.botId) throw new AgentGatewayError('INVALID_CONFIGURATION');
      namespace(message.botId);
      const action = hash([
        'telegram-action',
        instanceId,
        message.botId,
        message.userId,
        message.chatId,
        message.messageId,
      ]);
      const now = Date.now();
      const reservation = store.reserveAction({
        key: action,
        commandHash: hash(['telegram-command', message.text]),
        owner,
        phase: 'reserved',
        createdAt: now,
        updatedAt: now,
      });
      return reservation.created ? action : undefined;
    },
    result: (action) => phase(action, 'result-confirmed'),
    deliveryPending: (action) => phase(action, 'delivery-pending'),
    deliveryStarted: (action) => phase(action, 'delivery-started'),
    deliveryFinished: phase,
    offset: (botId) => store.getOffset(namespace(botId)),
    advance: (botId, offset) =>
      store.advanceOffset(namespace(botId), offset, Date.now()),
  };
}
