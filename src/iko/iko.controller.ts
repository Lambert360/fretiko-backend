import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IkoService } from './iko.service';
import {
  UpdateIkoPreferencesDto,
  UpdateIkoContextDto,
  CreateOngoingPlanDto,
  UpdateOngoingPlanDto,
  RecordConversationDto,
  IkoUserProfileDto,
  IkoPreferencesResponseDto,
  IkoContextResponseDto,
} from './dto/iko.dto';

@Controller('iko')
@UseGuards(JwtAuthGuard)
export class IkoController {
  private readonly logger = new Logger(IkoController.name);

  constructor(private readonly ikoService: IkoService) {}

  /**
   * Get user's complete Iko profile (preferences + context + user info)
   */
  @Get('profile')
  async getIkoProfile(@Req() request: any): Promise<IkoUserProfileDto> {
    this.logger.log(`Getting Iko profile for user: ${request.user.sub}`);

    return await this.ikoService.getIkoUserProfile(
      request.user.sub,
      request.headers.authorization?.replace('Bearer ', '')
    );
  }

  /**
   * Get user's Iko preferences
   */
  @Get('preferences')
  async getPreferences(@Req() request: any): Promise<IkoPreferencesResponseDto> {
    this.logger.log(`Getting Iko preferences for user: ${request.user.sub}`);

    const preferences = await this.ikoService.getIkoPreferences(
      request.user.sub,
      request.headers.authorization?.replace('Bearer ', '')
    );

    return {
      preferences,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Update user's Iko preferences
   */
  @Put('preferences')
  @HttpCode(HttpStatus.OK)
  async updatePreferences(
    @Req() request: any,
    @Body() updateDto: UpdateIkoPreferencesDto
  ): Promise<IkoPreferencesResponseDto> {
    this.logger.log(`Updating Iko preferences for user: ${request.user.sub}`);

    const preferences = await this.ikoService.updateIkoPreferences(
      request.user.sub,
      updateDto,
      request.headers.authorization?.replace('Bearer ', '')
    );

    return {
      preferences,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Get user's Iko context
   */
  @Get('context')
  async getContext(@Req() request: any): Promise<IkoContextResponseDto> {
    this.logger.log(`Getting Iko context for user: ${request.user.sub}`);

    const context = await this.ikoService.getIkoContext(
      request.user.sub,
      request.headers.authorization?.replace('Bearer ', '')
    );

    return {
      context,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Update user's Iko context
   */
  @Put('context')
  @HttpCode(HttpStatus.OK)
  async updateContext(
    @Req() request: any,
    @Body() updateDto: UpdateIkoContextDto
  ): Promise<IkoContextResponseDto> {
    this.logger.log(`Updating Iko context for user: ${request.user.sub}`);

    const context = await this.ikoService.updateIkoContext(
      request.user.sub,
      updateDto,
      request.headers.authorization?.replace('Bearer ', '')
    );

    return {
      context,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Record a conversation interaction
   */
  @Post('conversation')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordConversation(
    @Req() request: any,
    @Body() recordDto: RecordConversationDto
  ): Promise<void> {
    this.logger.log(`Recording conversation for user: ${request.user.sub}`);

    await this.ikoService.recordConversation(
      request.user.sub,
      recordDto.interactionType,
      recordDto.summary,
      request.headers.authorization?.replace('Bearer ', '')
    );
  }

  /**
   * Add an ongoing plan
   */
  @Post('plans')
  @HttpCode(HttpStatus.CREATED)
  async addOngoingPlan(
    @Req() request: any,
    @Body() planDto: CreateOngoingPlanDto
  ): Promise<{ message: string; planId: string }> {
    this.logger.log(`Adding ongoing plan for user: ${request.user.sub}`);

    const planId = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    await this.ikoService.addOngoingPlan(
      request.user.sub,
      {
        id: planId,
        type: planDto.type,
        title: planDto.title,
        description: planDto.description,
        scheduledFor: planDto.scheduledFor,
        status: planDto.status || 'pending',
      },
      request.headers.authorization?.replace('Bearer ', '')
    );

    return {
      message: 'Plan added successfully',
      planId,
    };
  }

  /**
   * Update an ongoing plan
   */
  @Put('plans/:planId')
  @HttpCode(HttpStatus.OK)
  async updateOngoingPlan(
    @Req() request: any,
    @Param('planId') planId: string,
    @Body() updateDto: UpdateOngoingPlanDto
  ): Promise<{ message: string }> {
    this.logger.log(`Updating plan ${planId} for user: ${request.user.sub}`);

    await this.ikoService.updateOngoingPlan(
      request.user.sub,
      planId,
      updateDto,
      request.headers.authorization?.replace('Bearer ', '')
    );

    return {
      message: 'Plan updated successfully',
    };
  }

  /**
   * Get ongoing plans
   */
  @Get('plans')
  async getOngoingPlans(@Req() request: any): Promise<{ plans: any[] }> {
    this.logger.log(`Getting ongoing plans for user: ${request.user.sub}`);

    const context = await this.ikoService.getIkoContext(
      request.user.sub,
      request.headers.authorization?.replace('Bearer ', '')
    );

    return {
      plans: context.ongoing_plans || [],
    };
  }
}