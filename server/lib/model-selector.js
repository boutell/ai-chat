import { execSync } from 'child_process';
import db from '../db.js';
import { chatStream, chatComplete, listLocalModels, downloadModel, resolveModelId, MODELS_DIR } from './llm.js';
import path from 'path';

// Models ordered by quality/size. The selector picks the best one
// that's feasible for the detected RAM.
export const MODEL_TIERS = [
  { minRam: 32, uri: 'hf:bartowski/Mistral-Small-Instruct-2409-GGUF:Q4_K_M', name: 'Mistral Small 22B' },
  { minRam: 10, uri: 'hf:bartowski/Ministral-8B-Instruct-2410-GGUF:Q4_K_M', name: 'Ministral 8B' },
  { minRam: 5, uri: 'hf:bartowski/Phi-3.5-mini-instruct-GGUF:Q4_K_M', name: 'Phi 3.5 Mini' },
  { minRam: 0, uri: 'hf:bartowski/mistralai_Ministral-3-3B-Instruct-2512-GGUF:Q4_K_M', name: 'Ministral 3B' }
];

export function getSystemRamGB() {
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

// Convert a filesystem path to an opaque model ID (filename without .gguf)
export function pathToModelId(modelPath) {
  const filename = path.basename(modelPath);
  return filename.replace(/\.gguf$/, '');
}

// Get the stored model ID (opaque, not a path)
export function getSelectedModel() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('selected_model');
  if (!row || !row.value) {
    return null;
  }
  // Migrate old path-based values: extract just the ID
  if (row.value.includes('/') || row.value.includes('\\')) {
    const id = pathToModelId(row.value);
    setSelectedModel(id);
    return id;
  }
  // Ignore stale ollama model names from before the migration
  if (row.value.includes(':')) {
    return null;
  }
  return row.value;
}

// Get the filesystem path for the selected model
export function getSelectedModelPath() {
  const id = getSelectedModel();
  if (!id) {
    return null;
  }
  return resolveModelId(id);
}

export function setSelectedModel(modelId) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', modelId);
}

export function clearSelectedModel() {
  db.prepare('DELETE FROM settings WHERE key = ?').run('selected_model');
}

// Get a human-friendly display name for a model ID
export function getDisplayName(id) {
  // Check if any tier matches this ID
  for (const tier of MODEL_TIERS) {
    const repoName = (tier.uri.split(':')[1] || '').split('/')[1] || '';
    const search = repoName.toLowerCase().replace(/-gguf$/, '');
    if (id.toLowerCase().includes(search)) {
      return tier.name;
    }
  }
  // Fall back to cleaning up the ID
  return id
    .replace(/^hf_bartowski_/, '')
    .replace(/\.Q\d+_K_[A-Z]+$/, '')
    .replace(/-/g, ' ');
}

export function listModels() {
  return listLocalModels();
}

// Returns RAM-appropriate models for the menu: tier models that fit this
// machine's RAM, plus any other locally downloaded models not in tiers.
// Each entry: { id, name, downloaded, uri }
export function listAvailableModels() {
  const ramGB = getSystemRamGB();
  const localModels = listLocalModels();
  const result = [];
  const coveredIds = new Set();

  // Add tier models that fit in RAM (largest first for display)
  for (const tier of MODEL_TIERS) {
    if (ramGB < tier.minRam) {
      continue;
    }
    const match = localModels.find(m => {
      const name = m.name.toLowerCase();
      const repoName = (tier.uri.split(':')[1] || '').split('/')[1] || '';
      const search = repoName.toLowerCase().replace(/-gguf$/, '');
      return name.includes(search);
    });
    if (match) {
      result.push({ id: match.name, name: tier.name, downloaded: true, uri: tier.uri });
      coveredIds.add(match.name);
    } else {
      // Generate a predictable ID for undownloaded tier models
      result.push({ id: tier.uri, name: tier.name, downloaded: false, uri: tier.uri });
    }
  }

  // Add any local models not covered by tiers, but only if they fit in RAM.
  // Models that exceed available RAM should not appear in the menu.
  const allTierSearches = MODEL_TIERS.map(t => {
    const repoName = (t.uri.split(':')[1] || '').split('/')[1] || '';
    return { search: repoName.toLowerCase().replace(/-gguf$/, ''), minRam: t.minRam };
  });

  for (const m of localModels) {
    if (coveredIds.has(m.name)) {
      continue;
    }
    // Check if this model matches a tier that's too large for this machine
    const tierMatch = allTierSearches.find(t => m.name.toLowerCase().includes(t.search));
    if (tierMatch && ramGB < tierMatch.minRam) {
      continue;
    }
    result.push({ id: m.name, name: getDisplayName(m.name), downloaded: true, uri: null });
  }

  return result;
}

