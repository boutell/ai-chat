#!/usr/bin/env node

// Deletes all downloaded model files and clears the selected model setting.

import { readdirSync, unlinkSync } from 'fs';
import path from 'path';
import envPaths from 'env-paths';
import db from './db.js';

const modelsDir = path.join(envPaths('ai-chat').data, 'models');

let count = 0;
try {
  const files = readdirSync(modelsDir).filter(f => f.endsWith('.gguf'));
  for (const file of files) {
    const filePath = path.join(modelsDir, file);
    unlinkSync(filePath);
    console.log(`Deleted: ${file}`);
    count++;
  }
} catch {
  // directory may not exist
}

db.prepare('DELETE FROM settings WHERE key = ?').run('selected_model');

if (count > 0) {
  console.log(`\nRemoved ${count} model file(s). Auto-detect will download a fresh model on next page load.`);
} else {
  console.log('No model files found.');
}
