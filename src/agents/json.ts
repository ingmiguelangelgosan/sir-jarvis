import { createHash } from 'node:crypto';

import { AgentGatewayError } from './errors.ts';
import type {
  AgentExecutionRequest,
  JsonObject,
  JsonValue,
} from './protocol.ts';

/** JSON acotado, sin getters/toJSON/ciclos ni coerciones. Devuelve copia inmutable. */
export function jsonSnapshot(value: unknown): JsonValue {
  let nodes = 0;
  let bytes = 0;
  function count(text: string): void {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 65_536) throw new AgentGatewayError('VALIDATION_FAILED');
  }
  function visit(item: unknown, depth: number): JsonValue {
    nodes += 1;
    if (depth > 32 || nodes > 8192)
      throw new AgentGatewayError('VALIDATION_FAILED');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      count(item);
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item))
      return Object.is(item, -0) ? 0 : item;
    if (typeof item !== 'object' || item === null)
      throw new AgentGatewayError('VALIDATION_FAILED');
    const prototype: unknown = Object.getPrototypeOf(item);
    if (Array.isArray(item)) {
      if (
        prototype !== Array.prototype ||
        item.length > 8192 ||
        Reflect.ownKeys(item).length !== item.length + 1
      ) {
        throw new AgentGatewayError('VALIDATION_FAILED');
      }
      const values: JsonValue[] = [];
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !('value' in descriptor))
          throw new AgentGatewayError('VALIDATION_FAILED');
        values.push(visit(descriptor.value, depth + 1));
      }
      return Object.freeze(values);
    }
    if (prototype !== Object.prototype && prototype !== null)
      throw new AgentGatewayError('VALIDATION_FAILED');
    const entries: [string, JsonValue][] = [];
    for (const key of Reflect.ownKeys(item).sort()) {
      if (
        typeof key !== 'string' ||
        ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)
      ) {
        throw new AgentGatewayError('VALIDATION_FAILED');
      }
      count(key);
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        throw new AgentGatewayError('VALIDATION_FAILED');
      entries.push([key, visit(descriptor.value, depth + 1)]);
    }
    return Object.freeze(Object.fromEntries(entries));
  }
  try {
    const snapshot = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 65_536)
      throw new AgentGatewayError('VALIDATION_FAILED');
    return snapshot;
  } catch {
    throw new AgentGatewayError('VALIDATION_FAILED');
  }
}

export function jsonObjectSnapshot(value: unknown): JsonObject {
  const snapshot = jsonSnapshot(value);
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot)
  )
    throw new AgentGatewayError('VALIDATION_FAILED');
  return snapshot as JsonObject;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonSnapshot(value));
}

export function commandFingerprint(request: AgentExecutionRequest): string {
  const stableCommand = Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== 'deadline_at'),
  );
  return createHash('sha256')
    .update(canonicalJson(stableCommand))
    .digest('hex');
}

export function executionKey(request: AgentExecutionRequest): string {
  return JSON.stringify([
    request.instance_id,
    request.subject_ref,
    request.agent_id,
    request.capability.name,
    request.capability.version,
    request.idempotency_key,
  ]);
}
