<template>
  <v-app>
    <v-app-bar density="compact" color="surface">
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-app-bar-title>AI Chat</v-app-bar-title>
      <ModelStatus />
    </v-app-bar>

    <v-navigation-drawer v-model="drawer" width="300">
      <ChatSidebar @select-chat="drawer = false" />
    </v-navigation-drawer>

    <v-main>
      <ChatWindow />
    </v-main>
  </v-app>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useChatStore } from './stores/chat.js';
import ChatSidebar from './components/ChatSidebar.vue';
import ChatWindow from './components/ChatWindow.vue';
import ModelStatus from './components/ModelStatus.vue';

const drawer = ref(true);
const store = useChatStore();

onMounted(async () => {
  await store.fetchChats();
  await store.fetchModelStatus();

  // Auto-select model if none selected
  if (!store.modelStatus.selectedModel) {
    store.autoSelectModel();
  }
});
</script>

<style>
/* Override Vuetify's html { overflow-y: scroll } — v-main handles scrolling.
   :root adds pseudo-class specificity (0,1,1) to beat Vuetify's plain
   element selector (0,0,1) without needing !important. */
html:root {
  overflow-y: hidden;
}
</style>

<style scoped>
:deep(.v-main) {
  flex: 1 1 0;
  overflow-y: auto;
}
</style>
