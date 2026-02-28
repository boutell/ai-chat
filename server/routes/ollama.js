const express = require('express');
const router = express.Router();
const { getSelectedModel, setSelectedModel, listModels, autoSelect } = require('../lib/model-selector');

// Get current model status
router.get('/status', async (req, res) => {
  try {
    const model = getSelectedModel();
    const models = await listModels();
    res.json({
      selectedModel: model,
      available: models.map(m => m.name),
      ollamaConnected: true
    });
  } catch (err) {
    res.json({
      selectedModel: getSelectedModel(),
      available: [],
      ollamaConnected: false,
      error: err.message
    });
  }
});

// List available models
router.get('/available', async (req, res) => {
  try {
    const models = await listModels();
    res.json(models);
  } catch (err) {
    res.status(503).json({ error: 'Cannot reach ollama: ' + err.message });
  }
});

// Auto-select model
router.post('/auto-select', async (req, res) => {
  try {
    const result = await autoSelect();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Auto-select failed: ' + err.message });
  }
});

// Manual model selection
router.post('/select', (req, res) => {
  const model = req.body.model;
  if (!model || typeof model !== 'string') return res.status(400).json({ error: 'Model name must be a non-empty string' });
  setSelectedModel(model);
  res.json({ selectedModel: model });
});

module.exports = router;
