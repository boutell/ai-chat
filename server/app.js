import Fastify from 'fastify';
import cors from '@fastify/cors';
import { fileURLToPath } from 'url';
import chatsPlugin from './routes/chats.js';
import modelsPlugin from './routes/models.js';
import toolsPlugin from './routes/tools.js';

async function buildApp() {
  const fastify = Fastify();

  await fastify.register(cors);
  await fastify.register(chatsPlugin, { prefix: '/api/chats' });
  await fastify.register(modelsPlugin, { prefix: '/api/models' });
  await fastify.register(toolsPlugin, { prefix: '/api/tools' });

  return fastify;
}

// Start server only when run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT || 3000;
  buildApp().then(app => {
    app.listen({ port: PORT }, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  });
}

export default buildApp;
