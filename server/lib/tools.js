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

  // Track the last tool result so show_output can reference it
  let lastToolResult = null;

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

        lastToolResult = {
          name: 'run_code',
          stdout: result.stdout,
          stderr: cleanStderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut
        };

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

          lastToolResult = {
            name: 'web_search',
            results,
            answer
          };

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

  // show_output: inject tool output directly into the response without
  // the model having to reproduce it token-by-token
  functions.show_output = defineChatSessionFunction({
    description: 'Display the output from the most recent tool call directly to the user. Use this instead of copying large outputs (tables, charts, data) into your response. The output appears instantly in your message.',
    params: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          enum: ['stdout', 'stderr', 'all']
        },
        format: {
          type: 'string',
          enum: ['plain', 'code']
        }
      }
    },
    handler({ content = 'stdout', format = 'plain' }) {
      if (!lastToolResult) {
        return '(no previous tool output to display)';
      }

      let text = '';
      if (lastToolResult.name === 'run_code') {
        if (content === 'stdout' || content === 'all') {
          text += lastToolResult.stdout || '';
        }
        if (content === 'stderr' || content === 'all') {
          if (text && lastToolResult.stderr) {
            text += '\n';
          }
          text += lastToolResult.stderr || '';
        }
      } else if (lastToolResult.name === 'web_search') {
        if (lastToolResult.answer) {
          text += lastToolResult.answer + '\n\n';
        }
        for (const r of (lastToolResult.results || [])) {
          text += `${r.title} - ${r.url}\n${r.content}\n\n`;
        }
      }

      if (!text.trim()) {
        return '(tool output was empty)';
      }

      if (format === 'code') {
        text = '```\n' + text + '\n```';
      }

      if (onToolEvent) {
        onToolEvent({ type: 'inject', text });
      }

      return '(output displayed to user)';
    }
  });

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
