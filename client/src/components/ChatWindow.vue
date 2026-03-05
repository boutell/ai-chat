<template>
  <div class="chat-window" ref="rootEl">
    <!-- Empty state -->
    <div v-if="!store.currentChatId" class="empty-state d-flex align-center justify-center">
      <div class="text-center text-medium-emphasis">
        <v-icon size="64" class="mb-4">mdi-chat-outline</v-icon>
        <div class="text-h6">Start a new conversation</div>
        <div class="text-body-2">Click "New Chat" or just type a message below</div>
      </div>
    </div>

    <template v-else>
      <!-- Messages -->
      <div ref="messagesContainer" class="pa-4">
        <MessageBubble
          v-for="(msg, i) in store.currentMessages"
          :key="i"
          :message="msg"
          :streaming="store.streaming && i === store.currentMessages.length - 1 && msg.role === 'assistant'"
        />
      </div>
    </template>

    <!-- Input -->
    <div class="chat-input pa-4 pt-2">
      <div class="d-flex align-end ga-2">
        <v-textarea
          v-model="input"
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          variant="outlined"
          rows="1"
          max-rows="6"
          auto-grow
          hide-details
          density="comfortable"
          class="flex-grow-1"
          @keydown="handleKeydown"
          :disabled="store.streaming || store.modelBusy"
        >
          <template #append-inner>
            <v-btn
              v-if="!store.streaming"
              icon="mdi-send"
              size="small"
              variant="text"
              :disabled="!input.trim()"
              @click="send"
            />
          </template>
        </v-textarea>
        <v-btn
          v-if="store.streaming"
          icon="mdi-stop-circle"
          size="small"
          variant="tonal"
          color="error"
          @click="store.stopStreaming()"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useChatStore } from '../stores/chat.js';
import MessageBubble from './MessageBubble.vue';

const store = useChatStore();
const input = ref('');
const messagesContainer = ref(null);
const rootEl = ref(null);

function getScrollContainer() {
  return rootEl.value?.closest('.v-main');
}

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
  if (!text || store.streaming || store.modelBusy) {
    return;
  }
  input.value = '';
  await store.sendMessage(text);
}

// Track whether the user is scrolled to the bottom
const isAtBottom = ref(true);

function onScroll() {
  const el = getScrollContainer();
  if (!el) {
    return;
  }
  // Consider "at bottom" if within 40px of the end
  isAtBottom.value = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
}

// Auto-scroll only if the user was already at the bottom
watch(
  () => store.currentMessages.length > 0 ? store.currentMessages[store.currentMessages.length - 1].content : '',
  async () => {
    if (!isAtBottom.value) {
      return;
    }
    await nextTick();
    const el = getScrollContainer();
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
);

onMounted(() => {
  nextTick(() => {
    const el = getScrollContainer();
    if (el) {
      el.addEventListener('scroll', onScroll);
    }
  });
});

onBeforeUnmount(() => {
  const el = getScrollContainer();
  if (el) {
    el.removeEventListener('scroll', onScroll);
  }
});
</script>

<style scoped>
.chat-window {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.empty-state {
  flex: 1 1 auto;
}

.chat-input {
  position: sticky;
  bottom: 0;
  background: rgb(var(--v-theme-surface));
  margin-top: auto;
}
</style>
