import { getLlama, LlamaChatSession, resolveModelFile } from 'node-llama-cpp';
import envPaths from 'env-paths';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';

const paths = envPaths('ai-chat');
export const MODELS_DIR = path.join(paths.data, 'models');

// Ensure models directory exists
if (!existsSync(MODELS_DIR)) {
  mkdirSync(MODELS_DIR, { recursive: true });
}

let llamaInstance = null;
let loadedModel = null;
let loadedModelPath = null;

// Test overrides
let chatStreamOverride = null;
let downloadModelOverride = null;

export function _setChatStreamOverride(fn) {
  chatStreamOverride = fn;
}

export function _setDownloadModelOverride(fn) {
  downloadModelOverride = fn;
}

async function getLlamaInstance() {
  if (!llamaInstance) {
    llamaInstance = await getLlama();
  }
  return llamaInstance;
}

export async function loadModel(modelPath) {
  if (loadedModelPath === modelPath && loadedModel) {
    return loadedModel;
  }
  if (loadedModel) {
    await loadedModel.dispose();
  }
  const llama = await getLlamaInstance();
  loadedModel = await llama.loadModel({ modelPath });
  loadedModelPath = modelPath;
  return loadedModel;
}

export async function chatStream(modelPath, messages, { onTextChunk, signal } = {}) {
  if (chatStreamOverride) {
    return chatStreamOverride(modelPath, messages, { onTextChunk, signal });
  }

  const model = await loadModel(modelPath);
  const context = await model.createContext({
    contextSize: Math.min(4096, model.trainContextSize)
  });

  try {
    // Separate system prompt from chat history
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const chatMessages = messages.filter(m => m.role !== 'system');

    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt
    });

    // Load prior chat history (all but the last user message)
    const history = chatMessages.slice(0, -1);
    for (let i = 0; i < history.length; i += 2) {
      const userMsg = history[i];
      const assistantMsg = history[i + 1];
      if (userMsg && assistantMsg) {
        session.setChatHistory([
          ...session.getChatHistory(),
          { type: 'user', text: userMsg.content },
          { type: 'model', response: [assistantMsg.content] }
        ]);
      }
    }

    // Get the last user message
    const lastUserMessage = chatMessages[chatMessages.length - 1]?.content || '';

    const response = await session.prompt(lastUserMessage, {
      onTextChunk,
      signal,
      stopOnAbortSignal: true
    });

    return response;
  } finally {
    await context.dispose();
  }
}

export async function chatComplete(modelPath, messages) {
  let fullResponse = '';
  await chatStream(modelPath, messages, {
    onTextChunk: (chunk) => { fullResponse += chunk; }
  });
  return fullResponse;
}

export function listLocalModels() {
  try {
    return readdirSync(MODELS_DIR)
      .filter(f => f.endsWith('.gguf'))
      .map(f => ({
        name: f.replace('.gguf', ''),
        path: path.join(MODELS_DIR, f)
      }));
  } catch {
    return [];
  }
}

// Resolve an opaque model ID to a filesystem path, or null if not found
export function resolveModelId(id) {
  const models = listLocalModels();
  const match = models.find(m => m.name === id);
  return match ? match.path : null;
}

export async function downloadModel(uri) {
  if (downloadModelOverride) {
    return downloadModelOverride(uri);
  }
  return resolveModelFile(uri, MODELS_DIR);
}

export function getModelsDir() {
  return MODELS_DIR;
}
