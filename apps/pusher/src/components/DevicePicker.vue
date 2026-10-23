<script setup lang="ts">
import type { MediaDeviceOption } from '../composables/useMediaDevices';

const props = defineProps<{
  cameras: MediaDeviceOption[];
  microphones: MediaDeviceOption[];
  cameraId: string;
  microphoneId: string;
  disabled: boolean;
  disabledHint: string | null;
}>();

const emit = defineEmits<{
  'update:cameraId': [value: string];
  'update:microphoneId': [value: string];
}>();

function onCameraChange(event: Event): void {
  emit('update:cameraId', (event.target as HTMLInputElement).value);
}

function onMicrophoneChange(event: Event): void {
  emit('update:microphoneId', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="device-picker">
    <fieldset class="device-picker__group">
      <legend class="device-picker__legend">
        摄像头
      </legend>
      <p
        v-if="props.cameras.length === 0"
        class="device-picker__empty"
      >
        未检测到摄像头
      </p>
      <label
        v-for="camera in props.cameras"
        :key="camera.deviceId"
        class="device-picker__option"
        :data-disabled="disabled ? 'true' : 'false'"
      >
        <input
          type="radio"
          name="camera-device"
          :value="camera.deviceId"
          :checked="camera.deviceId === cameraId"
          :disabled="disabled"
          @change="onCameraChange"
        >
        <span class="device-picker__label-text">{{ camera.label }}</span>
      </label>
    </fieldset>

    <fieldset class="device-picker__group">
      <legend class="device-picker__legend">
        麦克风
      </legend>
      <p
        v-if="props.microphones.length === 0"
        class="device-picker__empty"
      >
        未检测到麦克风
      </p>
      <label
        v-for="microphone in props.microphones"
        :key="microphone.deviceId"
        class="device-picker__option"
        :data-disabled="disabled ? 'true' : 'false'"
      >
        <input
          type="radio"
          name="microphone-device"
          :value="microphone.deviceId"
          :checked="microphone.deviceId === microphoneId"
          :disabled="disabled"
          @change="onMicrophoneChange"
        >
        <span class="device-picker__label-text">{{ microphone.label }}</span>
      </label>
    </fieldset>

    <p
      v-if="props.disabledHint"
      class="device-picker__hint"
    >
      {{ props.disabledHint }}
    </p>
  </div>
</template>

<style scoped>
.device-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-4) var(--space-6);
  min-width: 0;
}

.device-picker__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}

.device-picker__legend {
  padding: 0;
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}

.device-picker__option {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  padding: 0 var(--space-3);
  border-radius: var(--radius-control);
  border: 1px solid var(--color-border);
  background: var(--color-panel-raised);
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-2);
  cursor: pointer;
  max-width: 260px;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.device-picker__option:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text-1);
}

/* 选中态：蓝底 12% 填充 + 1px 蓝描边 + 白字（v2 §4） */
.device-picker__option:has(input:checked) {
  background: var(--color-brand-soft);
  border-color: var(--color-brand);
  color: var(--color-text-1);
}

.device-picker__option[data-disabled='true'] {
  cursor: not-allowed;
  color: var(--color-text-4);
}

.device-picker__option[data-disabled='true']:has(input:checked) {
  color: var(--color-text-2);
}

.device-picker__option input {
  accent-color: var(--color-brand);
  margin: 0;
  flex: none;
}

.device-picker__label-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-picker__empty {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}

.device-picker__hint {
  flex-basis: 100%;
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}
</style>
