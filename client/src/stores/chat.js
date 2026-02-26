import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useChatStore = defineStore('chat', () => {
  const chats = ref([]);
  const currentChatId = ref(null);
  const currentMessages = ref([]);
  const streaming = ref(false);
  const modelStatus = ref({ selectedModel: null, ollamaConnected: false, available: [] });

  const currentChat = computed(() => chats.value.find(c => c.id === currentChatId.value));

  async function fetchChats() {
    const res = await fetch('/api/chats');
    chats.value = await res.json();
  }

  async function loadChat(id) {
    currentChatId.value = id;
    const res = await fetch(`/api/chats/${id}`);
    const data = await res.json();
    currentMessages.value = data.messages || [];
  }

  async function createChat() {
    const res = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const chat = await res.json();
    chats.value.unshift(chat);
    currentChatId.value = chat.id;
    currentMessages.value = [];
    return chat;
  }

  async function deleteChat(id) {
    await fetch(`/api/chats/${id}`, { method: 'DELETE' });
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
      const res = await fetch(`/api/chats/${currentChatId.value}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });

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
              // Refresh chat list to get updated title
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
              // skip
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
      const res = await fetch('/api/models/status');
      modelStatus.value = await res.json();
    } catch {
      modelStatus.value = { selectedModel: null, ollamaConnected: false, available: [] };
    }
  }

  async function autoSelectModel() {
    try {
      const res = await fetch('/api/models/auto-select', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        console.warn('Auto-select failed:', data.error);
        return data;
      }
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
