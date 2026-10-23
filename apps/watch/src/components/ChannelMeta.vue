<script setup lang="ts">
defineProps<{
  channelId: string;
}>();
</script>

<template>
  <section
    class="channel-meta"
    aria-label="频道信息"
  >
    <p class="channel-meta__line numeric">
      频道 {{ channelId }}
    </p>
    <p class="channel-meta__note">
      画面由讲师浏览器实时推送，延迟约 1–2 秒
    </p>
  </section>
</template>

<style scoped>
.channel-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.channel-meta__line {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-2);
}

.channel-meta__note {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}
</style>
