import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { HttpException } from '@nestjs/common';
import type { ApiErrorBody } from '@live1024/shared';

let loaded = false;

/** 依次尝试仓库根目录与工作目录下的 .env；缺文件不报错，缺凭证在用到时报错 */
export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(__dirname, '../../.env'),
    resolve(__dirname, '../../../.env'),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      loadDotenv({ path: file, override: false, quiet: true });
    }
  }
}

export interface PolyvConfig {
  appId: string;
  appSecret: string;
  userId: string;
  healthChannelId: string;
}

/**
 * 读取服务端凭证。凭证只在服务端进程内存在，绝不下发浏览器。
 * 缺失时抛 503，提示补齐 .env（给部署方看，不是给观众看的错误码）。
 */
export function getPolyvConfig(): PolyvConfig {
  loadEnvFiles();
  const appId = (process.env.POLYV_APP_ID ?? '').trim();
  const appSecret = (process.env.POLYV_APP_SECRET ?? '').trim();
  const userId = (process.env.POLYV_USER_ID ?? '').trim();
  if (!appId || !appSecret) {
    throw new HttpException(
      {
        code: 503,
        message: '服务端未配置保利威凭证，请在仓库根目录 .env 中填写 POLYV_APP_ID 与 POLYV_APP_SECRET 后重启',
      } satisfies ApiErrorBody,
      503,
    );
  }
  return {
    appId,
    appSecret,
    userId,
    healthChannelId: (process.env.POLYV_HEALTH_CHANNEL_ID ?? '').trim(),
  };
}

/** 凭证是否齐全（健康检查用，不抛异常） */
export function hasPolyvCredentials(): boolean {
  loadEnvFiles();
  return Boolean((process.env.POLYV_APP_ID ?? '').trim() && (process.env.POLYV_APP_SECRET ?? '').trim());
}
