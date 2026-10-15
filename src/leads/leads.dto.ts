import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { NoControlChars } from '../trips/dto/no-control-chars.validator.js';
import { Trim } from '../trips/dto/trim.transform.js';
import { LEAD_KINDS, LEAD_LANGS } from './lead.entity.js';

export const NAME_MAX = 80;
export const MESSAGE_MAX = 2000;
const NO_CONTROL_AT_ALL = /^[^\u0000-\u001F\u007F]*$/;
const SOURCE_SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const noControl = () => Matches(NO_CONTROL_AT_ALL, { message: '$property must not contain control characters' });

/** The page URL's utm_* parameters. */
export class LeadUtmDto {
  @IsOptional() @Trim() @MaxLength(100) @noControl() @IsString() source?: string;
  @IsOptional() @Trim() @MaxLength(100) @noControl() @IsString() medium?: string;
  @IsOptional() @Trim() @MaxLength(100) @noControl() @IsString() campaign?: string;
  @IsOptional() @Trim() @MaxLength(100) @noControl() @IsString() content?: string;
  @IsOptional() @Trim() @MaxLength(100) @noControl() @IsString() term?: string;
}

/** `POST /public/v1/leads` body (docs/web-leads-spec.md). `token` is redeemed before validation runs. */
export class CreateLeadDto {
  @IsString()
  token: string;

  @IsIn([...LEAD_KINDS])
  kind: (typeof LEAD_KINDS)[number];

  @Trim()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @MaxLength(254)
  @IsEmail()
  email: string;

  @IsOptional()
  @Trim()
  @IsNotEmpty()
  @MaxLength(NAME_MAX)
  @noControl()
  @IsString()
  name?: string;

  @IsOptional()
  @Trim()
  @IsNotEmpty()
  @MaxLength(80)
  @noControl()
  @IsString()
  role?: string;

  @IsOptional()
  @Trim()
  @IsNotEmpty()
  @MaxLength(MESSAGE_MAX)
  @NoControlChars()
  @IsString()
  message?: string;

  @IsIn([...LEAD_LANGS])
  lang: (typeof LEAD_LANGS)[number];

  @Matches(SOURCE_SLUG, { message: 'source must be a short lowercase slug' })
  @IsString()
  source: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeadUtmDto)
  @IsObject()
  utm?: LeadUtmDto;

  /** The honeypot: real visitors never fill it. A non-empty value is answered with a silent 201 before validation. */
  @IsOptional()
  @IsString()
  website?: string;
}
