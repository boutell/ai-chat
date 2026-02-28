const { getSelectedModel, setSelectedModel, listModels, autoSelect } = require('../lib/model-selector');

async function ollamaPlugin(fastify, opts) {
  // Get current model status
  fastify.get('/status', async (request, reply) => {
    try {
      const model = getSelectedModel();
      const models = await listModels();
      return {
        selectedModel: model,
        available: models.map(m => m.name),
        ollamaConnected: true
      };
    } catch (err) {
      return {
        selectedModel: getSelectedModel(),
        available: [],
        ollamaConnected: false,
        error: err.message
      };
    }
  });

  // List available models
  fastify.get('/available', async (request, reply) => {
    try {
      const models = await listModels();
      return models;
    } catch (err) {
      return reply.code(503).send({ error: 'Cannot reach ollama: ' + err.message });
    }
  });

  // Auto-select model
  fastify.post('/auto-select', async (request, reply) => {
    try {
      const result = await autoSelect();
      return result;
    } catch (err) {
      return reply.code(500).send({ error: 'Auto-select failed: ' + err.message });
    }
  });

  // Manual model selection
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
    setSelectedModel(request.body.model);
    return { selectedModel: request.body.model };
  });
}

module.exports = ollamaPlugin;
