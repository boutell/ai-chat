import { execFile, spawn } from 'child_process';
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const IMAGES = {
  python: 'docker.io/library/python:3-slim',
  javascript: 'docker.io/library/node:22-slim',
  bash: 'docker.io/library/bash:5'
};

let runtime = null;
let detected = false;

// Test overrides
let isAvailableOverride = null;
let runCodeOverride = null;

export function _setIsAvailableOverride(fn) {
  isAvailableOverride = fn;
}

export function _setRunCodeOverride(fn) {
  runCodeOverride = fn;
}

async function detectRuntime() {
  if (detected) {
    return runtime;
  }
  detected = true;
  for (const cmd of ['docker', 'podman']) {
    try {
      await execPromise(cmd, ['--version']);
    } catch {
      continue;
    }
    // Binary exists — verify it can actually run containers
    try {
      await execPromise(cmd, ['info']);
      runtime = cmd;
      return runtime;
    } catch {
      // On macOS, podman needs a VM ("machine"). Try to start or create one.
      if (cmd === 'podman') {
        if (await ensurePodmanMachine()) {
          runtime = cmd;
          return runtime;
        }
      }
    }
  }
  return null;
}

async function ensurePodmanMachine() {
  // Try starting an existing machine first
  try {
    await execPromise('podman', ['machine', 'start'], 120000);
    await execPromise('podman', ['info']);
    return true;
  } catch {
    // Machine might not exist yet
  }
  // Create and start a new machine
  try {
    await execPromise('podman', ['machine', 'init'], 120000);
    await execPromise('podman', ['machine', 'start'], 120000);
    await execPromise('podman', ['info']);
    return true;
  } catch {
    return false;
  }
}

function execPromise(cmd, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function isAvailable() {
  if (isAvailableOverride) {
    return isAvailableOverride();
  }
  await detectRuntime();
  return runtime !== null;
}

const LANG_CONFIG = {
  python: { ext: '.py', cmd: ['python3'] },
  javascript: { ext: '.js', cmd: ['node'] },
  bash: { ext: '.sh', cmd: ['bash'] }
};

export async function runCode(language, code, { timeout = 30000 } = {}) {
  if (runCodeOverride) {
    return runCodeOverride(language, code, { timeout });
  }
  await detectRuntime();
  if (!runtime) {
    return { stdout: '', stderr: 'No container runtime available', exitCode: 1, timedOut: false };
  }

  const config = LANG_CONFIG[language];
  if (!config) {
    return { stdout: '', stderr: `Unsupported language: ${language}`, exitCode: 1, timedOut: false };
  }

  // For Python: if the code looks like a bare expression (no print, no assignment,
  // no import, no def, etc.), wrap it in print() so the result appears in stdout
  let finalCode = code;
  if (language === 'python') {
    finalCode = autoPrintPython(code);
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'ai-chat-code-'));
  const filename = `code${config.ext}`;
  const hostPath = path.join(tmpDir, filename);
  await writeFile(hostPath, finalCode);

  const containerPath = `/tmp/${filename}`;
  const args = [
    'run', '--rm',
    '--network', 'none',
    '--memory', '256m',
    '--cpus', '1',
    '--read-only',
    '--tmpfs', '/tmp:size=64m,exec',
    '-v', `${hostPath}:${containerPath}:ro`,
    IMAGES[language],
    ...config.cmd, containerPath
  ];

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let timedOut = false;

  try {
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        timedOut = true;
        proc.kill('SIGKILL');
        // Also try to force-kill via the runtime in case SIGKILL doesn't reach the container
        try {
          execFile(runtime, ['kill', proc.pid?.toString()], () => {});
        } catch {
          // best effort
        }
      }, timeout);

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({ exitCode: 137 });
        } else {
          resolve({ exitCode: code ?? 1 });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    exitCode = result.exitCode;
  } catch (err) {
    stderr = err.message;
    exitCode = 1;
  } finally {
    // Clean up temp file
    try {
      await unlink(hostPath);
      const { rmdir } = await import('fs/promises');
      await rmdir(tmpDir);
    } catch {
      // best effort cleanup
    }
  }

  // Truncate output to avoid sending huge results back to the model
  const MAX_OUTPUT = 10000;
  if (stdout.length > MAX_OUTPUT) {
    stdout = stdout.slice(0, MAX_OUTPUT) + '\n... (output truncated)';
  }
  if (stderr.length > MAX_OUTPUT) {
    stderr = stderr.slice(0, MAX_OUTPUT) + '\n... (output truncated)';
  }

  return { stdout, stderr, exitCode, timedOut };
}

// Keywords/prefixes that indicate a line is a statement, not an expression
const STATEMENT_PREFIXES = [
  'print', 'import ', 'from ', 'def ', 'class ', 'for ', 'while ',
  'if ', 'try:', 'with ', 'return ', 'raise ', 'assert ', 'del ',
  'pass', 'break', 'continue', 'yield ', 'async ', 'await ', 'global ',
  'nonlocal ', 'elif ', 'else:', 'except', 'finally:'
];

function looksLikeExpression(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return false;
  }
  for (const prefix of STATEMENT_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return false;
    }
  }
  // Assignment (but not ==, !=, <=, >=)
  if (/[^!=<>]=[^=]/.test(trimmed)) {
    return false;
  }
  // Augmented assignment (+=, -=, etc.)
  if (/[+\-*/%&|^]+=/.test(trimmed)) {
    return false;
  }
  return true;
}

// If Python code has no print() calls and the last line is a bare expression,
// wrap it in print(). This mimics REPL behavior for scripts.
function autoPrintPython(code) {
  const trimmed = code.trim();
  const lines = trimmed.split('\n');

  // Single-line: wrap the whole thing if it's an expression
  if (lines.length === 1) {
    if (looksLikeExpression(trimmed)) {
      return `print(${trimmed})`;
    }
    return code;
  }

  // Multi-line: if the script already has print() calls, leave it alone
  if (/\bprint\s*\(/.test(trimmed)) {
    return code;
  }

  // Check if the last non-empty line is a bare expression
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx].trim()) {
    lastIdx--;
  }
  if (lastIdx < 0) {
    return code;
  }

  const lastLine = lines[lastIdx];
  const indent = lastLine.match(/^(\s*)/)[1];

  // Only wrap if the last line is at the top indentation level (not inside a block)
  // and looks like an expression
  if (indent.length === 0 && looksLikeExpression(lastLine)) {
    lines[lastIdx] = `print(${lastLine.trim()})`;
    return lines.join('\n');
  }

  return code;
}

// Exported for testing
export { autoPrintPython as _autoPrintPython };
