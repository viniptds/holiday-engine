import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { DevAuthGuard } from '../app-trips/dev-auth.guard.js';
import { WizardService } from './wizard.service.js';
import type { QuestionSet } from './wizard.types.js';

@Controller(`${APP_PREFIX}/wizard`)
@UseFilters(AppExceptionFilter)
@UseGuards(DevAuthGuard)
export class WizardController {
  constructor(private readonly wizard: WizardService) {}

  @Get('questions')
  questions(): QuestionSet {
    return this.wizard.getQuestionSet();
  }
}
