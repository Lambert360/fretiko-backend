import { IsString, IsOptional, IsEnum, IsUUID, MaxLength, MinLength } from 'class-validator';

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate_speech',
  'violence',
  'misinformation',
  'inappropriate_content',
  'copyright',
  'other'
] as const;

export type ReportReason = typeof REPORT_REASONS[number];

export class CreateReportDto {
  @IsUUID()
  postId: string;

  @IsEnum(REPORT_REASONS)
  reason: ReportReason;

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  details?: string;
}

export class UpdateReportStatusDto {
  @IsEnum(['reviewing', 'resolved', 'dismissed'])
  status: 'reviewing' | 'resolved' | 'dismissed';

  @IsOptional()
  @IsString()
  notes?: string;
}
