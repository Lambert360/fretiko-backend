import { IsString, IsOptional, IsNumber, IsUUID, IsBoolean, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAboutContentDto {
  @ApiProperty({ description: 'Section identifier (mission, vision, values, team, achievements)' })
  @IsString()
  section: string;

  @ApiProperty({ description: 'Section title' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Section content' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Display order' })
  @IsNumber()
  @IsOptional()
  order?: number;

  @ApiPropertyOptional({ description: 'Section image URL' })
  @IsString()
  @IsOptional()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Image alt text' })
  @IsString()
  @IsOptional()
  imageAlt?: string;

  @ApiPropertyOptional({ description: 'Whether section is active' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateAboutContentDto {
  @ApiPropertyOptional({ description: 'Section identifier' })
  @IsString()
  @IsOptional()
  section?: string;

  @ApiPropertyOptional({ description: 'Section title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Section content' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: 'Display order' })
  @IsNumber()
  @IsOptional()
  order?: number;

  @ApiPropertyOptional({ description: 'Section image URL' })
  @IsString()
  @IsOptional()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Image alt text' })
  @IsString()
  @IsOptional()
  imageAlt?: string;

  @ApiPropertyOptional({ description: 'Whether section is active' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateOrderDto {
  @ApiProperty({ description: 'Array of section IDs in new order' })
  @IsArray()
  @IsUUID(4, { each: true })
  sectionIds: string[];
}
