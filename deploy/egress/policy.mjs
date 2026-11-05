import { createHash } from 'node:crypto';
import { isIP, BlockList } from 'node:net';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SUBNET = '172.30.78.0/28';
export const BOT_IP = '172.30.78.2';
export const DNS_SERVER = '172.26.0.2';
export const HOSTNAME = 'api.telegram.org';
export const SET_HOST = 'JRV1G_TG4';
export const SET_NS = 'JRV1G_NS_TG4';
export const CHAIN_HOST = 'JRV1G_EGRESS';
export const CHAIN_NS4 = 'JRV1G_NS4';
export const CHAIN_NS6 = 'JRV1G_NS6';
export const MAX_LEASE_MS = 900_000;
const blocked = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked.addSubnet(ip, bits, 'ipv4');
const fail = () =>
  new Error('Egress policy rejected. Deployment remains blocked.');

export function publicAddresses(values) {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 8 ||
    new Set(values).size !== values.length ||
    values.some(
      (ip) =>
        typeof ip !== 'string' || isIP(ip) !== 4 || blocked.check(ip, 'ipv4'),
    )
  )
    throw fail();
  return [...values].sort();
}
export function validatePolicy(input, now = Date.now()) {
  const keys = [
    'version',
    'hostname',
    'resolver',
    'addresses',
    'createdAt',
    'expiresAt',
  ];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    input.version !== 1 ||
    input.hostname !== HOSTNAME ||
    input.resolver !== DNS_SERVER ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.createdAt < 0 ||
    input.createdAt > now ||
    input.expiresAt <= now ||
    input.expiresAt - input.createdAt > MAX_LEASE_MS ||
    input.expiresAt <= input.createdAt
  )
    throw fail();
  return Object.freeze({
    ...input,
    addresses: Object.freeze(publicAddresses(input.addresses)),
  });
}
export function policyHash(policy) {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

/** Private-chain restore transactions only. Callers add scoped hooks separately. */
export function firewallRules(addresses) {
  publicAddresses(addresses);
  return {
    host: `*filter\n:${CHAIN_HOST} - [0:0]\n-F ${CHAIN_HOST}\n-A ${CHAIN_HOST} -s ${BOT_IP}/32 -p tcp --dport 443 -m set --match-set ${SET_HOST} dst -j ACCEPT\n-A ${CHAIN_HOST} -j DROP\nCOMMIT\n`,
    namespace4: `*raw\n:${CHAIN_NS4} - [0:0]\n-F ${CHAIN_NS4}\n-A ${CHAIN_NS4} -p tcp --dport 443 -m set --match-set ${SET_NS} dst -j RETURN\n-A ${CHAIN_NS4} -j DROP\nCOMMIT\n`,
    namespace6: `*raw\n:${CHAIN_NS6} - [0:0]\n-F ${CHAIN_NS6}\n-A ${CHAIN_NS6} -j DROP\nCOMMIT\n`,
    sets: { host: SET_HOST, namespace: SET_NS },
  };
}
export function denyRules() {
  return `*filter\n:${CHAIN_HOST} - [0:0]\n-F ${CHAIN_HOST}\n-A ${CHAIN_HOST} -j DROP\nCOMMIT\n`;
}

export function composeOverride(policy, releaseDirectory, publicDirectory) {
  const p = validatePolicy(policy);
  return {
    services: {
      jarvis: {
        restart: 'no',
        dns: ['127.0.0.1'],
        extra_hosts: [`${HOSTNAME}=${p.addresses[0]}`],
        command: ['node', '/egress/gate.mjs'],
        volumes: [
          {
            type: 'bind',
            source: `${releaseDirectory}/deploy/egress/gate.mjs`,
            target: '/egress/gate.mjs',
            read_only: true,
          },
          {
            type: 'bind',
            source: publicDirectory,
            target: '/run/jarvis-egress',
            read_only: true,
          },
        ],
      },
    },
  };
}
export function validatePermit(value, challenge, now = Date.now()) {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !value ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt < 0 ||
    value.expiresAt <= value.issuedAt
  )
    throw fail();
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !==
      'challenge,expiresAt,issuedAt,policyHash' ||
    value.challenge !== challenge ||
    typeof challenge !== 'string' ||
    !/^[a-f0-9]{64}$/.test(challenge) ||
    !/^[a-f0-9]{64}$/.test(value.policyHash) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.issuedAt > now ||
    value.expiresAt <= now ||
    value.expiresAt - value.issuedAt > MAX_LEASE_MS
  )
    throw fail();
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv[2] !== 'rules') throw fail();
    process.stdout.write(
      `${JSON.stringify(firewallRules(process.argv.slice(3)))}\n`,
    );
  } catch {
    process.stderr.write(`${fail().message}\n`);
    process.exitCode = 1;
  }
}
