import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * 诊断留痕模块（D23）：纯内存，不依赖 polyv / channel 模块，也不引数据库。
 * 24060 增补（D34）：指标时间序列（`/api/channels/:channelId/metrics`）与诊断同属一个模块——
 * 两者都是「推流端上报 → 服务端内存留痕 → 抽屉导出」，共用一套内存态口径。
 */
@Module({
  controllers: [DiagnosticsController, MetricsController],
  providers: [DiagnosticsService, MetricsService],
  // AI 诊断解释（POST /api/channels/:channelId/analyze）要读诊断留痕与指标统计，导出给 AiModule
  exports: [DiagnosticsService, MetricsService],
})
export class DiagnosticsModule {}
