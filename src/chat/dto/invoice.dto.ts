import { IsString, IsNumber, IsOptional, IsArray, ValidateNested, IsEnum, IsDateString, Min, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

export enum InvoiceItemType {
  PRODUCT = 'product',
  SERVICE = 'service',
}

export enum InvoiceStatus {
  PENDING = 'pending',
  PAID = 'paid',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export class CreateInvoiceItemDto {
  @IsEnum(InvoiceItemType)
  itemType: InvoiceItemType;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0.01)
  price: number;

  @IsNumber()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsDateString()
  appointmentDate?: string;

  @IsOptional()
  @IsString()
  appointmentTime?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  serviceId?: string;
}

export class CreateInvoiceDto {
  @IsUUID()
  conversationId: string;

  @IsOptional()
  @IsUUID()
  buyerId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceItemDto)
  items: CreateInvoiceItemDto[];
}

export class UpdateInvoiceDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceItemDto)
  items?: CreateInvoiceItemDto[];

  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;
}

export class InvoiceItemResponseDto {
  id: string;
  invoiceId: string;
  itemType: InvoiceItemType;
  name: string;
  description?: string;
  price: number;
  quantity: number;
  totalPrice: number;
  imageUrl?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  productId?: string;
  serviceId?: string;
  createdAt: string;
}

export class InvoiceResponseDto {
  id: string;
  invoiceNumber: string;
  conversationId: string;
  messageId: string;
  vendorId: string;
  buyerId: string;
  totalAmount: number;
  status: InvoiceStatus;
  expiresAt: string;
  paidAt?: string;
  orderId?: string;
  items: InvoiceItemResponseDto[];
  createdAt: string;
  updatedAt: string;
}
