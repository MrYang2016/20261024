import { Module } from '@nestjs/common';
import { PushSessionRegistry } from './push-session.registry';

/** 推流会话状态（内存态）。24061 的实时大纲 / 答疑从这里拿「是否正在推流」。 */
@Module({
  providers: [PushSessionRegistry],
  exports: [PushSessionRegistry],
})
export class RealtimeModule {}
