import { defineChatSessionFunction } from 'node-llama-cpp';
import { runCode, isAvailable } from './container.js';

export async function getChatFunctions(onToolEvent) {
  if (!await isAvailable()) {
    return null;
  }

  return {
    run_code: defineChatSessionFunction({
      description: 'Run code in a sandboxed container and return the output. Available languages: python, javascript, bash. The container has no network access.',
      params: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'javascript', 'bash']
          },
          code: {
            type: 'string'
          }
        }
      },
      async handler({ language, code }) {
        if (onToolEvent) {
          onToolEvent({ type: 'toolCall', name: 'run_code', language, code });
        }

        const result = await runCode(language, code);

        // Filter podman noise from stderr before sending to frontend
        const cleanStderr = filterContainerNoise(result.stderr);

        if (onToolEvent) {
          onToolEvent({
            type: 'toolResult',
            name: 'run_code',
            output: result.stdout,
            stderr: cleanStderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut
          });
        }

        // Format result for the model to read
        let response = '';
        if (result.timedOut) {
          response += 'Execution timed out (30 second limit).\n';
        }
        if (result.stdout) {
          response += `stdout:\n${result.stdout}\n`;
        }
        if (cleanStderr) {
          response += `stderr:\n${cleanStderr}\n`;
        }
        if (!result.stdout && !cleanStderr && !result.timedOut) {
          response = '(no output)';
        }
        if (result.exitCode !== 0) {
          response += `Exit code: ${result.exitCode}\n`;
        }
        return response;
      }
    })
  };
}

function filterContainerNoise(stderr) {
  if (!stderr) {
    return '';
  }
  return stderr.split('\n').filter(line => {
    if (line.startsWith('time=') && line.includes('graph driver')) {
      return false;
    }
    if (line.startsWith('Trying to pull ') || line.startsWith('Getting image source') || line.startsWith('Copying blob') || line.startsWith('Copying config') || line.startsWith('Writing manifest')) {
      return false;
    }
    return line.trim().length > 0;
  }).join('\n');
}
