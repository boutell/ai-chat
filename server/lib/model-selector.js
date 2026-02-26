const { execSync } = require('child_process');
const db = require('../db');

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';

// Models ordered by quality/size. The selector picks the best one
// that's feasible for the detected RAM.
const MODEL_TIERS = [
  { minRam: 24, model: 'mistral-small-3.1' },
  { minRam: 10, model: 'ministral-3:8b' },
  { minRam: 0, model: 'ministral-3:3b' }
];

function getSystemRamGB() {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      const bytes = parseInt(execSync('sysctl -n hw.memsize', { encoding: 'utf8' }).trim());
      return Math.round(bytes / (1024 ** 3));
    } else if (platform === 'linux') {
      const meminfo = execSync('grep MemTotal /proc/meminfo', { encoding: 'utf8' });
      const kb = parseInt(meminfo.match(/(\d+)/)[1]);
      return Math.round(kb / (1024 ** 2));
    }
  } catch {
    return 8; // conservative default
  }
  return 8;
}

function getSelectedModel() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('selected_model');
  return row ? row.value : null;
}

function setSelectedModel(model) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', model);
}

async function listModels() {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) throw new Error('Could not reach ollama');
  const data = await res.json();
  return data.models || [];
}

async function pullModel(model) {
  const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: false })
  });
  if (!res.ok) throw new Error(`Failed to pull model ${model}`);
  return res.json();
}

async function speedTest(model) {
  const start = Date.now();
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
      stream: false
    })
  });
  if (!res.ok) throw new Error(`Speed test failed for ${model}`);
  const data = await res.json();
  const elapsed = (Date.now() - start) / 1000;
  const tokens = data.eval_count || 20;
  return { tokensPerSecond: tokens / elapsed, elapsed, tokens };
}

function isModelAvailable(modelNames, candidate) {
  // Check both with and without tag suffix
  const base = candidate.split(':')[0];
  return modelNames.some(n => n === candidate || n.split(':')[0] === base);
}

async function autoSelect() {
  const ramGB = getSystemRamGB();
  const models = await listModels();
  const modelNames = models.map(m => m.name);

  // Build ordered candidate list: preferred tier model first, then fallbacks
  const tier = MODEL_TIERS.find(t => ramGB >= t.minRam);
  const candidates = [tier.model];
  // Add smaller models as fallbacks (in tier order, deduplicated)
  for (const t of MODEL_TIERS) {
    if (!candidates.includes(t.model)) {
      candidates.push(t.model);
    }
  }

  for (const candidate of candidates) {
    try {
      // Pull if not available locally
      if (!isModelAvailable(modelNames, candidate)) {
        await pullModel(candidate);
      }

      // Speed test
      const result = await speedTest(candidate);

      if (result.tokensPerSecond >= 5) {
        setSelectedModel(candidate);
        return {
          model: candidate,
          ramGB,
          speed: result,
          fallback: candidate !== candidates[0]
        };
      }
      // Too slow — try next candidate
    } catch (err) {
      // Pull or speed test failed for this candidate — try next
      continue;
    }
  }

  // All candidates tried. Use the smallest as a last resort even if slow.
  const lastResort = candidates[candidates.length - 1];
  try {
    if (!isModelAvailable(modelNames, lastResort)) {
      await pullModel(lastResort);
    }
    setSelectedModel(lastResort);
    return { model: lastResort, ramGB, speed: null, fallback: true };
  } catch (err) {
    throw new Error(`Could not pull any model. Last tried: ${lastResort}. Error: ${err.message}`);
  }
}

module.exports = {
  getSelectedModel, setSelectedModel, listModels, autoSelect,
  OLLAMA_BASE, MODEL_TIERS, getSystemRamGB
};
