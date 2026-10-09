import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { CHECKLIST_CATEGORIES, CHECKLIST_PRIORITIES } from './checklist.entities.js';
import type { ChecklistCategory, ChecklistPriority } from './checklist.entities.js';

/** `POST /trips/:id/checklist`. Decorators run bottom-up: the type check is last. */
export class CreateChecklistItemDto {
  @MaxLength(120)
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsOptional()
  @MaxLength(500)
  @IsString()
  notes?: string | null;

  @IsOptional()
  @IsIn(CHECKLIST_PRIORITIES)
  priority?: ChecklistPriority;

  @IsOptional()
  @IsIn(CHECKLIST_CATEGORIES)
  category?: ChecklistCategory;
}

/** `PATCH /trips/:id/checklist/:itemId`: omitted fields stay; `notes: null` clears. */
export class PatchChecklistItemDto {
  @IsOptional()
  @MaxLength(120)
  @IsNotEmpty()
  @IsString()
  title?: string;

  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @MaxLength(500)
  @IsString()
  notes?: string | null;

  @IsOptional()
  @IsIn(CHECKLIST_PRIORITIES)
  priority?: ChecklistPriority;

  @IsOptional()
  @IsIn(CHECKLIST_CATEGORIES)
  category?: ChecklistCategory;

  @IsOptional()
  @IsBoolean()
  done?: boolean;
}

/** `PUT /trips/:id/checklist/order`: every item exactly once. */
export class ChecklistOrderDto {
  @IsUUID('4', { each: true })
  @ArrayMaxSize(200)
  @IsArray()
  itemIds: string[];
}

/** `POST /trips/:id/checklist/bulk`: picked suggestions. */
export class BulkChecklistDto {
  @ValidateNested({ each: true })
  @Type(() => CreateChecklistItemDto)
  @ArrayMaxSize(50)
  @ArrayMinSize(1)
  @IsArray()
  items: CreateChecklistItemDto[];
}

/** `PUT /trips/:id/checklist/:itemId/reminder`. */
export class ChecklistReminderDto {
  @IsISO8601({ strict: true })
  remindAt: string;
}
