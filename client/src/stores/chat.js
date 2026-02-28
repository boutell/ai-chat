import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { get, post, del, postStream } from '../api.js';

export const useChatStore = defineStore('chat', () => {
  const chats = ref([]);
  const currentChatId = ref(null);
  const currentMessages = ref([]);
  const streaming = ref(false);
  const modelStatus = ref({ selectedModel: null, ollamaConnected: false, available: [] });

  const currentChat = computed(() => chats.value.find(c => c.id === currentChatId.value));

  async function fetchChats() {
    chats.value = await get('/api/chats');
  }

  async function loadChat(id) {
    currentChatId.value = id;
    const data = await get(`/api/chats/${id}`);
    currentMessages.value = data.messages || [];
  }

  async function createChat() {
    const chat = await post('/api/chats');
    chats.value.unshift(chat);
    currentChatId.value = chat.id;
    currentMessages.value = [];
    return chat;
  }

  async function deleteChat(id) {
    await del(`/api/chats/${id}`);
    chats.value = chats.value.filter(c => c.id !== id);
    if (currentChatId.value === id) {
      currentChatId.value = null;
      currentMessages.value = [];
    }
  }

  async function sendMessage(content) {
    if (!currentChatId.value) {
      await createChat();
    }

    // Add user message locally
    currentMessages.value.push({ role: 'user', content });

    // Add placeholder for assistant — must reference through the reactive
    // array so Vue tracks mutations to .content for rendering
    currentMessages.value.push({ role: 'assistant', content: '' });
    const assistantMsg = currentMessages.value[currentMessages.value.length - 1];
    streaming.value = true;

    try {
      const res = await postStream(`/api/chats/${currentChatId.value}/messages`, { content });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              streaming.value = false;
              fetchChats();
              return;
            }
            try {
              const json = JSON.parse(data);
              if (json.token) {
                assistantMsg.content += json.token;
              }
              if (json.error) {
                assistantMsg.content += `\n\n**Error:** ${json.error}`;
              }
            } catch {
              // skip malformed SSE
            }
          }
        }
      }
    } catch (err) {
      assistantMsg.content += `\n\n**Error:** ${err.message}`;
    } finally {
      streaming.value = false;
    }
  }

  async function fetchModelStatus() {
    try {
      modelStatus.value = await get('/api/models/status');
    } catch {
      modelStatus.value = { selectedModel: null, ollamaConnected: false, available: [] };
    }
  }

  async function autoSelectModel() {
    try {
      const data = await post('/api/models/auto-select');
      await fetchModelStatus();
      return data;
    } catch (err) {
      console.warn('Auto-select failed:', err.message);
      return { error: err.message };
    }
  }

  return {
    chats,
    currentChatId,
    currentMessages,
    currentChat,
    streaming,
    modelStatus,
    fetchChats,
    loadChat,
    createChat,
    deleteChat,
    sendMessage,
    fetchModelStatus,
    autoSelectModel
  };
});
