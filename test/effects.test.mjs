// Effects generator (Claude, Gemini, ChatGPT -> recipes of editor tools) and the effects library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gen = require('../electron/effectgen.cjs');
const { createEffectLibrary } = require('../electron/effectlib.cjs');
const { TOOLS } = require('../electron/mcp.cjs');

test('every category only allows real editor tools', () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const [k, c] of Object.entries(gen.CATEGORIES)) for (const t of c.tools) assert.ok(names.has(t), `${k}: ${t}`);
});

test('prompt carries the request, the allowed tools without clip_id and the Fusion nodes', () => {
  const p = gen.recipePrompt('fusion', 'brilho dourado', { canvas: { w: 1080, h: 1920 }, clipDuration: 12 });
  assert.match(p, /brilho dourado/);
  assert.match(p, /fusion_add_node/);
  assert.match(p, /- glow \(/);
  assert.doesNotMatch(p, /"clip_id"/);
  assert.doesNotMatch(gen.recipePrompt('movimento', 'x'), /fusion_add_node/);
  assert.throws(() => gen.recipePrompt('nada', 'x'));
});

test('validateRecipe keeps allow-listed steps only and strips clip_id except step references', () => {
  const r = gen.validateRecipe(
    {
      name: 'Ouro\u0000',
      steps: [
        { tool: 'fusion_add_node', args: { type: 'glow', clip_id: 'c_evil', params: { amount: 0.5, __proto__: { x: 1 } } } },
        { tool: 'export_video', args: { path: 'C:/x.mp4' } },
        { tool: 'fusion_set', args: { node_id: '$1.node_id', params: { amount: Infinity } } },
      ],
    },
    'fusion',
  );
  assert.equal(r.name, 'Ouro');
  assert.deepEqual(r.steps.map((s) => s.tool), ['fusion_add_node', 'fusion_set']);
  assert.equal(r.steps[0].args.clip_id, undefined);
  assert.deepEqual(r.steps[1].args.params, {});
  const t = gen.validateRecipe({ steps: [{ tool: 'add_graphic', args: { kind: 'title' } }, { tool: 'add_effect', args: { clip_id: '$1.clip_id', type: 'glow' } }] }, 'titulos');
  assert.equal(t.steps[1].args.clip_id, '$1.clip_id');
  assert.equal(gen.validateRecipe({ steps: [{ tool: 'add_graphic', args: {} }] }, 'fusion'), null, 'tool of another category');
  assert.equal(gen.validateRecipe({ steps: 'x' }, 'fusion'), null);
});

test('generateEffects asks every provider at once; one failing does not stop the others', async () => {
  const seen = [];
  const ask = {
    claude: async () => ({ name: 'A', steps: [{ tool: 'set_keyframe', args: { time: 0, zoom: 1 } }] }),
    gemini: async () => {
      throw new Error('sem OmniRoute');
    },
    gpt: async () => ({ name: 'C', steps: [{ tool: 'rm_rf', args: {} }] }),
  };
  const out = await gen.generateEffects('movimento', 'zoom lento', { ask, onResult: (r) => seen.push(r.provider) });
  assert.deepEqual(out.map((r) => [r.provider, r.ok]), [['claude', true], ['gemini', false], ['gpt', false]]);
  assert.equal(out[0].recipe.provider, 'claude');
  assert.equal(out[0].recipe.prompt, 'zoom lento');
  assert.match(out[1].error, /OmniRoute/);
  assert.equal(seen.length, 3);
  await assert.rejects(gen.generateEffects('movimento', '  ', { ask }));
});

test('effects library: save, unique ids, validated on read, rename, delete', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), 'effects-library.json');
  const lib = createEffectLibrary(file);
  const recipe = { name: 'Zoom lento', category: 'movimento', provider: 'gemini', steps: [{ tool: 'set_keyframe', args: { time: 0, zoom: 1 } }] };
  const a = lib.save(recipe);
  const b = lib.save(recipe);
  assert.equal(a.id, 'e-zoom-lento');
  assert.equal(b.id, 'e-zoom-lento-2');
  assert.equal(lib.list().length, 2);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.effects['e-bad'] = { name: 'x', category: 'movimento', steps: [{ tool: 'export_video', args: {} }] };
  raw.effects['../x'] = recipe;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.deepEqual(lib.list().map((e) => e.id).sort(), ['e-zoom-lento', 'e-zoom-lento-2']);
  assert.ok(lib.rename(a.id, 'Zoom do Vitor'));
  assert.equal(lib.get(a.id).name, 'Zoom do Vitor');
  assert.ok(lib.delete(b.id));
  assert.equal(lib.delete('e-nada'), false);
  assert.throws(() => lib.save({ name: 'x', category: 'fusion', steps: [] }));
});

test('vertical projects get the letterbox hint, horizontal ones do not', () => {
  assert.match(gen.recipePrompt('fusion', 'x', { canvas: { w: 1080, h: 1920 } }), /VERTICAL[\s\S]*ratio entre 1\.0 e 1\.15/);
  assert.doesNotMatch(gen.recipePrompt('fusion', 'x', { canvas: { w: 1920, h: 1080 } }), /ratio entre/);
});

test('claude -p never gets tools; a reference image goes inside the message (stream-json)', () => {
  const { buildLlmArgs } = require('../electron/llm.cjs');
  const plain = buildLlmArgs({ model: 'sonnet', mcpConfigPath: 'm.json' });
  const img = buildLlmArgs({ model: 'sonnet', mcpConfigPath: 'm.json', image: true });
  for (const a of [plain, img]) {
    assert.equal(a[a.indexOf('--tools') + 1], '', 'no tools');
    assert.ok(!a.includes('--allowedTools'));
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  }
  assert.equal(plain[plain.indexOf('--output-format') + 1], 'json');
  assert.equal(img[img.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(img[img.indexOf('--output-format') + 1], 'stream-json');
});

test('reference image reaches the three providers', async () => {
  const seen = {};
  const ask = Object.fromEntries(['claude', 'gemini', 'gpt'].map((p) => [p, async (prompt, o) => {
    seen[p] = { image: o.image, prompt };
    return { name: 'x', steps: [{ tool: 'set_color', args: { look: 'teal' } }] };
  }]));
  const img = Buffer.from([0xff, 0xd8, 0xff]);
  const out = await gen.generateEffects('fusion', '', { ask, image: img });
  assert.ok(out.every((r) => r.ok));
  for (const p of ['claude', 'gemini', 'gpt']) {
    assert.equal(seen[p].image, img);
    assert.match(seen[p].prompt, /IMAGEM DE REFERÊNCIA/);
  }
  await assert.rejects(gen.generateEffects('fusion', '', { ask }), /imagem de referência/);
});
