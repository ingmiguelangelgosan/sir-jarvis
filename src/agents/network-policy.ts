import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { AgentGatewayError } from './errors.ts';

export interface ResolvedAgentEndpoint {
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly address: string;
  readonly family: 4 | 6;
}

/** Trusted local infrastructure port. Production uses HttpsEndpointPolicy. */
export interface AgentNetworkPolicy {
  resolve(origin: string, signal: AbortSignal): Promise<ResolvedAgentEndpoint>;
}

export interface AgentEndpointRule {
  readonly origin: string;
  /** Exact RFC1918/ULA destinations administered by the operator, never ranges. */
  readonly privateAddresses?: readonly string[];
}

export type AgentDnsResolver = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

function subnetList(subnets: readonly [string, number][]): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of subnets)
    list.addSubnet(address, prefix, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  return list;
}

const privateV4 = subnetList([
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
]);
const privateV6 = subnetList([['fc00::', 7]]);
const metadataV6 = subnetList([
  ['fd00:ec2::', 32],
  ['fd20:ce::254', 128],
]);
const publicV6 = subnetList([['2000::', 3]]);
const excludedV4 = subnetList([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['168.63.129.16', 32],
]);
const excludedV6 = subnetList([
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
]);

export function sameIpAddress(left: string, right: string): boolean {
  const family = isIP(left);
  if (!family || family !== isIP(right)) return false;
  const list = new BlockList();
  const type = family === 4 ? 'ipv4' : 'ipv6';
  list.addAddress(left, type);
  return list.check(right, type);
}

function isPrivate(address: string): boolean {
  return isIP(address) === 4
    ? privateV4.check(address, 'ipv4')
    : isIP(address) === 6 && privateV6.check(address, 'ipv6');
}

function publicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  return isIP(address) === 4
    ? !excludedV4.check(address, 'ipv4')
    : isIP(address) === 6 &&
        publicV6.check(address, 'ipv6') &&
        !excludedV6.check(address, 'ipv6');
}

export function parseHttpsOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      value.includes('?') ||
      value.includes('#') ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.hostname.endsWith('.') ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') ||
      ['metadata.google.internal', 'instance-data.ec2.internal'].includes(
        url.hostname,
      )
    )
      throw new Error();
    return url;
  } catch {
    throw new AgentGatewayError('INVALID_CONFIGURATION');
  }
}

/** No DNS cache or redirects: validate every answer and pin one address per call. */
export class HttpsEndpointPolicy implements AgentNetworkPolicy {
  readonly #rules = new Map<string, readonly string[]>();
  readonly #lookup: AgentDnsResolver;

  constructor(
    rules: readonly AgentEndpointRule[],
    resolver: AgentDnsResolver = (hostname) =>
      lookup(hostname, { all: true, verbatim: true }),
  ) {
    try {
      if (!rules.length || rules.length > 256) throw new Error();
      for (const rule of rules) {
        const origin = parseHttpsOrigin(rule.origin).origin;
        if (
          this.#rules.has(origin) ||
          (rule.privateAddresses?.length ?? 0) > 64
        )
          throw new Error();
        const addresses = [...(rule.privateAddresses ?? [])];
        if (
          addresses.some(
            (address) =>
              !isPrivate(address) ||
              address.includes('%') ||
              (isIP(address) === 6 && metadataV6.check(address, 'ipv6')),
          )
        )
          throw new Error();
        this.#rules.set(origin, Object.freeze(addresses));
      }
      this.#lookup = resolver;
    } catch {
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    }
  }

  async resolve(
    value: string,
    signal: AbortSignal,
  ): Promise<ResolvedAgentEndpoint> {
    try {
      if (signal.aborted) throw new AgentGatewayError('CANCELLED');
      const url = parseHttpsOrigin(value);
      const privateAddresses = this.#rules.get(url.origin);
      if (!privateAddresses) throw new AgentGatewayError('FORBIDDEN');
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const family = isIP(hostname);
      const answers = family
        ? [{ address: hostname, family }]
        : await this.#lookup(hostname);
      if (signal.aborted) throw new AgentGatewayError('CANCELLED');
      if (
        !answers.length ||
        answers.length > 64 ||
        answers.some(
          (answer) =>
            ![4, 6].includes(answer.family) ||
            isIP(answer.address) !== answer.family ||
            (!publicAddress(answer.address) &&
              !privateAddresses.some((entry) =>
                sameIpAddress(entry, answer.address),
              )),
        )
      )
        throw new AgentGatewayError('FORBIDDEN');
      const first = answers[0]!;
      return Object.freeze({
        origin: url.origin,
        hostname,
        port: Number(url.port || 443),
        address: first.address,
        family: first.family as 4 | 6,
      });
    } catch (error) {
      if (error instanceof AgentGatewayError) throw error;
      throw new AgentGatewayError('UNAVAILABLE');
    }
  }
}
