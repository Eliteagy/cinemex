// Claude chat inside Cinemex: runs the locally installed Claude Code CLI in headless mode
// (the user's own login/subscription, no API key) with ONE tool source — the editor's own MCP
// server. Each message is one `claude -p` run; follow-ups resume the project's session.
//
// Security:
// - the CLI gets no built-in tools (--tools ""), no other MCP servers (--strict-mcp-config) and
//   only mcp__cinemex__* is allowed; buildClaudeArgs refuses anything else;
// - the MCP bearer token lives only in a temp config file in userData (0600), never in argv,
//   logs or the renderer, and the file is deleted on exit;
// - inherited Claude Code / Anthropic variables are stripped so the CLI uses the normal login;
// - the prompt goes through stdin, never through a shell or argv.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = 'cinemex';
const TOOL_PREFIX = `mcp__${SERVER}__`;
const ALLOWED_TOOLS = [`${TOOL_PREFIX}*`];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Environment for the CLI: the parent env minus anything that would override the user's login
 *  or make the child think it runs inside another Claude Code session. */
const STRIP_EXACT = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES',
  'ELITE_MCP_TOKEN',
]);
function buildChildEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined) continue;
    const K = k.toUpperCase(); // Windows env names are case-insensitive
    if (STRIP_EXACT.has(K)) continue;
    out[k] = v;
  }
  // the chat is the editor's assistant, not the user's coding setup: no CLAUDE.md, no memory
  out.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return out;
}

/** The MCP config the CLI reads: the editor's server and nothing else. */
function buildMcpConfig({ url, token }) {
  const u = new URL(url);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('O MCP do editor tem de ser local (127.0.0.1)');
  if (!token || !/^[A-Za-z0-9]+$/.test(token)) throw new Error('Token do MCP inválido');
  return { mcpServers: { [SERVER]: { type: 'http', url: u.toString(), headers: { Authorization: `Bearer ${token}` } } } };
}

