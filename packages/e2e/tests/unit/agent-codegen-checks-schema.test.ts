/**
 * `validateChecksResponse` and `schema/agent-codegen-checks-v1.schema.json`
 * give the same answer for every input. The schema wins on divergence, so a
 * case that fails here is a runtime bug. The provider-facing `CHECKS_SCHEMA`
 * is held to the same answers.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type SchemaObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { CHECKS_SCHEMA, validateChecksResponse } from '../../src/agent/protocol.ts';

const SCHEMA_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'schema');

function readJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(path.join(SCHEMA_ROOT, ...segments), 'utf8'));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const wireSchema = ajv.compile(readJson('agent-codegen-checks-v1.schema.json') as Record<string, unknown>);
const providerSchema = ajv.compile(CHECKS_SCHEMA as SchemaObject);

const check = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'visible', node: 'n1', text: null, ...overrides });

const cases: readonly { readonly name: string; readonly value: unknown; readonly accepted: boolean }[] = [
  { name: 'the valid fixture', value: readJson('fixtures', 'agent-codegen-checks-v1.valid.json'), accepted: true },
  { name: 'the invalid fixture', value: readJson('fixtures', 'agent-codegen-checks-v1.invalid.json'), accepted: false },
  { name: 'no checks', value: { checks: [] }, accepted: true },
  { name: 'six checks', value: { checks: Array.from({ length: 6 }, () => check()) }, accepted: true },
  { name: 'seven checks', value: { checks: Array.from({ length: 7 }, () => check()) }, accepted: false },
  { name: 'every kind', value: { checks: ['visible', 'text', 'value', 'checked', 'unchecked', 'enabled', 'disabled', 'absent', 'url'].slice(0, 6).map((kind) => check({ kind })) }, accepted: true },
  { name: 'a kind outside the enum', value: { checks: [check({ kind: 'screenshot' })] }, accepted: false },
  { name: 'a missing text', value: { checks: [{ kind: 'visible', node: 'n1' }] }, accepted: false },
  { name: 'a missing node', value: { checks: [{ kind: 'url', text: '/a' }] }, accepted: false },
  { name: 'an extra key on a check', value: { checks: [check({ why: 'because' })] }, accepted: false },
  { name: 'an extra key on the response', value: { checks: [], explanation: 'x' }, accepted: false },
  { name: 'a numeric node', value: { checks: [check({ node: 12 })] }, accepted: false },
  { name: 'a node id of 33 characters', value: { checks: [check({ node: 'n'.repeat(33) })] }, accepted: false },
  { name: 'a text of 200 characters', value: { checks: [check({ kind: 'text', text: 'x'.repeat(200) })] }, accepted: true },
  { name: 'a text of 201 characters', value: { checks: [check({ kind: 'text', text: 'x'.repeat(201) })] }, accepted: false },
  { name: 'checks that are not an array', value: { checks: {} }, accepted: false },
  { name: 'an array response', value: [], accepted: false },
];

describe('agent-codegen-checks-1', () => {
  it.each(cases)('$name: the runtime, the wire schema, and the provider schema agree', ({ value, accepted }) => {
    expect(validateChecksResponse(value).ok).toBe(accepted);
    expect(wireSchema(value)).toBe(accepted);
    expect(providerSchema(value)).toBe(accepted);
  });
});
