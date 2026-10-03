import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { WizardController } from './wizard.controller.js';
import { WizardService } from './wizard.service.js';
import { loadQuestionSet } from './question-set.loader.js';
import { QUESTION_SET } from './wizard.types.js';

@Module({
  imports: [AuthModule],
  controllers: [WizardController],
  providers: [
    WizardService,
    {
      // Loaded once at startup; an invalid file throws here and fails boot with the problems listed.
      provide: QUESTION_SET,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => loadQuestionSet(config.get<string>('WIZARD_QUESTIONS_PATH') || undefined),
    },
  ],
  exports: [WizardService],
})
export class WizardModule {}
