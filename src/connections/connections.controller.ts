import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
// import { Public } from '../auth/public.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConnectionsService } from './connections.service';
import { 
  CreateConnectionDto, 
  UpdateConnectionDto, 
  ConnectionResponseDto,
  UserStatsDto,
  CreateClientRelationshipDto 
} from './dto/connection.dto';

@Controller('connections')
@UseGuards(JwtAuthGuard)
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Get('stats')
  async getMyStats(@Request() req): Promise<UserStatsDto> {
    return this.connectionsService.getUserStats(req.user.sub);
  }

  // @Public()
  @Get('stats/:userId')
  async getPublicStats(@Param('userId') userId: string): Promise<UserStatsDto> {
    return this.connectionsService.getUserStats(userId);
  }

  @Get()
  async getMyConnections(@Request() req): Promise<ConnectionResponseDto[]> {
    return this.connectionsService.getMyConnections(req.user.sub);
  }

  @Get('requests')
  async getPendingRequests(@Request() req): Promise<ConnectionResponseDto[]> {
    return this.connectionsService.getPendingRequests(req.user.sub);
  }

  @Post()
  async createConnection(
    @Request() req,
    @Body() dto: CreateConnectionDto,
  ): Promise<ConnectionResponseDto> {
    return this.connectionsService.createConnection(req.user.sub, dto, req.supabaseToken);
  }

  @Put(':id')
  async updateConnection(
    @Request() req,
    @Param('id') connectionId: string,
    @Body() dto: UpdateConnectionDto,
  ): Promise<ConnectionResponseDto> {
    return this.connectionsService.updateConnection(req.user.sub, connectionId, dto, req.supabaseToken);
  }

  @Delete(':id')
  async deleteConnection(
    @Request() req,
    @Param('id') connectionId: string,
  ): Promise<void> {
    return this.connectionsService.deleteConnection(req.user.sub, connectionId, req.supabaseToken);
  }

  @Get('clients')
  async getClientRelationships(@Request() req): Promise<any[]> {
    return this.connectionsService.getClientRelationships(req.user.sub);
  }

  @Post('clients')
  async createClientRelationship(
    @Request() req,
    @Body() dto: CreateClientRelationshipDto,
  ): Promise<void> {
    return this.connectionsService.createClientRelationship(req.user.sub, dto);
  }

  @Get('status/:userId')
  async getConnectionStatus(
    @Request() req,
    @Param('userId') targetUserId: string,
  ): Promise<{ status: string; connectionId?: string }> {
    return this.connectionsService.getConnectionStatus(req.user.sub, targetUserId, req.supabaseToken);
  }
}