/** Refuses a config that points anywhere but the editor's own MCP. */
function assertEditorOnlyConfig(cfg) {
  const names = Object.keys(cfg?.mcpServers || {});
  if (names.length !== 1 || names[0] !== SERVER) throw new Error('Configuração MCP recusada: só o servidor do Cinemex é permitido');
  const s = cfg.mcpServers[SERVER];
  const u = new URL(s.url);
  if (s.type !== 'http' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('Configuração MCP recusada: o servidor tem de ser local');
  return true;
}

const safePath = (p) => typeof p === 'string' && path.isAbsolute(p) && !/["%^&|<>\r\n]/.test(p);

/**
 * Arguments for one headless turn. Only static flags, uuids and paths: no user text.
 * @param {{mcpConfigPath: string, systemPromptPath: string, sessionId: string, resume: boolean, model?: string, allowedTools?: string[]}} o
 */
function buildClaudeArgs(o) {
  const allowed = o.allowedTools || ALLOWED_TOOLS;
  if (!allowed.length || allowed.some((t) => typeof t !== 'string' || !t.startsWith(TOOL_PREFIX))) throw new Error('Recusado: o chat só pode usar as ferramentas do editor (mcp__cinemex__*)');
  if (!UUID.test(String(o.sessionId))) throw new Error('Sessão inválida');
  if (!safePath(o.mcpConfigPath) || !safePath(o.systemPromptPath)) throw new Error('Caminho inválido');
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // no user/project settings (hooks, plugins, skills, permissions); CLAUDE.md and auto-memory
    // are switched off through the env (buildChildEnv). Not --safe-mode: it also drops --mcp-config.
    '--setting-sources', '',
    '--disable-slash-commands',
    '--tools', '', // no built-in tools at all (no Bash, Read, Edit, Web…)
    '--strict-mcp-config',
    '--mcp-config', o.mcpConfigPath,
    '--allowedTools', allowed.join(','),
    '--permission-mode', 'dontAsk', // anything not allowed is denied, never prompted
    '--append-system-prompt-file', o.systemPromptPath,
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
  ];
  if (o.model && /^[a-z0-9.\-[\]]+$/i.test(o.model)) args.push('--model', o.model);
  return args;
}

// ------------------------------------------------------------------ stream-json parser
const TOOL_LABELS = [
  [/caption|srt/, 'legendas'],
  [/color/, 'cor'],
  [/audio/, 'som'],
  [/export_video/, 'exportar'],
  [/cut_silences|split|trim|delete_clip|move_clip|add_clip|dissolve|set_speed|set_transition/, 'corte'],
  [/fusion/, 'fusion'],
  [/mask/, 'máscara'],
  [/keyframe|animate/, 'animação'],
  [/add_text/, 'texto'],
  [/import_media|capcut/, 'importar'],
  [/canvas/, 'formato'],
  [/save_project|open_project/, 'projeto'],
  [/get_project/, 'projeto'],
  [/show_page|seek/, 'vista'],
];
/** "legendas · update_clip": a short area label for a tool chip (update_clip by its arguments). */
function toolLabel(name, input) {
  const short = String(name || '').startsWith(TOOL_PREFIX) ? String(name).slice(TOOL_PREFIX.length) : String(name || '');
  let area = 'editor';
  if (short === 'update_clip') {
    const a = input && typeof input === 'object' ? input : {};
    area = 'volume' in a ? 'som' : ['text', 'style', 'keyword', 'color', 'highlight', 'font', 'keyword_color', 'keyword_font', 'outline_color', 'override', 'size'].some((k) => k in a) ? 'legendas' : 'clip';
  } else {
    for (const [re, label] of TOOL_LABELS) if (re.test(short)) { area = label; break; }
  }
  return { tool: short, area };
}

const AUTH_RE = /not logged in|please run \/login|invalid api key|authentication_failed|oauth token (has )?expired|401/i;

/**
 * Turns the CLI's stream-json lines into a few UI events:
 *   init {sessionId, model, mcp: 'connected'|'failed'|..., tools: number}
 *   text {delta}           — assistant text as it streams
 *   tool {id, name, tool, area, input}
 *   tool_result {id, ok}
 *   done {ok, text, error?, code?, costUsd?, turns?}
 * Pure: feed it chunks, it calls emit(event). Robust to split lines and garbage.
 */
function createStreamParser(emit) {
  let buf = '';
  let streamedMessage = null; // id of the assistant message whose text came as deltas
  let sawText = false;
  let authError = false;
  let finished = false;
  const seenTools = new Set();

  function onLine(line) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (!d || typeof d !== 'object') return;
    if (d.type === 'system' && d.subtype === 'init') {
      const srv = (d.mcp_servers || []).find((s) => s && s.name === SERVER);
      const tools = (d.tools || []).filter((t) => String(t).startsWith(TOOL_PREFIX)).length;
      emit({ type: 'init', sessionId: d.session_id, model: d.model || '', mcp: srv ? srv.status : 'missing', tools });
      return;
    }
    if (d.type === 'stream_event' && d.event && !d.parent_tool_use_id) {
      const ev = d.event;
      if (ev.type === 'message_start') streamedMessage = ev.message?.id || null;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        sawText = true;
        emit({ type: 'text', delta: ev.delta.text, messageId: streamedMessage });
      }
      return;
    }
    if (d.type === 'assistant' && d.message && !d.parent_tool_use_id) {
      if (d.error === 'authentication_failed') authError = true;
      const id = d.message.id;
      for (const block of d.message.content || []) {
        if (block.type === 'text' && block.text && id !== streamedMessage) {
          // not streamed as deltas (or a synthetic error message): send it whole
          sawText = true;
          emit({ type: 'text', delta: block.text, messageId: id });
        }
        if (block.type === 'tool_use' && !seenTools.has(block.id)) {
          seenTools.add(block.id);
          const { tool, area } = toolLabel(block.name, block.input);
          emit({ type: 'tool', id: block.id, name: block.name, tool, area, input: block.input ?? {} });
        }
      }
      return;
    }
    if (d.type === 'user' && d.message && Array.isArray(d.message.content)) {
      for (const block of d.message.content) {
        if (block && block.type === 'tool_result') emit({ type: 'tool_result', id: block.tool_use_id, ok: !block.is_error });
      }
      return;
    }
    if (d.type === 'result') {
      finished = true;
      const text = typeof d.result === 'string' ? d.result : '';
      const isError = Boolean(d.is_error) || (d.subtype && d.subtype !== 'success');
      const auth = authError || (isError && AUTH_RE.test(text));
      emit({
        type: 'done',
        ok: !isError,
        text,
        sawText,
        sessionId: d.session_id,
        costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : undefined,
        turns: d.num_turns,
        ...(isError ? { code: auth ? 'auth' : d.subtype === 'error_max_turns' ? 'max_turns' : 'error', error: auth ? AUTH_MESSAGE : text || d.subtype || 'O Claude devolveu um erro' } : {}),
      });
    }
  }

  return {
    push(chunk) {
      buf += String(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
      if (buf.length > 8 * 1024 * 1024) buf = ''; // a runaway line: drop it
    },
    end() {
      const line = buf.trim();
      buf = '';
      if (line) onLine(line);
    },
    get finished() {
      return finished;
    },
    get authError() {
      return authError;
    },
  };
}

