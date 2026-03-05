import { isAvailable } from '../lib/container.js';

async function toolsPlugin(fastify, opts) {
  fastify.get('/status', async (request, reply) => {
    return { containerAvailable: await isAvailable() };
  });
}

export default toolsPlugin;
