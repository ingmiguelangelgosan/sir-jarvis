import { closeSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { EnvironmentAgentCredentials } from '../agents/credentials.ts';
import { InMemoryAgentGateway } from '../agents/gateway.ts';
import { HttpsAgentTransport } from '../agents/https-transport.ts';
import { jsonObjectSnapshot } from '../agents/json.ts';
import {
  HttpsEndpointPolicy,
  type AgentNetworkPolicy,
} from '../agents/network-policy.ts';
import type { AgentRegistration } from '../agents/protocol.ts';
import { InMemoryAgentRegistry } from '../agents/registry.ts';
import {
  CapabilitySchemaCatalog,
  identifierSchema,
  parseRegistration,
} from '../agents/validation.ts';
import { createTelegramAgentCommands } from '../channels/telegram/agent-commands.ts';
import { AgentExecutionService } from './agent-execution.ts';
import { AgentReadService, echoTextSchema } from './agent-read.ts';
import { ConfigurationError, type Environment } from './config.ts';

const safeFailure = () =>
  new ConfigurationError(
    'Configuración inválida de agentes Telegram. Revisa docs/TELEGRAM.md.',
  );
const configSchema = z.strictObject({
  instance_id: identifierSchema.refine((value) => !/^\d+$/.test(value)),
  subjects: z
    .array(
      z.strictObject({
        telegram_user_id: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        subject_ref: identifierSchema.refine((value) => !/^\d+$/.test(value)),
      }),
    )
    .max(128),
  agents: z.array(z.unknown()).max(64),
  allowed_endpoints: z
    .array(
      z.strictObject({
        origin: z.string().min(1).max(2048),
        private_addresses: z
          .array(z.string().min(1).max(128))
          .max(64)
          .optional(),
      }),
    )
    .max(64),
  credential_variables: z.record(
    identifierSchema,
    z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
      .refine(
        (name) =>
          !['JARVIS_TELEGRAM_AGENT_KEY', 'TELEGRAM_BOT_TOKEN'].includes(name),
      ),
  ),
  result_cache_ms: z.number().int().min(1).max(900_000),
  ca_file: z.string().min(1).max(2048).optional(),
});

export interface TelegramAgentsConfig extends Omit<
  z.infer<typeof configSchema>,
  'agents'
> {
  readonly agents: readonly AgentRegistration[];
}

export function parseTelegramAgentsConfig(
  value: unknown,
  allowedUserIds: readonly number[],
): TelegramAgentsConfig {
  try {
    const parsed = configSchema.parse(jsonObjectSnapshot(value));
    const users = new Set<number>();
    const subjects = new Set<string>();
    for (const binding of parsed.subjects) {
      if (
        !allowedUserIds.includes(binding.telegram_user_id) ||
        users.has(binding.telegram_user_id) ||
        subjects.has(binding.subject_ref)
      )
        throw new Error();
      users.add(binding.telegram_user_id);
      subjects.add(binding.subject_ref);
    }
    const agents = parsed.agents.map(parseRegistration);
    for (const entry of agents) {
      if (
        entry.instance_id !== parsed.instance_id ||
        !Object.hasOwn(
          parsed.credential_variables,
          entry.connection.request_credential_ref,
        ) ||
        entry.permissions.some((grant) => !subjects.has(grant.subject_ref))
      )
        throw new Error();
    }
    if (Object.keys(parsed.credential_variables).length > 64) throw new Error();
    return jsonObjectSnapshot({
      ...parsed,
      agents,
    }) as unknown as TelegramAgentsConfig;
  } catch {
    throw safeFailure();
  }
}

export function telegramAgentsEnabled(environment: Environment): boolean {
  const value = environment.JARVIS_TELEGRAM_AGENTS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(value)) throw safeFailure();
  return value === 'true';
}

function readLocalFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(65_537);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      length += count;
      if (length > 65_536) throw new Error();
      if (!count) break;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, length),
    );
  } catch {
    throw safeFailure();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Optional server composition. Tests may inject a network port; no env bypass. */
export function createTelegramAgentIntegration(
  config: TelegramAgentsConfig,
  actionKey: string,
  readEnvironment: (variable: string) => string | undefined,
  dependencies: {
    readonly network?: AgentNetworkPolicy;
    readonly ca?: string;
    readonly timeoutMs?: number;
  } = {},
) {
  try {
    if (
      !/^[A-Za-z0-9_-]{43,86}$/.test(actionKey) ||
      Buffer.from(actionKey, 'base64url').length < 32 ||
      Buffer.from(actionKey, 'base64url').toString('base64url') !== actionKey
    )
      throw new Error();
    const catalog = new CapabilitySchemaCatalog([
      { id: 'demo.input.v1', schema: z.strictObject({ text: echoTextSchema }) },
      {
        id: 'demo.output.v1',
        schema: z.strictObject({ text: echoTextSchema }),
      },
    ]);
    const origins = config.allowed_endpoints.map((endpoint) => endpoint.origin);
    const registry = new InMemoryAgentRegistry(config.agents, catalog, origins);
    const network =
      dependencies.network ??
      (config.allowed_endpoints.length
        ? new HttpsEndpointPolicy(
            config.allowed_endpoints.map((endpoint) => ({
              origin: endpoint.origin,
              ...(endpoint.private_addresses
                ? { privateAddresses: endpoint.private_addresses }
                : {}),
            })),
          )
        : {
            async resolve(): Promise<never> {
              throw safeFailure();
            },
          });
    const credentials = new EnvironmentAgentCredentials(
      config.credential_variables,
      (name) => {
        const value = readEnvironment(name);
        // HMAC and agent authentication are separate secrets, even if variables
        // were misconfigured to hold the same value.
        return value === actionKey ? undefined : value;
      },
    );
    const transport = new HttpsAgentTransport(
      registry,
      catalog,
      network,
      credentials,
      {
        ...(dependencies.ca === undefined ? {} : { ca: dependencies.ca }),
        ...(dependencies.timeoutMs === undefined
          ? {}
          : { timeoutMs: dependencies.timeoutMs }),
      },
    );
    const gateway = new InMemoryAgentGateway(registry, catalog, transport, {
      resultCacheMs: config.result_cache_ms,
    });
    const reads = new AgentReadService(
      registry,
      new AgentExecutionService(registry, gateway),
    );
    const commands = createTelegramAgentCommands({
      instanceId: config.instance_id,
      bindings: config.subjects,
      actionKey,
      reads,
    });
    return {
      commands,
      close() {
        gateway.close();
        transport.close();
      },
    };
  } catch {
    throw safeFailure();
  }
}

export function loadTelegramAgentIntegration(
  environment: Environment,
  allowedUserIds: readonly number[],
) {
  if (!telegramAgentsEnabled(environment)) return undefined;
  try {
    const file = environment.JARVIS_AGENTS_CONFIG_FILE;
    const key = environment.JARVIS_TELEGRAM_AGENT_KEY;
    if (!file || !key) throw new Error();
    const path = resolve(file);
    const config = parseTelegramAgentsConfig(
      JSON.parse(readLocalFile(path)),
      allowedUserIds,
    );
    const ca = config.ca_file
      ? readLocalFile(resolve(dirname(path), config.ca_file))
      : undefined;
    return createTelegramAgentIntegration(
      config,
      key,
      (name) => environment[name],
      ca === undefined ? {} : { ca },
    );
  } catch {
    throw safeFailure();
  }
}
