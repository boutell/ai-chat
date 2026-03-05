import { defineChatSessionFunction } from 'node-llama-cpp';
import { runCode, isAvailable as isContainerAvailable } from './container.js';
import { search as webSearch, isAvailable as isWebSearchAvailable } from './web-search.js';

export async function getChatFunctions(onToolEvent) {
  const functions = {};
  const containerAvailable = await isContainerAvailable();
  const webSearchAvailable = isWebSearchAvailable();

  if (!containerAvailable && !webSearchAvailable) {
    return null;
  }

  if (containerAvailable) {
    functions.run_code = defineChatSessionFunction({
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
    });
  }

  if (webSearchAvailable) {
    functions.web_search = defineChatSessionFunction({
      description: 'Search the web for current information, news, facts, or data',
      params: {
        type: 'object',
        properties: {
          query: {
            type: 'string'
          }
        }
      },
      async handler({ query }) {
        if (onToolEvent) {
          onToolEvent({ type: 'toolCall', name: 'web_search', query });
        }

        try {
          const { results, answer } = await webSearch(query);

          if (onToolEvent) {
            onToolEvent({
              type: 'toolResult',
              name: 'web_search',
              results,
              answer
            });
          }

          // Format for the model
          let response = '';
          if (answer) {
            response += `Answer: ${answer}\n\n`;
          }
          if (results.length > 0) {
            response += 'Sources:\n';
            results.forEach((r, i) => {
              response += `${i + 1}. ${r.title} - ${r.url}\n   ${r.content}\n`;
            });
          } else {
            response = 'No results found.';
          }
          return response;
        } catch (err) {
          if (onToolEvent) {
            onToolEvent({
              type: 'toolResult',
              name: 'web_search',
              results: [],
              answer: null,
              error: err.message
            });
          }
          return `Search failed: ${err.message}`;
        }
      }
    });
  }

  return functions;
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
