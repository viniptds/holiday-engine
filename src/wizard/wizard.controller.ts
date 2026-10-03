import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { RequestLocale } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { WizardService } from './wizard.service.js';
import type { QuestionSet } from './wizard.types.js';

@Controller(`${APP_PREFIX}/wizard`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class WizardController {
  constructor(private readonly wizard: WizardService) {}

  /** Titles, option labels and persona labels in the request's language (`Accept-Language`). */
  @Get('questions')
  questions(@RequestLocale() locale: Locale): QuestionSet {
    return this.wizard.getQuestionSet(locale);
  }
}
