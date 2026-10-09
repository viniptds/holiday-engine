import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AppTripsModule } from '../app-trips/app-trips.module.js';
import { AiModule } from '../ai/ai.module.js';
import { ChecklistItem, ChecklistReminder } from './checklist.entities.js';
import { ChecklistService } from './checklist.service.js';
import { ChecklistController } from './checklist.controller.js';

/** Trip checklists and AI suggestions (the LLM provider comes from AiModule). */
@Module({
  imports: [TypeOrmModule.forFeature([ChecklistItem, ChecklistReminder]), AuthModule, AppTripsModule, AiModule],
  controllers: [ChecklistController],
  providers: [ChecklistService],
  exports: [ChecklistService],
})
export class ChecklistModule {}
