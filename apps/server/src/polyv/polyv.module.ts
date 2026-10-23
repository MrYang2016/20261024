import { Module } from '@nestjs/common';
import { PolyvClient } from './polyv.client';

@Module({
  providers: [PolyvClient],
  exports: [PolyvClient],
})
export class PolyvModule {}
