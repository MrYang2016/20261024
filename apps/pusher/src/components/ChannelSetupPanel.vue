<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  busy: boolean;
  errorMessage: string | null;
}>();

const emit = defineEmits<{
  create: [name: string];
  useExisting: [channelId: string];
}>();

const name = ref('');
const channelId = ref('');

function submitCreate(): void {
  if (props.busy) return;
  emit('create', name.value.trim());
}

function submitUseExisting(): void {
  if (props.busy) return;
  emit('useExisting', channelId.value.trim());
}
</script>

<template>
  <section
    class="setup panel"
    aria-labelledby="setup-title"
  >
    <h2
      id="setup-title"
      class="setup__title"
    >
      先准备一个频道
    </h2>
    <p class="setup__desc">
      新建频道会自动配成纯视频模板（第三方推流必须）。已经在直播后台建过频道，直接填频道号即可。
    </p>

    <form
      class="setup__form"
      @submit.prevent="submitCreate"
    >
      <div class="setup__field">
        <label
          class="setup__label"
          for="channel-name"
        >频道名称</label>
        <input
          id="channel-name"
          v-model="name"
          type="text"
          maxlength="50"
          placeholder="例如：1024 直播演示"
          :disabled="busy"
        >
      </div>
      <button
        type="submit"
        data-variant="primary"
        :disabled="busy"
      >
        {{ busy ? '处理中…' : '新建频道' }}
      </button>
    </form>

    <p class="setup__divider">
      或使用已有频道
    </p>

    <form
      class="setup__form"
      @submit.prevent="submitUseExisting"
    >
      <div class="setup__field">
        <label
          class="setup__label"
          for="existing-channel-id"
        >频道号</label>
        <input
          id="existing-channel-id"
          v-model="channelId"
          type="text"
          inputmode="numeric"
          maxlength="20"
          placeholder="例如：1000001"
          :disabled="busy"
        >
      </div>
      <button
        type="submit"
        :disabled="busy || !channelId.trim()"
      >
        使用该频道
      </button>
    </form>

    <p
      v-if="props.errorMessage"
      class="setup__error"
      role="alert"
    >
      {{ props.errorMessage }}
    </p>
  </section>
</template>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: 680px;
  padding: var(--space-6);
}

.setup__title {
  font-size: var(--font-size-20);
  line-height: var(--line-height-30);
  font-weight: var(--font-weight-medium);
}

.setup__desc {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
  max-width: 46em;
}

.setup__form {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
}

.setup__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.setup__label {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-2);
}

.setup__divider {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}

.setup__error {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-danger);
}

input {
  width: 100%;
}

@media (max-width: 720px) {
  .setup__form {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
