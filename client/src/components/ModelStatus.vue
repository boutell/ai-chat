<template>
  <div class="d-flex align-center mr-4">
    <!-- During auto-select: show progress -->
    <v-chip
      v-if="store.autoSelecting"
      size="small"
      color="info"
      variant="tonal"
    >
      <v-progress-circular
        indeterminate
        size="14"
        width="2"
        class="mr-2"
      />
      {{ store.autoSelectProgress }}
    </v-chip>

    <!-- Ollama disconnected: red chip, no menu -->
    <v-chip
      v-else-if="!store.modelStatus.ollamaConnected"
      size="small"
      color="error"
      variant="tonal"
    >
      <v-icon start size="x-small">mdi-circle-outline</v-icon>
      No model
    </v-chip>

    <!-- Connected with models: clickable menu -->
    <v-menu v-else>
      <template v-slot:activator="{ props }">
        <v-chip
          v-bind="props"
          size="small"
          color="success"
          variant="tonal"
          style="cursor: pointer"
        >
          <v-icon start size="x-small">mdi-circle</v-icon>
          {{ store.modelStatus.selectedModel || 'No model' }}
          <v-icon end size="x-small">mdi-menu-down</v-icon>
        </v-chip>
      </template>
      <v-list density="compact">
        <v-list-item
          v-for="model in store.modelStatus.available"
          :key="model"
          @click="store.selectModel(model)"
        >
          <template v-slot:prepend>
            <v-icon v-if="model === store.modelStatus.selectedModel" size="small">mdi-check</v-icon>
            <div v-else style="width: 24px" />
          </template>
          <v-list-item-title>{{ model }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
  </div>
</template>

<script setup>
import { useChatStore } from '../stores/chat.js';

const store = useChatStore();
</script>
