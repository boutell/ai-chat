<template>
  <div class="d-flex align-center mr-4">
    <!-- During auto-select or downloading: show progress -->
    <v-chip
      v-if="store.autoSelecting || store.downloading"
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
      {{ store.downloading ? store.downloadProgress : store.autoSelectProgress }}
    </v-chip>

    <!-- Model selector menu -->
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
          {{ store.modelStatus.selectedModelName || 'No model' }}
          <v-icon end size="x-small">mdi-menu-down</v-icon>
        </v-chip>
      </template>
      <v-list density="compact">
        <v-list-item
          v-for="model in store.modelStatus.available"
          :key="model.id"
          @click="store.selectModel(model.id)"
        >
          <template v-slot:prepend>
            <v-icon v-if="model.id === store.modelStatus.selectedModel" size="small">mdi-check</v-icon>
            <v-icon v-else-if="!model.downloaded" size="small">mdi-download</v-icon>
            <div v-else style="width: 24px" />
          </template>
          <v-list-item-title>{{ model.name }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
  </div>
</template>

<script setup>
import { useChatStore } from '../stores/chat.js';

const store = useChatStore();
</script>
