// GPT and Gemini in the chat panel, next to Claude. Both drive the editor through the same tools as
// Claude (the editor's MCP tools) and send the same events to the panel:
//   init, text, tool, tool_result, done, exit   (see claude-chat.cjs createStreamParser)
//
// GPT    = the locally installed OpenAI Codex CLI (the user's own ChatGPT login), `codex exec --json`,
//          with ONE MCP server: the editor's (127.0.0.1). The bearer token goes through an environment
//          variable of the child only (bearer_token_env_var), never argv. Read-only sandbox, empty cwd.
// Gemini = Gemini 2.5 Flash through the local OmniRoute gateway (OpenAI-compatible API, key in
//          ~/.claude-omniroute/omniroute.key). The tool loop runs here: the model asks for a tool, the
//          editor runs it (callTool), the result goes back, until the model answers in text.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toolLabel, redact, SYSTEM_PROMPT } = require('./claude-chat.cjs');
const { TOOLS } = require('./mcp.cjs');

const PROMPT_FOR = (who) => SYSTEM_PROMPT.replace(/mcp__cinemex__\*/g, 'do editor (servidor cinemex)').replace('És o assistente do Cinemex', `És o assistente do Cinemex (${who})`);

// ------------------------------------------------------------------ GPT (Codex CLI)
/** codex.exe of the npm package (spawned directly: no cmd.exe quoting), or null. */
function findCodex(env = process.env) {
  const npm = env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex') : null;
  const cands = [];
  if (npm) cands.push(path.join(npm, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) cands.push(path.join(d, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  for (const f of cands) {
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

/** Arguments for one Codex turn: static flags, the local MCP url and an optional thread id. */
function buildCodexArgs({ url, threadId }) {
  const u = new URL(url);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('O MCP do editor tem de ser local (127.0.0.1)');
  if (threadId && !/^[0-9a-f-]{8,64}$/i.test(threadId)) throw new Error('Sessão inválida');
  const cfg = [
    '-c', `mcp_servers.elite.url="${u.toString()}"`,
    '-c', 'mcp_servers.elite.bearer_token_env_var="ELITE_MCP_TOKEN"',
    '-c', 'mcp_servers.elite.default_tools_approval_mode="approve"',
  ];
  const base = ['--json', '--skip-git-repo-check', '-s', 'read-only', ...cfg];
  return threadId ? ['exec', 'resume', ...base, threadId, '-'] : ['exec', ...base, '-'];
}

/** Codex --json lines -> panel events. */
function createCodexParser(emit) {
  let buf = '';
  let sawText = false;
  let finished = false;
  const onLine = (line) => {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (!d || typeof d !== 'object') return;
    if (d.type === 'thread.started') emit({ type: 'init', sessionId: d.thread_id, model: 'GPT (Codex)', mcp: 'connected', tools: TOOLS.length });
    const it = d.item;
    if (it && it.type === 'agent_message' && d.type === 'item.completed' && it.text) {
      emit({ type: 'text', delta: (sawText ? '\n\n' : '') + it.text.trim(), messageId: it.id });
      sawText = true;
    }
    if (it && it.type === 'mcp_tool_call') {
      if (d.type === 'item.started') {
        const { tool, area } = toolLabel(`mcp__cinemex__${it.tool}`, it.arguments);
        emit({ type: 'tool', id: it.id, name: it.tool, tool, area, input: it.arguments || {} });
      } else if (d.type === 'item.completed') emit({ type: 'tool_result', id: it.id, ok: !it.error && it.status !== 'failed' });
    }
    if (d.type === 'turn.completed') {
      finished = true;
      emit({ type: 'done', ok: true, sawText });
    }
    if (d.type === 'turn.failed' || d.type === 'error') {
      finished = true;
      const msg = d.error?.message || d.message || 'O GPT devolveu um erro';
      emit({ type: 'done', ok: false, code: /login|auth|401/i.test(msg) ? 'auth' : 'error', error: /login|auth|401/i.test(msg) ? GPT_AUTH : redact(msg) });
    }
  };
  return {
    push(c) {
      buf += String(c);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) onLine(l);
      }
    },
    end() {
      if (buf.trim()) onLine(buf.trim());
      buf = '';
    },
    get finished() {
      return finished;
    },
  };
}
const GPT_MISSING = 'Não encontrei o Codex (GPT) neste PC. Instala com: npm i -g @openai/codex e faz login uma vez com codex login.';
const GPT_AUTH = 'O Codex não tem sessão iniciada. Abre um terminal, escreve codex login e entra com a conta ChatGPT; depois volta aqui.';

function createGptChat(o) {
  const dir = path.join(o.userData, 'gpt-chat');
  const sessFile = path.join(o.userData, 'gpt-sessions.json');
  let sessions = {};
  try {
    sessions = JSON.parse(fs.readFileSync(sessFile, 'utf8')) || {};
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(sessFile, JSON.stringify(sessions, null, 1));
    } catch {}
  };
  const keyOf = (k) => String(k || 'sem-projeto').slice(0, 500).toLowerCase();
  let child = null;
  let runId = 0;
  function sendMessage(projectKey, text) {
    const prompt = String(text || '').trim().slice(0, 20000);
    if (!prompt) throw new Error('Mensagem vazia');
    if (child) throw new Error('O GPT ainda está a responder');
    const id = ++runId;
    const emit = (ev) => o.send({ runId: id, ...ev });
    const bin = findCodex(o.env || process.env);
    if (!bin) {
      emit({ type: 'done', ok: false, code: 'missing', error: GPT_MISSING });
      emit({ type: 'exit' });
      return { runId: id };
    }
    const m = o.getMcp();
    if (!m || !m.url) throw new Error('O servidor MCP do editor não está ligado. Reinicia o Cinemex.');
    fs.mkdirSync(dir, { recursive: true });
    const key = keyOf(projectKey);
    const threadId = sessions[key] || null;
    const args = buildCodexArgs({ url: m.url, threadId });
    const env = { ...(o.env || process.env), ELITE_MCP_TOKEN: m.token };
    const p = spawn(bin, args, { cwd: dir, env, windowsHide: true });
    child = p;
    let done = false;
    let stderr = '';
    const parser = createCodexParser((ev) => {
      if (ev.type === 'init' && ev.sessionId) {
        sessions[key] = ev.sessionId;
        save();
      }
      if (ev.type === 'done') {
        if (done) return;
        done = true;
      }
      emit(ev);
    });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => parser.push(c));
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c) => (stderr = (stderr + c).slice(-4000)));
    p.on('error', (e) => {
      if (!done) {
        done = true;
        emit({ type: 'done', ok: false, code: 'missing', error: e.code === 'ENOENT' ? GPT_MISSING : e.message });
      }
    });
    p.on('close', (code) => {
      parser.end();
      if (child === p) child = null;
      if (!done) {
        done = true;
        if (p.killedByUser) emit({ type: 'done', ok: false, code: 'cancelled', error: 'Parado.' });
        else if (/login|not logged|401|unauthorized/i.test(stderr)) emit({ type: 'done', ok: false, code: 'auth', error: GPT_AUTH });
        else emit({ type: 'done', ok: false, code: 'error', error: `O GPT terminou sem resposta (código ${code}). ${redact(stderr.trim()).slice(-300)}` });
      }
      emit({ type: 'exit' });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(threadId ? prompt : `${PROMPT_FOR('GPT')}\n\nPedido do Gui:\n${prompt}`, 'utf8');
    return { runId: id };
  }
  function cancel() {
    if (!child) return false;
    child.killedByUser = true;
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).on('error', () => {});
    else child.kill();
    return true;
  }
  return {
    sendMessage,
    cancel,
    reset(projectKey) {
      cancel();
      delete sessions[keyOf(projectKey)];
      save();
      return true;
    },
    status: () => ({ installed: Boolean(findCodex(o.env || process.env)), running: Boolean(child) }),
    cleanup: cancel,
  };
}