const AUTH_MESSAGE = 'O Claude Code não tem sessão iniciada neste PC. Abre um terminal, escreve claude e faz login uma vez; depois volta aqui.';
const MISSING_MESSAGE = 'Não encontrei o Claude Code neste PC. Instala-o (https://claude.com/claude-code) e corre claude uma vez num terminal para fazer login.';

/** Finds the CLI: claude.exe on PATH or in the usual install folders (npm .cmd shims too). */
function findClaude(env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'));
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  for (const ext of exts) {
    for (const d of dirs) {
      const f = path.join(d, 'claude' + ext);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {}
    }
  }
  return null;
}

const SYSTEM_PROMPT = `És o assistente do Cinemex, o editor de vídeo da Elite Agency (do Gui), num painel de chat ao lado do editor.
- Responde sempre em português europeu (de Portugal), curto e direto: uma ou duas frases a dizer o que fizeste ou o que precisas. Sem listas longas, sem cumprimentos.
- Só podes mexer no editor através das ferramentas mcp__cinemex__* (o projeto aberto: cortes, legendas, estilos, música/volume, cor, máscaras, Fusion, animações, formato, exportar). Não tens acesso a ficheiros, terminal nem internet.
- Em cada pedido, começa por get_project para ver o estado atual (ids, pistas, clips, volumes, durações): o Gui também edita à mão e pode ter desfeito ou aberto outro projeto entre mensagens, por isso nunca confies no que fizeste antes. Tempos em segundos. Volume 1 = 100 % (15 % = 0.15).
- Faz as alterações pedidas tu mesmo com as ferramentas; não digas que fizeste algo sem a ferramenta ter respondido bem. Se algo falhar, diz o erro numa frase.
- Antes de algo destrutivo ou demorado que não foi pedido (apagar muitos clips, substituir o projeto, exportar), confirma primeiro. Exportar só quando pedirem.
- As alterações aparecem logo no editor e podem ser desfeitas com Ctrl+Z.`;

/**
 * Chat manager for the main process.
 * @param {{userData: string, getMcp: () => ({url: string, token: string} | null), send: (ev: object) => void, env?: object}} o
 */
