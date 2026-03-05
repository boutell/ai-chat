import { isAvailable as isContainerAvailable } from '../lib/container.js';
import { isAvailable as isWebSearchAvailable } from '../lib/web-search.js';

async function toolsPlugin(fastify, opts) {
  fastify.get('/status', async (request, reply) => {
    return {
      containerAvailable: await isContainerAvailable(),
      webSearchAvailable: isWebSearchAvailable()
    };
  });
}

export default toolsPlugin;
