import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { get, post, del, postStream } from '../api.js';

export const useChatStore = defineStore('chat', () => {
  const chats = ref([]);
  const currentChatId = ref(null);
  const currentMessages = ref([]);
  const streaming = ref(false);
  const stoppedByUser = ref(false);
  const modelStatus = ref({ selectedModel: null, available: [] });
  const autoSelecting = ref(false);
  const autoSelectProgress = ref('');
  const downloading = ref(false);
  const downloadProgress = ref('');

  let abortController = null;

  const currentChat = computed(() => chats.value.find(c => c.id === currentChatId.value));
  const modelBusy = computed(() => autoSelecting.value || downloading.value || !modelStatus.value.selectedModel);

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
    stoppedByUser.value = false;
    abortController = new AbortController();

    try {
      const res = await postStream(`/api/chats/${currentChatId.value}/messages`, { content }, { signal: abortController.signal });
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
      if (err.name === 'AbortError') {
        stoppedByUser.value = true;
        assistantMsg.content += ' *(stopped)*';
      } else {
        assistantMsg.content += `\n\n**Error:** ${err.message}`;
      }
    } finally {
      streaming.value = false;
      abortController = null;
    }
  }

  async function fetchModelStatus() {
    try {
      modelStatus.value = await get('/api/models/status');
    } catch {
      modelStatus.value = { selectedModel: null, available: [] };
    }
  }

  async function autoSelectModel() {
    autoSelecting.value = true;
    autoSelectProgress.value = 'Starting auto-select...';
    try {
      const res = await postStream('/api/models/auto-select');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              await fetchModelStatus();
              return;
            }
            try {
              const event = JSON.parse(data);
              if (event.step === 'ram') {
                autoSelectProgress.value = `${event.ramGB}GB RAM detected`;
              } else if (event.step === 'pulling') {
                autoSelectProgress.value = `Downloading ${event.model}...`;
              } else if (event.step === 'testing') {
                autoSelectProgress.value = `Testing ${event.model}...`;
              } else if (event.step === 'result') {
                autoSelectProgress.value = event.model;
                await fetchModelStatus();
              } else if (event.error) {
                autoSelectProgress.value = `Error: ${event.error}`;
              }
            } catch {
              // skip malformed SSE
            }
          }
        }
      }
    } catch (err) {
      console.warn('Auto-select failed:', err.message);
      autoSelectProgress.value = `Error: ${err.message}`;
    } finally {
      autoSelecting.value = false;
    }
  }

  function stopStreaming() {
    if (abortController) {
      abortController.abort();
    }
  }

  async function selectModel(id) {
    // Find the model to check if it needs downloading
    const model = modelStatus.value.available?.find(m => m.id === id);
    const needsDownload = model && !model.downloaded;

    if (needsDownload) {
      downloading.value = true;
      downloadProgress.value = `Downloading ${model.name}...`;
    }

    try {
      const res = await postStream('/api/models/select', { model: id });
      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        // SSE download stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                await fetchModelStatus();
                return;
              }
              try {
                const event = JSON.parse(data);
                if (event.step === 'downloading') {
                  downloading.value = true;
                  downloadProgress.value = `Downloading ${event.model}...`;
                } else if (event.error) {
                  console.warn('Model download failed:', event.error);
                }
              } catch {
                // skip malformed SSE
              }
            }
          }
        }
      } else {
        // Quick JSON response (already downloaded)
        const data = await res.json();
        if (!res.ok) {
          console.warn('Model selection failed:', data.error);
        }
      }
      await fetchModelStatus();
    } catch (err) {
      console.warn('Model selection failed:', err.message);
    } finally {
      downloading.value = false;
    }
  }

  return {
    chats,
    currentChatId,
    currentMessages,
    currentChat,
    streaming,
    stoppedByUser,
    modelStatus,
    autoSelecting,
    autoSelectProgress,
    downloading,
    downloadProgress,
    modelBusy,
    fetchChats,
    loadChat,
    createChat,
    deleteChat,
    sendMessage,
    stopStreaming,
    fetchModelStatus,
    autoSelectModel,
    selectModel
  };
});
