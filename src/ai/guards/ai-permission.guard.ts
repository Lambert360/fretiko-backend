import { Injectable } from '@nestjs/common';
import { AiIntent } from '../dto/ai.dto';

export enum AiRiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  RESTRICTED = 'restricted',
}

export interface AiPermission {
  intent: AiIntent;
  riskLevel: AiRiskLevel;
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

@Injectable()
export class AiPermissionGuard {
  private readonly permissionMap: Record<AiIntent, AiPermission> = {
    [AiIntent.PRODUCT_SEARCH]: {
      intent: AiIntent.PRODUCT_SEARCH,
      riskLevel: AiRiskLevel.LOW,
      allowed: true,
      requiresConfirmation: false,
    },
    [AiIntent.VENDOR_SEARCH]: {
      intent: AiIntent.VENDOR_SEARCH,
      riskLevel: AiRiskLevel.LOW,
      allowed: true,
      requiresConfirmation: false,
    },
    [AiIntent.COMPARISON]: {
      intent: AiIntent.COMPARISON,
      riskLevel: AiRiskLevel.LOW,
      allowed: true,
      requiresConfirmation: false,
    },
    [AiIntent.TRENDING]: {
      intent: AiIntent.TRENDING,
      riskLevel: AiRiskLevel.LOW,
      allowed: true,
      requiresConfirmation: false,
    },
    [AiIntent.GENERAL_CHAT]: {
      intent: AiIntent.GENERAL_CHAT,
      riskLevel: AiRiskLevel.LOW,
      allowed: true,
      requiresConfirmation: false,
    },
    [AiIntent.UNKNOWN]: {
      intent: AiIntent.UNKNOWN,
      riskLevel: AiRiskLevel.MEDIUM,
      allowed: true,
      requiresConfirmation: false,
      reason: 'Unknown intent, will respond cautiously',
    },
  };

  async verify(userId: string, intent: AiIntent): Promise<AiPermission> {
    const permission = this.permissionMap[intent] || {
      intent,
      riskLevel: AiRiskLevel.RESTRICTED,
      allowed: false,
      requiresConfirmation: true,
      reason: 'Intent not recognized in permission map',
    };

    if (!permission.allowed) {
      throw new Error(`AI action not allowed: ${permission.reason}`);
    }

    return permission;
  }

  isAllowed(intent: AiIntent): boolean {
    return this.permissionMap[intent]?.allowed ?? false;
  }

  requiresConfirmation(intent: AiIntent): boolean {
    return this.permissionMap[intent]?.requiresConfirmation ?? true;
  }
}
