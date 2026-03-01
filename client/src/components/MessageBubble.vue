<template>
  <div :class="['message-bubble', 'mb-3', message.role === 'user' ? 'd-flex justify-end' : '']">
    <v-card
      :color="message.role === 'user' ? 'primary' : 'surface'"
      :class="[message.role === 'user' ? 'user-message' : 'assistant-message']"
      :max-width="message.role === 'user' ? '75%' : '100%'"
      variant="flat"
    >
      <v-card-text class="pa-3">
        <div
          v-if="message.role === 'assistant'"
          class="markdown-body"
          v-html="renderedContent"
        />
        <div v-else class="user-text">{{ message.content }}</div>
        <v-progress-linear
          v-if="streaming && !message.content"
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
