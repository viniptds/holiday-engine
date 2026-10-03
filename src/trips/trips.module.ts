import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from './trip.entity.js';
import { TripsService } from './trips.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Trip])],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
