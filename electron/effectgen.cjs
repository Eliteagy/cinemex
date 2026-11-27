// Effects generator ("Gerador de efeitos"): the Gui writes what he wants ("brilho dourado com grão
// de filme"), and Claude, Gemini and ChatGPT each answer with a RECIPE: a short list of the editor's
// own tools (Fusion nodes, layer effects, keyframes, transitions, graphics, caption style). The
// renderer runs a recipe on the selected clip as one undo step (src/effectRecipes.ts), so every
// value goes through the same checks as Claude's MCP calls. Good recipes are kept in the effects
// library (userData/effects-library.json, electron/effectlib.cjs).
//
// Providers (all on this PC, the Gui's own logins):
//   claude  `claude -p` without tools (electron/llm.cjs)
//   gemini  OmniRoute gateway 127.0.0.1:20128 (OpenAI-compatible), key ~/.claude-omniroute/omniroute.key
//   gpt     OpenAI Codex CLI `codex exec --json`, read-only sandbox, no MCP, empty working folder
// The models only write JSON text; nothing they say is run except allow-listed editor tools.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { askJson, extractJson } = require('./llm.cjs');
const { findCodex } = require('./ai-providers.cjs');
const { TOOLS } = require('./mcp.cjs');

const FUSION_NODES = require('../src/lib/fusion-nodes.json');

/** What each kind of effect may use. clip_id is filled in by the editor (the selected clip). */
const CATEGORIES = {
  fusion: {
    label: 'Efeito de vídeo',
    tools: ['fusion_add_node', 'fusion_set', 'fusion_set_keyframe', 'add_effect', 'set_color', 'set_blend', 'set_modifier'],
    brief: 'Um efeito visual no clip de vídeo selecionado: nós do Fusion (encadeados com "after"), efeitos de camada e cor.',
  },
  legendas: {
    label: 'Animação de legendas',
    tools: ['set_caption_style'],
    brief: 'Um aspeto e uma animação para TODAS as legendas do projeto (o estilo próprio do projeto).',
  },
  titulos: {
    label: 'Título / grafismo',
    tools: ['add_graphic', 'update_graphic', 'add_text', 'add_effect', 'set_keyframe', 'set_keyframe_ease'],
    brief: 'Um título ou grafismo animado posto na cabeça de leitura. add_graphic devolve clip_id: usa "$N.clip_id" para mexer nele a seguir.',
  },
  movimento: {
    label: 'Movimento / transição',
    tools: ['set_keyframe', 'set_keyframe_ease', 'set_modifier', 'animate_clip', 'set_transition', 'dissolve', 'set_speed'],
    brief: 'Movimento de câmara (zoom, posição, rotação) com keyframes em segundos DO CLIP, e transições de entrada/saída.',
  },
};

const PROVIDERS = ['claude', 'gemini', 'gpt'];
const PROVIDER_LABEL = { claude: 'Claude', gemini: 'Gemini', gpt: 'ChatGPT' };

const toolSchema = (name) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return null;
  const props = { ...(t.inputSchema?.properties || {}) };
  delete props.clip_id;
  return { name, description: t.description, args: props };
};

