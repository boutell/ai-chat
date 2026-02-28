<template>
  <div class="chat-window d-flex flex-column" style="height: 100%">
    <!-- Empty state -->
    <div v-if="!store.currentChatId" class="d-flex align-center justify-center flex-grow-1">
      <div class="text-center text-medium-emphasis">
        <v-icon size="64" class="mb-4">mdi-chat-outline</v-icon>
        <div class="text-h6">Start a new conversation</div>
        <div class="text-body-2">Click "New Chat" or just type a message below</div>
      </div>
    </div>

    <!-- Messages -->
    <div v-else ref="messagesContainer" class="flex-grow-1 overflow-y-auto pa-4">
      <MessageBubble
        v-for="(msg, i) in store.currentMessages"
        :key="i"
        :message="msg"
        :streaming="store.streaming && i === store.currentMessages.length - 1 && msg.role === 'assistant'"
      />
    </div>

    <!-- Input -->
    <div class="pa-4 pt-2">
      <v-textarea
        v-model="input"
        placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
        variant="outlined"
        rows="1"
        max-rows="6"
        auto-grow
        hide-details
        density="comfortable"
        @keydown="handleKeydown"
        :disabled="store.streaming"
      >
        <template #append-inner>
          <v-btn
            v-if="store.streaming"
            icon="mdi-stop-circle"
            size="small"
            variant="text"
            color="red"
            @click="store.stopStreaming()"
          />
          <v-btn
            v-else
            icon="mdi-send"
            size="small"
            variant="text"
            :disabled="!input.trim()"
            @click="send"
          />
        </template>
      </v-textarea>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import { useChatStore } from '../stores/chat.js';
import MessageBubble from './MessageBubble.vue';

const store = useChatStore();
const input = ref('');
const messagesContainer = ref(null);

function handleKeydown(e) {
  if (e.key === 'Escape' && store.streaming) {
    e.preventDefault();
    store.stopStreaming();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

async function send() {
  const text = input.value.trim();
  if (!text || store.streaming) return;
  input.value = '';
  await store.sendMessage(text);
}

// Auto-scroll on new messages
watch(
  () => store.currentMessages.length > 0 ? store.currentMessages[store.currentMessages.length - 1].content : '',
  async () => {
    await nextTick();
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  }
);
</script>
