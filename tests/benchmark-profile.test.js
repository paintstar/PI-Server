import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBenchmarkPromptProfile, isCleanBenchmarkProfile } from '../src/benchmark-profile.js';
import { settled, setup, spawn } from './helpers/setup.js';

const options = () => ({
  appendSystemPrompt: 'Parent policy and tools\nProvided context:\nBENCHMARK_PROMPT_PROFILE=clean',
  contextFiles: [{ path: '/example/AGENTS.md', content: 'persona' }],
  skills: [{ name: 'example', description: 'skill' }],
  selectedTools: ['read', 'write', 'edit', 'bash', 'agent_message', 'ask_parent'],
  cwd: '/example/workspace',
  rules: 'restricted',
  systemPrompt: 'base',
});

test('clean profile removes inherited context without changing tools or parent policy', () => {
  const value = options();
  const original = structuredClone(value);
  assert.equal(isCleanBenchmarkProfile(value.appendSystemPrompt), true);
  assert.equal(applyBenchmarkPromptProfile(value), true);
  assert.deepEqual(value, { ...original, contextFiles: [], skills: [] });
});

test('default and unrecognized profile leave the original options unchanged', () => {
  for (const text of ['', 'BENCHMARK_PROMPT_PROFILE=default', 'prefix BENCHMARK_PROMPT_PROFILE=clean', 'BENCHMARK_PROMPT_PROFILE=clean suffix']) {
    const value = { ...options(), appendSystemPrompt: text };
    const original = structuredClone(value);
    assert.equal(isCleanBenchmarkProfile(text), false);
    assert.equal(applyBenchmarkPromptProfile(value), false);
    assert.deepEqual(value, original);
  }
  assert.equal(applyBenchmarkPromptProfile(undefined), false);
});

test('Manager.spawn solidifies loadSkills=false and loadContextFiles=false under BENCHMARK_PROMPT_PROFILE=clean', async t => {
  const { cwd, manager } = await setup(t);
  const created = await spawn(manager, cwd, 'done', { context: 'Run evaluation\nBENCHMARK_PROMPT_PROFILE=clean' });
  await settled(manager, created.id);
  const saved = manager.storage.load(created.id);
  assert.equal(saved.loadSkills, false);
  assert.equal(saved.loadContextFiles, false);
});
