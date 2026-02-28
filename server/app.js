const Fastify = require('fastify');
const cors = require('@fastify/cors');
const chatsPlugin = require('./routes/chats');
const ollamaPlugin = require('./routes/ollama');

async function buildApp() {
  const fastify = Fastify();

  await fastify.register(cors);
  await fastify.register(chatsPlugin, { prefix: '/api/chats' });
  await fastify.register(ollamaPlugin, { prefix: '/api/models' });

  return fastify;
}

// Start server only when run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  buildApp().then(app => {
    app.listen({ port: PORT }, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  });
}

module.exports = buildApp;