function createClaudeChat(o) {
  const dir = path.join(o.userData, 'claude-chat');
  const sessionsFile = path.join(o.userData, 'claude-sessions.json');
  const cfgFile = path.join(o.userData, 'claude-mcp.json');
  const promptFile = path.join(dir, 'system-prompt.txt');
  let child = null;
  let runId = 0;
  let sessions = {};
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) if (typeof v?.id === 'string' && UUID.test(v.id)) sessions[k] = { id: v.id, started: Boolean(v.started) };
  } catch {}
  const saveSessions = () => {
    try {
      fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 1));
    } catch {}
  };
  const keyOf = (k) => String(k || 'sem-projeto').slice(0, 500).toLowerCase();
  const removeConfig = () => {
    try {
      fs.rmSync(cfgFile, { force: true });
    } catch {}
  };
  removeConfig(); // left over from a crash or a forced kill

  function writeConfig() {
    const m = o.getMcp();
    if (!m || !m.url) throw new Error('O servidor MCP do editor não está ligado, por isso o Claude não consegue editar. Reinicia o Cinemex.');
    const cfg = buildMcpConfig(m);
    assertEditorOnlyConfig(cfg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
    fs.writeFileSync(promptFile, SYSTEM_PROMPT, 'utf8');
  }

  function status() {
    const bin = findClaude(o.env || process.env);
    return { installed: Boolean(bin), running: Boolean(child) };
  }

  /** One turn. Events go to o.send({runId, ...event}). Resolves when the CLI exits. */
  function sendMessage(projectKey, text) {
    const prompt = String(text || '').trim().slice(0, 20000);
    if (!prompt) throw new Error('Mensagem vazia');
    if (child) throw new Error('O Claude ainda está a responder');
    const id = ++runId;
    const emit = (ev) => o.send({ runId: id, ...ev });
    const bin = findClaude(o.env || process.env);
    if (!bin) {
      emit({ type: 'done', ok: false, code: 'missing', error: MISSING_MESSAGE });
      return { runId: id };
    }
    writeConfig();
    const key = keyOf(projectKey);
    const sess = sessions[key] || (sessions[key] = { id: crypto.randomUUID(), started: false });
    const args = buildClaudeArgs({ mcpConfigPath: cfgFile, systemPromptPath: promptFile, sessionId: sess.id, resume: sess.started });
    const env = buildChildEnv(o.env || process.env);
    const isCmd = /\.cmd$/i.test(bin);
    // npm shim: run through cmd.exe with every argument quoted (they are static flags/paths/uuids).
    const p = isCmd
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[bin, ...args].map((a) => `"${a}"`).join(' ')}"`], { cwd: dir, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(bin, args, { cwd: dir, env, windowsHide: true });
    child = p;
    let done = false;
    let stderr = '';
    let idle = null;
    const IDLE_MS = 15 * 60_000; // exports can take long, but a silent CLI for 15 min is stuck
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        emit({ type: 'done', ok: false, code: 'timeout', error: 'O Claude ficou 15 minutos sem responder; parei-o.' });
        done = true;
        kill();
      }, IDLE_MS);
    };
    const parser = createStreamParser((ev) => {
      if (ev.type === 'init' && !sess.started) {
        sess.started = true;
        saveSessions();
      }
      if (ev.type === 'done') {
        if (done) return;
        done = true;
        if (ev.code === 'auth') {
          // a failed login leaves no usable session: start fresh next time
          sessions[key] = { id: crypto.randomUUID(), started: false };
          saveSessions();
        }
      }
      emit(ev);
    });
    touch();
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => {
      touch();
      parser.push(c);
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c) => {
      stderr = (stderr + c).slice(-4000);
    });
    p.on('error', (e) => {
      if (!done) {
        done = true;
        emit({ type: 'done', ok: false, code: e.code === 'ENOENT' ? 'missing' : 'error', error: e.code === 'ENOENT' ? MISSING_MESSAGE : `Não consegui arrancar o Claude Code: ${e.message}` });
      }
    });
    p.on('close', (code, signal) => {
      clearTimeout(idle);
      parser.end();
      if (child === p) child = null;
      removeConfig(); // the token-bearing config only exists while a turn runs
      if (!done) {
        done = true;
        if (p.killedByUser) emit({ type: 'done', ok: false, code: 'cancelled', error: 'Parado.' });
        else if (parser.authError || AUTH_RE.test(stderr)) emit({ type: 'done', ok: false, code: 'auth', error: AUTH_MESSAGE });
        else if (/session|conversation/i.test(stderr) && /not found|no conversation/i.test(stderr)) {
          sessions[key] = { id: crypto.randomUUID(), started: false };
          saveSessions();
          emit({ type: 'done', ok: false, code: 'session', error: 'A conversa anterior já não existe. Começa uma nova e repete o pedido.' });
        } else emit({ type: 'done', ok: false, code: 'error', error: `O Claude Code terminou sem resposta (código ${code ?? signal}).${stderr.trim() ? ' ' + redact(stderr.trim()).slice(-300) : ''}` });
      }
      emit({ type: 'exit' });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt, 'utf8');
    return { runId: id };
  }

  function kill() {
    const p = child;
    if (!p) return false;
    p.killedByUser = true;
    if (process.platform === 'win32' && p.pid) {
      // kill the whole tree (the .cmd shim or the CLI's own children)
      spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }).on('error', () => p.kill());
    } else p.kill('SIGTERM');
    return true;
  }

  function reset(projectKey) {
    if (child) kill();
    sessions[keyOf(projectKey)] = { id: crypto.randomUUID(), started: false };
    saveSessions();
    return true;
  }

  function cleanup() {
    kill();
    removeConfig();
  }

  return { sendMessage, cancel: kill, reset, status, cleanup, get busy() { return Boolean(child); } };
}

/** Never let the bearer token or similar secrets reach the UI. */
function redact(s) {
  return String(s).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***').replace(/\b[a-f0-9]{40,}\b/gi, '***');
}

module.exports = { buildClaudeArgs, buildChildEnv, buildMcpConfig, assertEditorOnlyConfig, createStreamParser, toolLabel, findClaude, createClaudeChat, redact, SYSTEM_PROMPT, AUTH_MESSAGE, MISSING_MESSAGE, ALLOWED_TOOLS };