// ------------------------------------------------------------------ Gemini (OmniRoute + tool loop)
const GEMINI_URL = 'http://127.0.0.1:20128/v1/chat/completions';
// Gemini 2.5 Flash returns empty answers through OmniRoute once it must call one of many tools;
// Gemini 3 Flash handles the full tool list. The others are fallbacks when a model is unavailable.
const GEMINI_MODELS = ['gemini/gemini-3-flash-preview', 'gemini/gemini-flash-latest', 'gemini/gemini-2.5-flash'];
const GEMINI_MISSING = 'O Gemini usa o OmniRoute neste PC (127.0.0.1:20128) e a chave em ~/.claude-omniroute/omniroute.key. Liga o OmniRoute e tenta outra vez.';

/** JSON schema the Gemini function-calling API accepts (one type per field, no nulls). */
function cleanSchema(s) {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(cleanSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && Array.isArray(v)) out.type = v.find((t) => t !== 'null') || 'string';
    else if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, cleanSchema(pv)]));
    else if (['type', 'description', 'items', 'required', 'enum'].includes(k)) out[k] = cleanSchema(v);
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  if (out.type === 'array' && !out.items) out.items = { type: 'string' };
  return out;
}
const geminiTools = () => TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description.slice(0, 1000), parameters: cleanSchema(t.inputSchema) } }));

function geminiKey(env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  try {
    return fs.readFileSync(path.join(home, '.claude-omniroute', 'omniroute.key'), 'utf8').trim();
  } catch {
    return null;
  }
}

