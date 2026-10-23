import { Module } from '@nestjs/common';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module';
import { AiClient } from './ai.client';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

/**
 * AI 诊断解释模块：读诊断留痕 + 指标统计（DiagnosticsModule 提供的内存态），
 * 调 DeepSeek 生成解释，失败由 AiService 自己拼规则兜底。
 */
@Module({
  imports: [DiagnosticsModule],
  controllers: [AiController],
  providers: [AiClient, AiService],
})
export class AiModule {}
