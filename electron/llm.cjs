// One-shot AI calls for the editor's own features (best moments, translation, chapters): the local
// Claude Code CLI in headless mode with the user's login, no tools at all, answer as JSON.
//
// Security (same rules as claude-chat.cjs):
// - no built-in tools (--tools ""), no MCP servers (--strict-mcp-config with an empty config),
//   no user/project settings, permission mode dontAsk: the model can only write text back;
// - the prompt goes through stdin, never argv or a shell; argv holds only static flags;
// - inherited Anthropic/Claude Code variables are stripped (buildChildEnv) so the normal login is used.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildChildEnv, findClaude, AUTH_MESSAGE, MISSING_MESSAGE } = require('./claude-chat.cjs');

const MODELS = new Set(['opus', 'sonnet', 'haiku']);

/** Static argv for one call (no user text). */
function buildLlmArgs({ model, mcpConfigPath, image } = {}) {
  // No tools ever. A reference image goes inside the message itself (stream-json input with an image
  // block), not as a file to Read: a Read permission would also open every other file on the PC.
  const io = image ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json'];
  const args = ['-p', ...io, '--setting-sources', '', '--disable-slash-commands', '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfigPath, '--permission-mode', 'dontAsk'];
  if (model && MODELS.has(model)) args.push('--model', model);
  return args;
}

/** The first JSON value in a model answer (tolerates ```json fences and text around it). */
function extractJson(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  try {
    return JSON.parse(body);
  } catch {}
  const i = body.search(/[[{]/);
  if (i < 0) throw new Error('A resposta da IA não trouxe JSON');
  const open = body[i];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  for (let j = i; j < body.length; j++) {
    const ch = body[j];
    if (inStr) {
      if (ch === '\\') j++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(body.slice(i, j + 1));
  }
  throw new Error('JSON da IA incompleto');
}

/**
 * Sends `prompt` (system text + task) to Claude and returns the parsed JSON answer.
 * @param {string} prompt
 * @param {{model?: string, timeoutMs?: number, env?: object, workDir?: string, signal?: AbortSignal}} [o]
 */
function askJson(prompt, o = {}) {
  return new Promise((resolve, reject) => {
    const env0 = o.env || process.env;
    const bin = findClaude(env0);
    if (!bin) return reject(new Error(MISSING_MESSAGE));
    const dir = fs.mkdtempSync(path.join(o.workDir || os.tmpdir(), 'cmx-llm-'));
    const cfg = path.join(dir, 'mcp.json');
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    const args = buildLlmArgs({ model: o.model, mcpConfigPath: cfg, image: Boolean(o.image) });
    const env = buildChildEnv(env0);
    const isCmd = /\.cmd$/i.test(bin);
    const p = isCmd
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[bin, ...args].map((a) => `"${a}"`).join(' ')}"`], { cwd: dir, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(bin, args, { cwd: dir, env, windowsHide: true });
    let out = '';
    let err = '';
    let finished = false;
    const finish = (fn, v) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
      fn(v);
    };
    const kill = () => {
      if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }).on('error', () => p.kill());
      else p.kill();
    };
    const timer = setTimeout(() => {
      kill();
      finish(reject, new Error('A IA demorou demasiado (tempo esgotado)'));
    }, o.timeoutMs ?? 10 * 60_000);
    o.signal?.addEventListener('abort', () => {
      kill();
      finish(reject, new Error('Cancelado'));
    });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => finish(reject, e));
    p.on('close', (code) => {
      let res;
      try {
        // stream-json (with an image): the last {"type":"result"} line carries the answer.
        res = o.image ? out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.type === 'result').pop() : JSON.parse(out);
        if (!res) throw new Error('no result');
      } catch {
        const auth = /log ?in|auth|credential/i.test(out + err);
        return finish(reject, new Error(auth ? AUTH_MESSAGE : `Claude terminou com o código ${code}: ${(err || out).slice(0, 300)}`));
      }
      if (res.is_error) return finish(reject, new Error(/log ?in|auth/i.test(String(res.result)) ? AUTH_MESSAGE : String(res.result || 'Erro da IA').slice(0, 300)));
      try {
        finish(resolve, extractJson(res.result));
      } catch (e) {
        finish(reject, e);
      }
    });
    if (o.image) {
      const media = o.image[0] === 0x89 ? 'image/png' : 'image/jpeg';
      const msg = { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media, data: Buffer.from(o.image).toString('base64') } }, { type: 'text', text: String(prompt) }] } };
      p.stdin.end(JSON.stringify(msg) + '\n');
    } else p.stdin.end(String(prompt));
  });
}

module.exports = { askJson, extractJson, buildLlmArgs };
