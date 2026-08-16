import { IsString, IsOptional, IsEnum, IsUUID, MaxLength, MinLength } from 'class-validator';
import { InteractionType } from '../interfaces/post.interface';

export class CreateInteractionDto {
  @IsEnum(InteractionType)
  interactionType: InteractionType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  content?: string;

  @IsOptional()
  @IsUUID()
  giftId?: string;

  @IsOptional()
  @IsUUID()
  parentCommentId?: string;
}

export class UpdateCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  content: string;
}

export class PostGiftDto {
  @IsUUID()
  postId: string;

  @IsUUID()
  giftId: string; // Gift UUID (like live sales)

  @IsOptional()
  @IsString()
  @MaxLength(200)
  message?: string;
}

export class CommentGiftDto {
  @IsUUID()
  giftId: string;
}
