import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { hasPolyvCredentials, getPolyvConfig } from '../env';
import { PolyvClient } from '../polyv/polyv.client';
import { PolyvUpstreamError } from '../polyv/polyv-errors';

/** 健康检查响应体（D39）：`ok` 表达「服务端能不能用」，不只是「进程还活着」 */
export interface HealthBody {
  ok: boolean;
  polyv: 'reachable' | 'unreachable';
}

/** 上游不可达的统一响应（D39：503 + `{ ok: false, polyv: 'unreachable' }`） */
function unreachable(): HttpException {
  return new HttpException(
    { ok: false, polyv: 'unreachable' } satisfies HealthBody,
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

@Controller('health')
export class HealthController {
  constructor(private readonly polyv: PolyvClient) {}

  /**
   * 健康检查（D39）：服务端替浏览器探一次 Polyv 上游，并如实回 HTTP 状态。
   *
   * 为什么状态码必须跟着上游走：浏览器到 `127.0.0.1:<port>` 走**回环**，关掉 Wi-Fi 也不受影响，
   * 所以「HTTP 通了」只证明本进程活着，证明不了外网可达。上游不可达时若仍回 200，
   * 推流端的预检就会把断网误判成「网络正常」。
   *
   * - 上游可达 → 200 `{ ok: true, polyv: 'reachable' }`
   * - 上游网络层不可达 → 503 `{ ok: false, polyv: 'unreachable' }`
   * - 业务错误（频道不存在、参数非法等）说明请求确实到了上游 → 仍算可达，200
   * - 缺凭证 → 200 `{ ok: true, polyv: 'unreachable' }`：不是「服务端挂了」，但也没探到上游
   *   （D40：不打上游、不回 503——playwright webServer readiness 也依赖这个 2xx）；
   *   前端按 `polyv === 'reachable'` 白名单判通，所以讲师看到的仍然是「连不上服务器」
   */
  @Get()
  async check(): Promise<HealthBody> {
    // 没有凭证就发不出上游请求：谈不上可达，但也谈不上本进程有问题
    if (!hasPolyvCredentials()) return { ok: true, polyv: 'unreachable' };
    try {
      const { healthChannelId } = getPolyvConfig();
      await this.polyv.get('/live/v4/channel/live-status/list', {
        channelIds: healthChannelId || '1',
      });
      return { ok: true, polyv: 'reachable' };
    } catch (error) {
      // -1 = 网络层失败（DNS / TCP / 超时）；业务错误（频道不存在等）说明上游可达
      const networkFailed = error instanceof PolyvUpstreamError && error.code === -1;
      if (networkFailed) throw unreachable();
      return { ok: true, polyv: 'reachable' };
    }
  }
}
