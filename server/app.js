const express = require('express');
const cors = require('cors');
const chatsRouter = require('./routes/chats');
const ollamaRouter = require('./routes/ollama');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/chats', chatsRouter);
app.use('/api/models', ollamaRouter);

// Start server only when run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
