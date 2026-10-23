import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import { queryMediaPermission, type MediaPermissionState } from '../lib/permissions';

export interface UseMediaPermissionsResult {
  camera: Ref<MediaPermissionState>;
  microphone: Ref<MediaPermissionState>;
  /** 重新查一次（修复动作前后、采集报错后都要查，否则界面拿到的是过期状态） */
  refresh: () => Promise<{ camera: MediaPermissionState; microphone: MediaPermissionState }>;
}

/**
 * 摄像头 / 麦克风的浏览器权限状态（D41 ②）。
 *
 * 只做「查状态」这一件事：`denied` 时不要再调用 `getUserMedia`（浏览器不会再弹框），
 * 由调用方改成给「去地址栏改成允许」的指引。用户在地址栏改完权限回到页面时，
 * `focus` / `visibilitychange` 会重新查一次，所以不改代码也不需要刷新页面。
 */
export function useMediaPermissions(): UseMediaPermissionsResult {
  const camera = ref<MediaPermissionState>('prompt');
  const microphone = ref<MediaPermissionState>('prompt');

  async function refresh(): Promise<{ camera: MediaPermissionState; microphone: MediaPermissionState }> {
    const [nextCamera, nextMicrophone] = await Promise.all([
      queryMediaPermission('camera'),
      queryMediaPermission('microphone'),
    ]);
    camera.value = nextCamera;
    microphone.value = nextMicrophone;
    return { camera: nextCamera, microphone: nextMicrophone };
  }

  const onFocus = (): void => void refresh();
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void refresh();
  };

  onMounted(() => {
    void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return { camera, microphone, refresh };
}
