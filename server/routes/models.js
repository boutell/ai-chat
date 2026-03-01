import { getSelectedModel, setSelectedModel, clearSelectedModel, autoSelect, getDisplayName, listAvailableModels, findTierUri, pathToModelId } from '../lib/model-selector.js';
import { resolveModelId, downloadModel } from '../lib/llm.js';

async function modelsPlugin(fastify, opts) {
  // Get current model status
  fastify.get('/status', async (request, reply) => {
    const selectedModel = getSelectedModel();
    const available = listAvailableModels();
    return {
      selectedModel,
      selectedModelName: selectedModel ? getDisplayName(selectedModel) : null,
      available
    };
  });

  // List available models
  fastify.get('/available', async (request, reply) => {
    return listAvailableModels();
  });

  // Auto-select model (SSE progress stream)
  fastify.post('/auto-select', async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    try {
      await autoSelect((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });

  // Clear selected model (for testing / reset)
  fastify.delete('/selected', async (request, reply) => {
    clearSelectedModel();
    return { success: true };
  });

  // Manual model selection — SSE stream that downloads if needed
  fastify.post('/select', {
    schema: {
      body: {
        type: 'object',
        required: ['model'],
        properties: {
          model: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const id = request.body.model;

    // Already downloaded? Quick path — no SSE needed
    let modelPath = resolveModelId(id);
    if (modelPath) {
      setSelectedModel(id);
      return { selectedModel: id, selectedModelName: getDisplayName(id) };
    }

    // Not downloaded — check if it's a known tier model URI
    const uri = findTierUri(id);
    if (!uri) {
      return reply.code(404).send({ error: `Model not found: ${id}` });
    }

    // Download via SSE so it doesn't time out
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    try {
      res.write(`data: ${JSON.stringify({ step: 'downloading', model: getDisplayName(id) })}\n\n`);
      modelPath = await downloadModel(uri);
      const newId = pathToModelId(modelPath);
      setSelectedModel(newId);
      res.write(`data: ${JSON.stringify({ step: 'done', selectedModel: newId, selectedModelName: getDisplayName(newId) })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

export default modelsPlugin;