/** The prompt: the request, the allowed tools with their arguments, the recipe format. */
function recipePrompt(category, request, ctx = {}) {
  const cat = CATEGORIES[category];
  if (!cat) throw new Error('Tipo de efeito desconhecido');
  const tools = cat.tools.map(toolSchema).filter(Boolean);
  const nodes =
    category === 'fusion'
      ? Object.entries(FUSION_NODES)
          .filter(([k, v]) => k !== '_comment' && v && !['mediaIn', 'mediaOut'].includes(k))
          .map(([k, v]) => `- ${k} (${v.label}): ${Object.entries(v.params || {}).map(([p, d]) => `${p} ${d.type === 'number' ? `${d.min}..${d.max}` : d.type}${d.default !== undefined ? ` (=${JSON.stringify(d.default)})` : ''}`).join(', ')}`)
          .join('\n')
      : '';
  const vertical = !ctx.canvas || ctx.canvas.h > ctx.canvas.w;
  const hints = [
    vertical ? '- Vídeo vertical: barras de cinema (letterbox) NUNCA com ratio de cinema 2.35/2.39 (sobrava uma faixa fina de imagem); usa ratio entre 1.0 e 1.15 para um look de cinema em vertical.' : '',
    '- Efeitos subtis por defeito: o vídeo tem de continuar natural e legível (pessoas, legendas).',
  ]
    .filter(Boolean)
    .join('\n');
  return `És um editor de vídeo e motion designer. Cria UM efeito para o editor Cinemex.

Pedido do editor: """${String(request).slice(0, 600)}"""
Tipo: ${cat.label}. ${cat.brief}
Projeto: ${ctx.canvas ? `${ctx.canvas.w}x${ctx.canvas.h}` : '1080x1920'} (${vertical ? 'VERTICAL, para Reels/TikTok' : 'horizontal'})${ctx.clipDuration ? `, clip selecionado com ${Number(ctx.clipDuration).toFixed(1)} s` : ''}.

Só podes usar estas ferramentas (o editor mete o clip_id sozinho):
${JSON.stringify(tools)}
${nodes ? `\nNós do Fusion (type de fusion_add_node) e parâmetros:\n${nodes}\n` : ''}
Regras:
- Entre 1 e 12 passos. Valores dentro dos limites. Tempos em segundos.
- Para usar o resultado de um passo anterior: "$N.campo" (N = número do passo, a contar de 1), ex. "$1.node_id" ou "$1.clip_id".
- Nada de texto fora do JSON.
${hints}

Responde APENAS com JSON:
{"name":"nome curto em português","description":"uma frase","steps":[{"tool":"...","args":{...}}]}`;
}

/** A recipe the editor can run, or null: known tools of the category only, plain JSON args. */
function validateRecipe(raw, category) {
  const cat = CATEGORIES[category];
  if (!cat || !raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) return null;
  const clean = (v, depth = 0) => {
    if (depth > 4) return undefined;
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string') return v.slice(0, 400);
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
    if (typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v).slice(0, 40)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) || k === '__proto__') continue;
        // clip_id is the editor's job, except a reference to a clip made by an earlier step.
        if (k === 'clip_id' && !(typeof x === 'string' && /^\$\d{1,2}\.clip_id$/.test(x))) continue;
        const c = clean(x, depth + 1);
        if (c !== undefined) o[k] = c;
      }
      return o;
    }
    return undefined;
  };
  const steps = raw.steps
    .slice(0, 12)
    .filter((s) => s && typeof s === 'object' && cat.tools.includes(s.tool))
    .map((s) => ({ tool: s.tool, args: clean(s.args && typeof s.args === 'object' ? s.args : {}) || {} }));
  if (!steps.length) return null;
  const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  return { name: text(raw.name, 60) || 'Efeito', description: text(raw.description, 200), category, steps };
}

