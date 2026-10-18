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

const check = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'visible', node: 'n1', text: null, covers: null, ...overrides });
const response = (checks: readonly unknown[], uncovered: readonly unknown[] = []): Record<string, unknown> => ({ checks, uncovered });

const cases: readonly { readonly name: string; readonly value: unknown; readonly accepted: boolean }[] = [
  { name: 'the valid fixture', value: readJson('fixtures', 'agent-codegen-checks-v1.valid.json'), accepted: true },
  { name: 'the invalid fixture', value: readJson('fixtures', 'agent-codegen-checks-v1.invalid.json'), accepted: false },
  { name: 'no checks', value: response([]), accepted: true },
  { name: 'six checks', value: response(Array.from({ length: 6 }, () => check())), accepted: true },
  { name: 'seven checks', value: response(Array.from({ length: 7 }, () => check())), accepted: false },
  { name: 'the first six kinds', value: response(['visible', 'text', 'value', 'checked', 'unchecked', 'enabled'].map((kind) => check({ kind }))), accepted: true },
  { name: 'the other kinds', value: response(['disabled', 'count', 'order', 'absent', 'gone', 'url'].map((kind) => check({ kind }))), accepted: true },
  { name: 'an empty text', value: response([check({ kind: 'value', text: '' })]), accepted: true },
  { name: 'a kind outside the enum', value: response([check({ kind: 'screenshot' })]), accepted: false },
  { name: 'a missing text', value: response([{ kind: 'visible', node: 'n1', covers: null }]), accepted: false },
  { name: 'a missing node', value: response([{ kind: 'url', text: '/a', covers: null }]), accepted: false },
  { name: 'a missing covers', value: response([{ kind: 'visible', node: 'n1', text: null }]), accepted: false },
  { name: 'a covers', value: response([check({ covers: 'the form is saved' })]), accepted: true },
  { name: 'a covers of 201 characters', value: response([check({ covers: 'x'.repeat(201) })]), accepted: false },
  { name: 'an extra key on a check', value: response([check({ why: 'because' })]), accepted: false },
  { name: 'an extra key on the response', value: { checks: [], uncovered: [], explanation: 'x' }, accepted: false },
  { name: 'a missing uncovered', value: { checks: [] }, accepted: false },
  { name: 'uncovered parts', value: response([], ['the save is quick', '']), accepted: true },
  { name: 'seven uncovered parts', value: response([], Array.from({ length: 7 }, () => 'x')), accepted: false },
  { name: 'an uncovered part that is not a string', value: response([], [3]), accepted: false },
  { name: 'a numeric node', value: response([check({ node: 12 })]), accepted: false },
  { name: 'a node id of 33 characters', value: response([check({ node: 'n'.repeat(33) })]), accepted: false },
  { name: 'a text of 200 characters', value: response([check({ kind: 'text', text: 'x'.repeat(200) })]), accepted: true },
  { name: 'a text of 201 characters', value: response([check({ kind: 'text', text: 'x'.repeat(201) })]), accepted: false },
  { name: 'checks that are not an array', value: { checks: {}, uncovered: [] }, accepted: false },
  { name: 'an array response', value: [], accepted: false },
];

describe('agent-codegen-checks-1', () => {
  it.each(cases)('$name: the runtime, the wire schema, and the provider schema agree', ({ value, accepted }) => {
    expect(validateChecksResponse(value).ok).toBe(accepted);
    expect(wireSchema(value)).toBe(accepted);
    expect(providerSchema(value)).toBe(accepted);
  });
});
