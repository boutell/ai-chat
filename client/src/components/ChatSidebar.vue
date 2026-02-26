<template>
  <div class="d-flex flex-column h-100">
    <div class="pa-3">
      <v-btn block color="primary" prepend-icon="mdi-plus" @click="newChat">
        New Chat
      </v-btn>
    </div>

    <v-divider />

    <v-list density="compact" nav class="flex-grow-1 overflow-y-auto">
      <v-list-item
        v-for="chat in store.chats"
        :key="chat.id"
        :active="chat.id === store.currentChatId"
        @click="store.loadChat(chat.id)"
        :title="chat.title"
        :subtitle="formatDate(chat.updated_at)"
      >
        <template #append>
          <v-btn
            icon="mdi-delete-outline"
            size="x-small"
            variant="text"
            @click.stop="store.deleteChat(chat.id)"
          />
        </template>
      </v-list-item>
    </v-list>
  </div>
</template>

<script setup>
import { useChatStore } from '../stores/chat.js';

const store = useChatStore();

async function newChat() {
  await store.createChat();
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
</script>
