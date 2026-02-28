// Thin wrappers for ollama REST API calls

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';

async function ollamaGet(path) {
  const res = await fetch(`${OLLAMA_BASE}${path}`);
  if (!res.ok) throw new Error(`Ollama ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function ollamaPost(path, body) {
  const res = await fetch(`${OLLAMA_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama ${path}: ${text}`);
  }
  return res.json();
}

// Returns raw Response for streaming
async function ollamaStream(path, body) {
  const res = await fetch(`${OLLAMA_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama ${path}: ${text}`);
  }
  return res;
}

module.exports = { OLLAMA_BASE, ollamaGet, ollamaPost, ollamaStream };