// Find the URI for a tier model by its ID (which may be the URI itself for undownloaded models)
export function findTierUri(id) {
  for (const tier of MODEL_TIERS) {
    if (tier.uri === id) {
      return tier.uri;
    }
    // Check if the id matches a downloaded model for this tier
    const repoName = (tier.uri.split(':')[1] || '').split('/')[1] || '';
    const search = repoName.toLowerCase().replace(/-gguf$/, '');
    if (id.toLowerCase().includes(search)) {
      return tier.uri;
    }
  }
  return null;
}

async function pullModel(uri) {
  return downloadModel(uri);
}

async function speedTest(modelPath) {
  const start = Date.now();
  let tokenCount = 0;

  await chatStream(modelPath, [
    { role: 'user', content: 'Say hello in one sentence.' }
  ], {
    onTextChunk: () => { tokenCount++; }
  });

  const elapsed = (Date.now() - start) / 1000;
  if (tokenCount === 0) {
    tokenCount = 1;
  }
  return { tokensPerSecond: tokenCount / elapsed, elapsed, tokens: tokenCount };
}

function isModelAvailable(localModels, uri) {
  // Extract the expected filename pattern from the HuggingFace URI
  // e.g. hf:bartowski/Phi-3.5-mini-instruct-GGUF:Q4_K_M
  // The downloaded file will contain parts of the repo name
  const parts = uri.split(':');
  const repoPath = parts[1] || '';
  const repoName = repoPath.split('/')[1] || '';

  return localModels.some(m => {
    const name = m.name.toLowerCase();
    const search = repoName.toLowerCase().replace(/-gguf$/, '');
    return name.includes(search);
  });
}

export async function autoSelect(onProgress = () => {}) {
  const ramGB = getSystemRamGB();
  onProgress({ step: 'ram', ramGB });

  const models = listLocalModels();

  // Only consider models that fit in available RAM, smallest first
  // so the fastest model that passes the speed test becomes the default
  const candidates = MODEL_TIERS.filter(t => ramGB >= t.minRam).reverse();

  if (candidates.length === 0) {
    // Even the smallest model requires more RAM than available — try it anyway
    candidates.push(MODEL_TIERS[MODEL_TIERS.length - 1]);
  }

  for (const candidate of candidates) {
    try {
      let modelPath;

      if (!isModelAvailable(models, candidate.uri)) {
        onProgress({ step: 'pulling', model: candidate.name });
        modelPath = await pullModel(candidate.uri);
      } else {
        // Find the existing model file
        const match = models.find(m => {
          const name = m.name.toLowerCase();
          const repoName = (candidate.uri.split(':')[1] || '').split('/')[1] || '';
          const search = repoName.toLowerCase().replace(/-gguf$/, '');
          return name.includes(search);
        });
        modelPath = match.path;
      }

      onProgress({ step: 'testing', model: candidate.name });
      const result = await speedTest(modelPath);

      if (result.tokensPerSecond >= 5) {
        const modelId = pathToModelId(modelPath);
        setSelectedModel(modelId);
        const finalResult = {
          model: candidate.name,
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

  // Last resort — use any locally available candidate without speed test,
  // preferring smaller models. Fall back to downloading the smallest.
  for (const candidate of [...candidates].reverse()) {
    if (isModelAvailable(models, candidate.uri)) {
      const match = models.find(m => {
        const name = m.name.toLowerCase();
        const repoName = (candidate.uri.split(':')[1] || '').split('/')[1] || '';
        const search = repoName.toLowerCase().replace(/-gguf$/, '');
        return name.includes(search);
      });
      const modelId = pathToModelId(match.path);
      setSelectedModel(modelId);
      const finalResult = { model: candidate.name, ramGB, speed: null, fallback: true };
      onProgress({ step: 'result', ...finalResult });
      return finalResult;
    }
  }

  // Nothing available locally — download the smallest candidate
  const lastResort = candidates[candidates.length - 1];
  try {
    onProgress({ step: 'pulling', model: lastResort.name });
    const modelPath = await pullModel(lastResort.uri);
    const modelId = pathToModelId(modelPath);
    setSelectedModel(modelId);
    const finalResult = { model: lastResort.name, ramGB, speed: null, fallback: true };
    onProgress({ step: 'result', ...finalResult });
    return finalResult;
  } catch (err) {
    throw new Error(`Could not download any model. Last tried: ${lastResort.name}. Error: ${err.message}`);
  }
}
