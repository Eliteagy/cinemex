// v0.10: Claude chat panel — CLI argument/env builder, MCP config guard and stream-json parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildClaudeArgs, buildChildEnv, buildMcpConfig, assertEditorOnlyConfig, createStreamParser, toolLabel, createClaudeChat, redact, MISSING_MESSAGE, AUTH_MESSAGE } = require('../electron/claude-chat.cjs');

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const base = { mcpConfigPath: 'C:\\Users\\x\\AppData\\Roaming\\Elite Cinema\\claude-mcp.json', systemPromptPath: 'C:\\Users\\x\\AppData\\Roaming\\Elite Cinema\\claude-chat\\system-prompt.txt', sessionId: SID };
const flag = (args, f) => args[args.indexOf(f) + 1];

test('args: headless stream-json, no built-in tools, only the editor MCP, new vs resumed session', () => {
  const a = buildClaudeArgs({ ...base, resume: false });
  assert.equal(a[0], '-p');
  assert.equal(flag(a, '--output-format'), 'stream-json');
  assert.ok(a.includes('--verbose') && a.includes('--include-partial-messages'));
  assert.equal(flag(a, '--tools'), '');
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--disable-slash-commands'));
  assert.equal(flag(a, '--setting-sources'), '');
  assert.ok(!a.includes('--safe-mode'), '--safe-mode would drop the editor MCP');
  assert.equal(flag(a, '--mcp-config'), base.mcpConfigPath);
  assert.equal(flag(a, '--allowedTools'), 'mcp__elite-cinema__*');
  assert.equal(flag(a, '--permission-mode'), 'dontAsk');
  assert.equal(flag(a, '--session-id'), SID);
  assert.ok(!a.includes('--resume'));
  const r = buildClaudeArgs({ ...base, resume: true });
  assert.equal(flag(r, '--resume'), SID);
  assert.ok(!r.includes('--session-id'));
  // no Bash/Edit/etc anywhere, and nothing with a token
  assert.ok(!a.some((x) => /Bash|Edit|Write|Bearer/i.test(x)));
});

test('args: refuses tools outside the editor, bad session ids and unsafe paths', () => {
  assert.throws(() => buildClaudeArgs({ ...base, resume: false, allowedTools: ['Bash'] }), /ferramentas do editor/);
  assert.throws(() => buildClaudeArgs({ ...base, resume: false, allowedTools: ['mcp__elite-cinema__*', 'Edit'] }), /ferramentas do editor/);
  assert.throws(() => buildClaudeArgs({ ...base, resume: false, allowedTools: ['mcp__other__*'] }), /ferramentas do editor/);
  assert.throws(() => buildClaudeArgs({ ...base, resume: false, sessionId: 'x; rm -rf' }), /Sessão/);
  assert.throws(() => buildClaudeArgs({ ...base, resume: false, mcpConfigPath: 'relative.json' }), /Caminho/);
  assert.throws(() => buildClaudeArgs({ ...base, resume: false, mcpConfigPath: 'C:\\a"&calc.json' }), /Caminho/);
  assert.equal(flag(buildClaudeArgs({ ...base, resume: false, model: 'sonnet' }), '--model'), 'sonnet');
  assert.ok(!buildClaudeArgs({ ...base, resume: false, model: 'x --dangerously' }).includes('--model'));
});

