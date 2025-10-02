export enum ConnectionStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  BLOCKED = 'blocked',
}

export interface UserConnection {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: ConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientRelationship {
  id: string;
  providerId: string;
  clientId: string;
  relationshipType: 'customer' | 'regular_client';
  totalOrders: number;
  totalSpent: number;
  lastInteraction: Date;
  createdAt: Date;
}

export interface UserStats {
  id: string;
  plugsCount: number;
  clientsCount: number;
  connectionRequestsCount: number;
}