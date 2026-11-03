import { setTimeout } from 'node:timers/promises';
import type { TelegramAgentCommands } from './agent-commands.ts';

export type TelegramLogEvent =
  | 'telegram-started'
  | 'telegram-stopped'
  | 'telegram-poll-retry'
  | 'telegram-send-rejected'
  | 'telegram-delivery-unconfirmed'
  | 'telegram-agent-capacity';

export type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface RuntimeHooks {
  readonly wait?: Wait;
  readonly now?: () => number;
  readonly log?: (event: TelegramLogEvent) => void;
  readonly agentCommands?: TelegramAgentCommands;
}

export const wait: Wait = async (milliseconds, signal) => {
  await setTimeout(milliseconds, undefined, { signal });
};