test('env: strips Anthropic overrides and nested Claude Code session variables, keeps the rest', () => {
  const env = buildChildEnv({
    PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\x', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
    ANTHROPIC_API_KEY: 'sk-1', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://proxy', ANTHROPIC_MODEL: 'm',
    anthropic_api_key: 'lower', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 'x', UNDEF: undefined,
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_GIT_BASH_PATH', 'PATH', 'USERPROFILE']);
});

test('mcp config: only the local editor server, token checked; anything else refused', () => {
  const cfg = buildMcpConfig({ url: 'http://127.0.0.1:4545/mcp', token: 'abc123' });
  assert.deepEqual(Object.keys(cfg.mcpServers), ['elite-cinema']);
  assert.equal(cfg.mcpServers['elite-cinema'].type, 'http');
  assert.equal(cfg.mcpServers['elite-cinema'].headers.Authorization, 'Bearer abc123');
  assert.ok(assertEditorOnlyConfig(cfg));
  assert.throws(() => buildMcpConfig({ url: 'http://evil.com/mcp', token: 'abc' }), /local/);
  assert.throws(() => buildMcpConfig({ url: 'http://127.0.0.1:4545/mcp', token: 'a b"' }), /Token/);
  assert.throws(() => assertEditorOnlyConfig({ mcpServers: { ...cfg.mcpServers, fs: { type: 'stdio', command: 'npx' } } }), /recusada/);
  assert.throws(() => assertEditorOnlyConfig({ mcpServers: { 'elite-cinema': { type: 'http', url: 'http://10.0.0.2/mcp' } } }), /local/);
});

test('redact: bearer tokens and long hex secrets never reach the UI', () => {
  assert.equal(redact('Authorization: Bearer 0123abcd'), 'Authorization: Bearer ***');
  assert.equal(redact('token ' + 'a1'.repeat(24)), 'token ***');
});

test('tool labels for the chips', () => {
  assert.deepEqual(toolLabel('mcp__elite-cinema__update_clip', { clip_id: 'c1', volume: 0.15 }), { tool: 'update_clip', area: 'som' });
  assert.deepEqual(toolLabel('mcp__elite-cinema__update_clip', { clip_id: 'c1', style: 'felipe' }), { tool: 'update_clip', area: 'legendas' });
  assert.equal(toolLabel('mcp__elite-cinema__auto_captions').area, 'legendas');
  assert.equal(toolLabel('mcp__elite-cinema__cut_silences').area, 'corte');
  assert.equal(toolLabel('mcp__elite-cinema__set_color').area, 'cor');
  assert.equal(toolLabel('mcp__elite-cinema__export_video').area, 'exportar');
  assert.equal(toolLabel('mcp__elite-cinema__get_project').area, 'projeto');
  assert.equal(toolLabel('mcp__elite-cinema__fusion_add_node').area, 'fusion');
});

// Lines shaped like Claude Code 2.1 `-p --output-format stream-json --verbose --include-partial-messages`.
const L = (o) => JSON.stringify(o) + '\n';
const turn = [
  L({ type: 'system', subtype: 'ui_invalidate', session_id: SID }),
  L({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5', tools: ['mcp__elite-cinema__get_project', 'mcp__elite-cinema__update_clip'], mcp_servers: [{ name: 'elite-cinema', status: 'connected' }] }),
  L({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } }),
  L({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vou ver ' } } }),
  L({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'o projeto.' } } }),
  L({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Vou ver o projeto.' }] } }),
  L({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__elite-cinema__update_clip', input: { clip_id: 'c9', volume: 0.15 } }] } }),
  L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } }),
  L({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2' } } }),
  L({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Música a 15 %.' } } }),
  L({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Música a 15 %.' }] } }),
  L({ type: 'rate_limit_event', rate_limit_info: {} }),
  L({ type: 'result', subtype: 'success', is_error: false, result: 'Música a 15 %.', session_id: SID, total_cost_usd: 0.02, num_turns: 2 }),
].join('');

test('parser: init, streamed text without duplicates, tool chip + result, done', () => {
  const ev = [];
  const p = createStreamParser((e) => ev.push(e));
  // feed in awkward chunks (split inside lines and multibyte text)
  for (let i = 0; i < turn.length; i += 37) p.push(turn.slice(i, i + 37));
  p.end();
  assert.deepEqual(ev[0], { type: 'init', sessionId: SID, model: 'claude-opus-5-5', mcp: 'connected', tools: 2 });
  const text = ev.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text, 'Vou ver o projeto.Música a 15 %.');
  const tool = ev.find((e) => e.type === 'tool');
  assert.equal(tool.tool, 'update_clip');
  assert.equal(tool.area, 'som');
  assert.deepEqual(ev.find((e) => e.type === 'tool_result'), { type: 'tool_result', id: 'tu_1', ok: true });
  const done = ev.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.ok, true);
  assert.equal(done.costUsd, 0.02);
  assert.ok(p.finished);
});

test('parser: non-streamed text, failed tool, garbage lines and subagent events ignored', () => {
  const ev = [];
  const p = createStreamParser((e) => ev.push(e));
  p.push('not json\n{"broken":\n');
  p.push(L({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'Olá' }, { type: 'tool_use', id: 't', name: 'mcp__elite-cinema__export_video', input: {} }] } }));
  p.push(L({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 'sub', content: [{ type: 'text', text: 'subagente' }] } }));
  p.push(L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'Erro' }] } }));
  p.end();
  assert.deepEqual(ev.map((e) => e.type), ['text', 'tool', 'tool_result']);
  assert.equal(ev[0].delta, 'Olá');
  assert.equal(ev[2].ok, false);
});

test('parser: not logged in becomes a clear auth error', () => {
  const ev = [];
  const p = createStreamParser((e) => ev.push(e));
  p.push(L({ type: 'assistant', error: 'authentication_failed', message: { id: 'syn', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }));
  p.push(L({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: SID }));
  const done = ev.at(-1);
  assert.equal(done.ok, false);
  assert.equal(done.code, 'auth');
  assert.equal(done.error, AUTH_MESSAGE);
  assert.match(done.error, /claude/);
});

test('chat manager: CLI missing gives the install message; temp MCP config is removed on cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-chat-'));
  const events = [];
  fs.writeFileSync(path.join(dir, 'claude-mcp.json'), '{"stale":true}');
  const chat = createClaudeChat({ userData: dir, getMcp: () => ({ url: 'http://127.0.0.1:4599/mcp', token: 'abc' }), send: (e) => events.push(e), env: { PATH: dir, APPDATA: dir, USERPROFILE: dir } });
  assert.ok(!fs.existsSync(path.join(dir, 'claude-mcp.json')), 'a stale config from a crash is removed at start');
  assert.equal(chat.status().installed, false);
  {
    chat.sendMessage('proj', 'olá');
    assert.equal(events[0].type, 'done');
    assert.equal(events[0].code, 'missing');
    assert.equal(events[0].error, MISSING_MESSAGE);
  }
  assert.throws(() => chat.sendMessage('proj', '   '), /vazia/);
  fs.writeFileSync(path.join(dir, 'claude-mcp.json'), '{}');
  chat.cleanup();
  assert.ok(!fs.existsSync(path.join(dir, 'claude-mcp.json')));
  assert.ok(chat.reset('proj'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'claude-sessions.json'), 'utf8'));
  assert.match(saved.proj.id, /^[0-9a-f-]{36}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});
