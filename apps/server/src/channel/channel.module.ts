import { Module } from '@nestjs/common';
import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';
import { PolyvModule } from '../polyv/polyv.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [PolyvModule, RealtimeModule],
  controllers: [ChannelController],
  providers: [ChannelService],
})
export class ChannelModule {}
