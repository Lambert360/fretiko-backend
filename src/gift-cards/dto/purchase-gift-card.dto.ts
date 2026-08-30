import { IsString, IsNumber, IsUUID, IsOptional, IsEnum, IsEmail, Min, Max } from 'class-validator';

export class PurchaseGiftCardDto {
  @IsUUID()
  designId!: string;
  
  @IsNumber()
  @Min(1) // Minimum 1 FRETI
  @Max(10000) // Maximum 10,000 FRETI
  amount!: number; // Custom FRETI amount
  
  @IsOptional()
  @IsString()
  recipientUsername?: string; // For chat delivery + security
  
  @IsOptional()
  @IsString()
  @IsEmail()
  recipientEmail?: string; // For email delivery
  
  @IsOptional()
  @IsString()
  recipientPhone?: string; // For SMS (future)
  
  @IsOptional()
  @IsString()
  personalMessage?: string; // Optional message to recipient
  
  @IsOptional()
  @IsEnum(['email', 'chat', 'both'])
  deliveryPreference?: 'email' | 'chat' | 'both'; // If multiple recipient methods provided
}

export class ClaimGiftCardDto {
  @IsString()
  claimCode!: string;
}

export class RedeemGiftCardDto {
  @IsString()
  cardNumber!: string;
  
  @IsString()
  pin!: string;
  
  @IsNumber()
  @Min(0)
  orderTotal!: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number; // Optional: manually specify how much of the card balance to use (defaults to max applicable)
}

export class CheckBalanceDto {
  @IsString()
  cardNumber!: string;
  
  @IsString()
  pin!: string;
}

// Response DTOs
export interface GiftCardResponse {
  id: string;
  cardNumber: string;
  amount: number;
  design: {
    name: string;
    designUrl: string;
    previewUrl: string;
  };
  deliveryMethod: string;
  autoClaimed: boolean;
  // True if delivery via email or chat was attempted but failed to send.
  // The gift card itself was still created and charged successfully.
  deliveryFailed?: boolean;
}

export interface ClaimResponse {
  success: boolean;
  giftCard: {
    id: string;
    cardNumber: string;
    balance: number;
    design: any;
  };
}

export interface RedeemResponse {
  appliedAmount: number;
  remainingBalance: number;
  transactionId: string;
}

export interface BalanceResponse {
  balance: number;
  expiresAt: string;
  status: string;
}
