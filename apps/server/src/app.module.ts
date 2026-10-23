import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { ChannelModule } from './channel/channel.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { HealthController } from './health/health.controller';
import { PolyvModule } from './polyv/polyv.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [PolyvModule, RealtimeModule, ChannelModule, DiagnosticsModule, AiModule],
  controllers: [HealthController],
})
export class AppModule {}
