// GPT (Codex) and Gemini in the chat panel: arguments, event parsing and the Gemini tool loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildCodexArgs, createCodexParser, cleanSchema, geminiTools, createGeminiChat } = require('../electron/ai-providers.cjs');

test('codex args: only the local editor MCP, token by env var, resume by thread id', () => {
  const a = buildCodexArgs({ url: 'http://127.0.0.1:4545/mcp' });
  assert.deepEqual(a.slice(0, 2), ['exec', '--json']);
  assert.ok(a.includes('mcp_servers.elite.bearer_token_env_var="ELITE_MCP_TOKEN"'));
  assert.ok(!a.join(' ').match(/[a-f0-9]{40}/), 'no token in argv');
  assert.equal(a[a.length - 1], '-', 'prompt from stdin');
  const r = buildCodexArgs({ url: 'http://127.0.0.1:4545/mcp', threadId: '01a1c0d8-22fd-72f3-a75e-a954042de1a2' });
  assert.deepEqual(r.slice(0, 2), ['exec', 'resume']);
  assert.throws(() => buildCodexArgs({ url: 'http://evil.example/mcp' }));
  assert.throws(() => buildCodexArgs({ url: 'http://127.0.0.1:4545/mcp', threadId: 'x; rm -rf' }));
});

test('codex --json lines become panel events', () => {
  const ev = [];
  const p = createCodexParser((e) => ev.push(e));
  p.push('{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"Vou ver."}}\n');
  p.push('{"type":"item.started","item":{"id":"i1","type":"mcp_tool_call","server":"elite","tool":"set_color","arguments":{"look":"cinema"}}}\n');
  p.push('{"type":"item.completed","item":{"id":"i1","type":"mcp_tool_call","tool":"set_color","status":"completed","error":null}}\n{"type":"turn.completed"}\n');
  assert.deepEqual(ev.map((e) => e.type), ['init', 'text', 'tool', 'tool_result', 'done']);
  assert.equal(ev[2].area, 'cor');
  assert.equal(ev[3].ok, true);
  assert.equal(ev[4].ok, true);
});

test('gemini schemas: one type per field', () => {
  const s = cleanSchema({ type: 'object', properties: { keyword: { type: ['number', 'null'], description: 'x' }, list: { type: 'array' } }, required: ['keyword'] });
  assert.equal(s.properties.keyword.type, 'number');
  assert.deepEqual(s.properties.list.items, { type: 'string' });
  const tools = geminiTools();
  assert.ok(tools.length > 40);
  assert.ok(tools.every((t) => !JSON.stringify(t.function.parameters).includes('"type":[')), 'no type arrays left');
});

test('gemini tool loop: asks for a tool, the editor runs it, then answers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ec-gem-'));
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(home, '.claude-omniroute'));
  writeFileSync(join(home, '.claude-omniroute', 'omniroute.key'), 'k');
  const replies = [
    { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_project', arguments: '{}' } }] } }] },
    { choices: [{ message: { content: 'O projeto tem 63 s.' } }] },
  ];
  const sent = [];
  const calls = [];
  const chat = createGeminiChat({
    env: { USERPROFILE: home },
    fetch: async (_u, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => replies.shift() };
    },
    callTool: async (name, args) => (calls.push([name, args]), { duration: 63 }),
    send: (e) => events.push(e),
  });
  const events = [];
  chat.sendMessage('proj', 'Quanto dura?');
  for (let i = 0; i < 50 && !events.some((e) => e.type === 'exit'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, [['get_project', {}]]);
  assert.deepEqual(events.map((e) => e.type), ['init', 'tool', 'tool_result', 'text', 'done', 'exit']);
  assert.equal(sent[1].messages.at(-1).role, 'tool', 'the tool result goes back to the model');
  assert.match(events.find((e) => e.type === 'text').delta, /63 s/);
});