// ------------------------------------------------------------------ providers
function geminiKey(env = process.env) {
  try {
    return fs.readFileSync(path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude-omniroute', 'omniroute.key'), 'utf8').trim();
  } catch {
    return null;
  }
}

const GEMINI_URL = 'http://127.0.0.1:20128/v1/chat/completions';
const GEMINI_MODELS = ['gemini/gemini-3-flash-preview', 'gemini/gemini-flash-latest', 'gemini/gemini-2.5-flash'];

/** One JSON answer from Gemini (OmniRoute). image: a JPEG/PNG Buffer sent with the prompt (vision). */
async function askGemini(prompt, { fetchFn = fetch, signal, image } = {}) {
  const key = geminiKey();
  if (!key) throw new Error('O Gemini precisa do OmniRoute ligado (chave em ~/.claude-omniroute/omniroute.key)');
  let last = null;
  for (const model of GEMINI_MODELS) {
    try {
      const r = await fetchFn(GEMINI_URL, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${image[0] === 0x89 ? 'image/png' : 'image/jpeg'};base64,${image.toString('base64')}` } }] : prompt }], response_format: { type: 'json_object' } }) });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        last = new Error(`Gemini ${r.status}: ${String(body?.error?.message || '').slice(0, 200)}`);
        if (r.status === 401 || r.status === 403 || r.status === 429) throw last;
        continue;
      }
      const text = body?.choices?.[0]?.message?.content;
      if (text) return extractJson(String(text));
      last = new Error('O Gemini devolveu uma resposta vazia');
    } catch (e) {
      if (/ECONNREFUSED|fetch failed/i.test(String(e?.message || e))) throw new Error('O Gemini precisa do OmniRoute ligado (127.0.0.1:20128)');
      last = e;
      if (/401|403|429/.test(String(e?.message))) throw e;
    }
  }
  throw last || new Error('Gemini sem resposta');
}

function askGpt(prompt, { env = process.env, signal, timeoutMs = 240_000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findCodex(env);
    if (!bin) return reject(new Error('O ChatGPT usa o Codex CLI (npm i -g @openai/codex e codex login)'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-gpt-'));
    const p = spawn(bin, ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-'], { cwd: dir, env, windowsHide: true });
    let out = '';
    let err = '';
    let text = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
      fn(v);
    };
    const abort = () => {
      p.kill();
      finish(reject, new Error('Cancelado'));
    };
    const timer = setTimeout(() => {
      p.kill();
      finish(reject, new Error('O ChatGPT demorou demasiado'));
    }, timeoutMs);
    signal?.addEventListener('abort', abort);
    p.stdout.on('data', (d) => {
      out += String(d);
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === 'item.completed' && m.item?.type === 'agent_message' && m.item.text) text = m.item.text;
          if (m.type === 'turn.failed' || m.type === 'error') err = m.error?.message || m.message || err;
        } catch {}
      }
    });
    p.stderr.on('data', (d) => (err = (err + String(d)).slice(-1000)));
    p.on('error', (e) => finish(reject, e));
    p.on('close', () => {
      if (!text) return finish(reject, new Error(`ChatGPT: ${String(err).trim().split('\n').pop() || 'sem resposta'}`));
      try {
        finish(resolve, extractJson(text));
      } catch (e) {
        finish(reject, e);
      }
    });
    p.stdin.end(prompt);
  });
}

const ASK = {
  claude: (prompt, o) => askJson(prompt, { model: 'sonnet', signal: o.signal }),
  gemini: (prompt, o) => askGemini(prompt, o),
  gpt: (prompt, o) => askGpt(prompt, o),
};

/**
 * Asks the chosen providers at the same time. Resolves with one entry per provider:
 * { provider, label, ok, recipe?, error?, ms }. onResult(entry) as each one arrives.
 */
async function generateEffects(category, request, { providers = PROVIDERS, ctx, ask = ASK, onResult, signal } = {}) {
  if (!CATEGORIES[category]) throw new Error('Tipo de efeito desconhecido');
  if (!String(request || '').trim()) throw new Error('Escreve o efeito que queres');
  const prompt = recipePrompt(category, request, ctx);
  const list = providers.filter((p) => PROVIDERS.includes(p));
  return Promise.all(
    list.map(async (provider) => {
      const t0 = Date.now();
      let entry;
      try {
        const raw = await ask[provider](prompt, { signal });
        const recipe = validateRecipe(raw, category);
        entry = recipe ? { provider, label: PROVIDER_LABEL[provider], ok: true, recipe: { ...recipe, provider, prompt: String(request).slice(0, 600) } } : { provider, label: PROVIDER_LABEL[provider], ok: false, error: 'A resposta não trazia passos válidos' };
      } catch (e) {
        entry = { provider, label: PROVIDER_LABEL[provider], ok: false, error: String(e?.message || e).slice(0, 300) };
      }
      entry.ms = Date.now() - t0;
      onResult?.(entry);
      return entry;
    }),
  );
}

module.exports = { CATEGORIES, PROVIDERS, PROVIDER_LABEL, recipePrompt, validateRecipe, generateEffects, askGemini, askGpt };
