<template>
  <div :class="['message-bubble', 'mb-3', message.role === 'user' ? 'd-flex justify-end' : '']">
    <v-card
      :color="message.role === 'user' ? 'primary' : 'surface'"
      :class="[message.role === 'user' ? 'user-message' : 'assistant-message']"
      :max-width="message.role === 'user' ? '75%' : '100%'"
      variant="flat"
    >
      <v-card-text class="pa-3">
        <!-- Phase indicator for code-first mode -->
        <div
          v-if="message.phase && message.phase !== 'done' && !message.content"
          class="d-flex align-center mb-2"
        >
          <v-progress-circular
            size="16"
            width="2"
            indeterminate
            class="mr-2"
          />
          <span class="text-medium-emphasis">{{ phaseLabel }}</span>
        </div>

        <!-- Code panel (collapsible) -->
        <v-expansion-panels
          v-if="message.code"
          variant="accordion"
          class="mb-2 code-panel"
        >
          <v-expansion-panel>
            <v-expansion-panel-title>
              <v-icon size="small" class="mr-2">mdi-code-braces</v-icon>
              <span>View code</span>
              <v-chip
                v-if="message.exitCode != null && message.exitCode !== 0"
                size="x-small"
                color="error"
                class="ml-2"
              >
                exit {{ message.exitCode }}
              </v-chip>
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <pre class="hljs pa-2 rounded"><code>{{ message.code }}</code></pre>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>

        <div
          v-if="message.role === 'assistant'"
          class="markdown-body"
          v-html="renderedContent"
        />
        <div v-else class="user-text">{{ message.content }}</div>
        <v-progress-linear
          v-if="streaming && !message.content && !message.phase"
          indeterminate
          color="primary"
          class="mt-2"
        />
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

const props = defineProps({
  message: { type: Object, required: true },
  streaming: { type: Boolean, default: false }
});

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang }).value}</code></pre>`;
      } catch {
        // fall through
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  }
});

const PHASE_LABELS = {
  generating: 'Writing code...',
  running: 'Running...',
  retrying: 'Retrying...'
};

const phaseLabel = computed(() => {
  return PHASE_LABELS[props.message.phase] || '';
});

const renderedContent = computed(() => {
  let html = md.render(props.message.content || '');
  if (props.streaming && props.message.content) {
    // Inject cursor inline at the end of the last block element
    const cursor = '<span class="streaming-cursor">▌</span>';
    const lastClose = html.lastIndexOf('</');
    if (lastClose !== -1) {
      html = html.slice(0, lastClose) + cursor + html.slice(lastClose);
    } else {
      html += cursor;
    }
  }
  return html;
});
</script>

<style scoped>
.user-message {
  border-radius: 16px 16px 4px 16px;
}

.assistant-message {
  border-radius: 16px 16px 16px 4px;
}

.user-text {
  white-space: pre-wrap;
}

.code-panel {
  font-size: 0.875rem;
}

.code-panel pre {
  font-size: 0.8125rem;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.markdown-body :deep(pre) {
  border-radius: 8px;
  padding: 12px;
  overflow-x: auto;
  margin: 8px 0;
}

.markdown-body :deep(code) {
  font-size: 0.875rem;
}

.markdown-body :deep(p) {
  margin-bottom: 0.5em;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.5em;
  margin-bottom: 0.5em;
}

.markdown-body :deep(.streaming-cursor) {
  animation: blink 530ms steps(2, start) infinite;
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-weight: bold;
}

@keyframes blink {
  to {
    visibility: hidden;
  }
}
</style>
