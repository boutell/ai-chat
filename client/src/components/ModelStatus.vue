<template>
  <div class="d-flex align-center mr-4">
    <v-chip
      size="small"
      :color="store.modelStatus.ollamaConnected ? 'success' : 'error'"
      variant="tonal"
    >
      <v-icon start size="x-small">
        {{ store.modelStatus.ollamaConnected ? 'mdi-circle' : 'mdi-circle-outline' }}
      </v-icon>
      {{ store.modelStatus.selectedModel || 'No model' }}
    </v-chip>
  </div>
</template>

<script setup>
import { useChatStore } from '../stores/chat.js';

const store = useChatStore();
</script>