function createGeminiChat(o) {
  const threads = new Map(); // project key -> messages (system + history)
  let ctl = null;
  let runId = 0;
  const keyOf = (k) => String(k || 'sem-projeto').slice(0, 500).toLowerCase();
  const fetchFn = o.fetch || fetch;
  async function run(id, key, prompt) {
    const emit = (ev) => o.send({ runId: id, ...ev });
    const apiKey = geminiKey(o.env || process.env);
    if (!apiKey) {
      emit({ type: 'done', ok: false, code: 'missing', error: GEMINI_MISSING });
      return;
    }
    const msgs = threads.get(key) || [{ role: 'system', content: PROMPT_FOR('Gemini') }];
    msgs.push({ role: 'user', content: prompt });
    threads.set(key, msgs);
    emit({ type: 'init', sessionId: key, model: 'Gemini 3 Flash', mcp: 'connected', tools: TOOLS.length });
    const tools = geminiTools();
    let sawText = false;
    for (let step = 0; step < 16; step++) {
      let r;
      try {
        let lastErr = null;
        for (const model of GEMINI_MODELS) {
          const res = await fetchFn(GEMINI_URL, {
            method: 'POST',
            signal: ctl.signal,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: msgs, tools }),
          });
          r = await res.json();
          if (res.ok && !r.error) break;
          lastErr = new Error(r.error?.message || r.error || `HTTP ${res.status}`);
          // Only model problems move on to the next model; auth and quota errors stop here.
          if (![404, 502, 503].includes(res.status)) throw lastErr;
          r = null;
        }
        if (!r) throw lastErr;
      } catch (e) {
        if (ctl.signal.aborted) return emit({ type: 'done', ok: false, code: 'cancelled', error: 'Parado.' });
        const msg = String(e.message || e);
        return emit({ type: 'done', ok: false, code: /ECONNREFUSED|fetch failed/i.test(msg) ? 'missing' : 'error', error: /ECONNREFUSED|fetch failed/i.test(msg) ? GEMINI_MISSING : `Gemini: ${redact(msg).slice(0, 300)}` });
      }
      const m = r.choices?.[0]?.message || {};
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      // Keep the whole message: Gemini 3 needs the thought signatures OmniRoute stores on it.
      msgs.push({ ...m, role: 'assistant', content: m.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
      if (m.content && String(m.content).trim()) {
        emit({ type: 'text', delta: (sawText ? '\n\n' : '') + String(m.content).trim(), messageId: `g${step}` });
        sawText = true;
      }
      if (!calls.length) return emit({ type: 'done', ok: true, sawText });
      for (const c of calls) {
        const name = c.function?.name || '';
        let args = {};
        try {
          args = JSON.parse(c.function?.arguments || '{}') || {};
        } catch {}
        const { tool, area } = toolLabel(`mcp__cinemex__${name}`, args);
        emit({ type: 'tool', id: c.id, name, tool, area, input: args });
        let content;
        let ok = true;
        if (!TOOLS.some((t) => t.name === name)) {
          ok = false;
          content = `Ferramenta desconhecida: ${name}`;
        } else {
          try {
            const out = await o.callTool(name, args);
            content = JSON.stringify(out ?? { ok: true }).slice(0, 20000);
          } catch (e) {
            ok = false;
            content = `Erro: ${e.message || e}`;
          }
        }
        emit({ type: 'tool_result', id: c.id, ok });
        msgs.push({ role: 'tool', tool_call_id: c.id, content });
        if (ctl.signal.aborted) return emit({ type: 'done', ok: false, code: 'cancelled', error: 'Parado.' });
      }
    }
    emit({ type: 'done', ok: false, code: 'max_turns', error: 'O Gemini usou demasiados passos; pede de outra forma.' });
  }
  return {
    sendMessage(projectKey, text) {
      const prompt = String(text || '').trim().slice(0, 20000);
      if (!prompt) throw new Error('Mensagem vazia');
      if (ctl) throw new Error('O Gemini ainda está a responder');
      const id = ++runId;
      ctl = new AbortController();
      run(id, keyOf(projectKey), prompt)
        .catch((e) => o.send({ runId: id, type: 'done', ok: false, code: 'error', error: String(e.message || e) }))
        .finally(() => {
          ctl = null;
          o.send({ runId: id, type: 'exit' });
        });
      return { runId: id };
    },
    cancel() {
      if (!ctl) return false;
      ctl.abort();
      return true;
    },
    reset(projectKey) {
      if (ctl) ctl.abort();
      threads.delete(keyOf(projectKey));
      return true;
    },
    status: () => ({ installed: Boolean(geminiKey(o.env || process.env)), running: Boolean(ctl) }),
    cleanup() {
      if (ctl) ctl.abort();
    },
  };
}

module.exports = { findCodex, buildCodexArgs, createCodexParser, createGptChat, cleanSchema, geminiTools, createGeminiChat };
