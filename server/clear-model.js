#!/usr/bin/env node

// Clears the auto-selected model so auto-detect runs again on next startup.

import { getSelectedModel, clearSelectedModel } from './lib/model-selector.js';

const current = getSelectedModel();
if (current) {
  clearSelectedModel();
  console.log(`Cleared selected model: ${current}`);
  console.log('Auto-detect will run on next page load.');
} else {
  console.log('No model currently selected.');
}
