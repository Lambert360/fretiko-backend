import { IsEnum, IsUUID, IsOptional, IsString, IsNumber, Min } from 'class-validator';
import { ConnectionStatus } from '../entities/user-connection.entity';

export class CreateConnectionDto {
  @IsUUID()
  addresseeId: string;
}

export class UpdateConnectionDto {
  @IsEnum(ConnectionStatus)
  status: ConnectionStatus;
}

export class ConnectionResponseDto {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: ConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
  
  // Include user details for easy frontend consumption
  requester?: {
    id: string;
    username: string;
    avatarUrl?: string;
  };

  addressee?: {
    id: string;
    username: string;
    avatarUrl?: string;
  };
}

export class UserStatsDto {
  plugsCount: number;
  clientsCount: number;
  connectionRequestsCount: number;
}

export class CreateClientRelationshipDto {
  @IsUUID()
  clientId: string;
  
  @IsOptional()
  @IsString()
  relationshipType?: 'customer' | 'regular_client' = 'customer';
  
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalOrders?: number = 0;
  
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalSpent?: number = 0;
}