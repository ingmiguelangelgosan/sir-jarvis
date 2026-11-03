import { AgentExecutionService } from '../src/app/agent-execution.ts';
import {
  EnvironmentAgentCredentials,
  type AgentCredentialResolver,
} from '../src/agents/credentials.ts';
import { AgentGatewayError } from '../src/agents/errors.ts';
import {
  InMemoryAgentGateway,
  type GatewayOptions,
} from '../src/agents/gateway.ts';
import {
  HttpsAgentTransport,
  type HttpsAgentTransportOptions,
} from '../src/agents/https-transport.ts';
import type { AgentNetworkPolicy } from '../src/agents/network-policy.ts';
import type { AgentRegistration } from '../src/agents/protocol.ts';
import { InMemoryAgentRegistry } from '../src/agents/registry.ts';
import { registration, schemas } from './agent-runtime.fixtures.ts';
import type { EchoProcess } from './https-process.ts';

/** Test-only exact loopback policy; never included by tsconfig.build.json. */
export function loopbackPolicy(origin: string): AgentNetworkPolicy {
  return {
    async resolve(value, signal) {
      if (signal.aborted) throw new AgentGatewayError('CANCELLED');
      const url = new URL(value);
      if (value !== origin || url.hostname !== 'echo.test')
        throw new AgentGatewayError('FORBIDDEN');
      return {
        origin,
        hostname: 'echo.test',
        port: Number(url.port),
        address: '127.0.0.1',
        family: 4,
      };
    },
  };
}

export function httpsRuntime(
  server: EchoProcess,
  options: {
    readonly registration?: Partial<AgentRegistration>;
    readonly token?: string;
    readonly credentials?: AgentCredentialResolver;
    readonly network?: AgentNetworkPolicy;
    readonly transport?: HttpsAgentTransportOptions;
    readonly gateway?: Partial<GatewayOptions>;
  } = {},
) {
  const catalog = schemas();
  const entry = registration({
    ...options.registration,
    connection: { ...registration().connection, base_url: server.origin },
  });
  const registry = new InMemoryAgentRegistry([entry], catalog, [server.origin]);
  const credentials =
    options.credentials ??
    new EnvironmentAgentCredentials(
      { 'unused-request-reference': 'JARVIS_TEST_BEARER' },
      () => options.token ?? server.token,
    );
  const transport = new HttpsAgentTransport(
    registry,
    catalog,
    options.network ?? loopbackPolicy(server.origin),
    credentials,
    { ca: server.ca, ...options.transport },
  );
  const gateway = new InMemoryAgentGateway(registry, catalog, transport, {
    resultCacheMs: 1000,
    ...options.gateway,
  });
  const core = new AgentExecutionService(registry, gateway);
  return {
    catalog,
    registry,
    transport,
    gateway,
    core,
    close() {
      gateway.close();
      transport.close();
    },
  };
}
