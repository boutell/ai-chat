const { execSync } = require('child_process');
const db = require('../db');
const { ollamaGet, ollamaPost } = require('./ollama');

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
  const data = await ollamaGet('/api/tags');
  return data.models || [];
}

async function pullModel(model) {
  return ollamaPost('/api/pull', { name: model, stream: false });
}

async function speedTest(model) {
  const start = Date.now();
  const data = await ollamaPost('/api/chat', {
    model,
    messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
    stream: false
  });
  const elapsed = (Date.now() - start) / 1000;
  const tokens = data.eval_count || 20;
  return { tokensPerSecond: tokens / elapsed, elapsed, tokens };
}

function isModelAvailable(modelNames, candidate) {
  const base = candidate.split(':')[0];
  return modelNames.some(n => n === candidate || n.split(':')[0] === base);
}

async function autoSelect(onProgress = () => {}) {
  const ramGB = getSystemRamGB();
  onProgress({ step: 'ram', ramGB });

  const models = await listModels();
  const modelNames = models.map(m => m.name);

  // Build ordered candidate list: preferred tier model first, then fallbacks
  const tier = MODEL_TIERS.find(t => ramGB >= t.minRam);
  const candidates = [tier.model];
  for (const t of MODEL_TIERS) {
    if (!candidates.includes(t.model)) {
      candidates.push(t.model);
    }
  }

  for (const candidate of candidates) {
    try {
      if (!isModelAvailable(modelNames, candidate)) {
        onProgress({ step: 'pulling', model: candidate });
        await pullModel(candidate);
      }

      onProgress({ step: 'testing', model: candidate });
      const result = await speedTest(candidate);

      if (result.tokensPerSecond >= 5) {
        setSelectedModel(candidate);
        const finalResult = {
          model: candidate,
          ramGB,
          speed: result,
          fallback: candidate !== candidates[0]
        };
        onProgress({ step: 'result', ...finalResult });
        return finalResult;
      }
    } catch {
      continue;
    }
  }

  // Last resort
  const lastResort = candidates[candidates.length - 1];
  try {
    if (!isModelAvailable(modelNames, lastResort)) {
      onProgress({ step: 'pulling', model: lastResort });
      await pullModel(lastResort);
    }
    setSelectedModel(lastResort);
    const finalResult = { model: lastResort, ramGB, speed: null, fallback: true };
    onProgress({ step: 'result', ...finalResult });
    return finalResult;
  } catch (err) {
    throw new Error(`Could not pull any model. Last tried: ${lastResort}. Error: ${err.message}`);
  }
}

module.exports = {
  getSelectedModel, setSelectedModel, listModels, autoSelect,
  MODEL_TIERS, getSystemRamGB
};
