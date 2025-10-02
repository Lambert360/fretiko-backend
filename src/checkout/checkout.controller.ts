import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('checkout')
@UseGuards(JwtAuthGuard)
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  // Get checkout summary from cart
  @Get('summary')
  async getCheckoutSummary(@Request() req) {
    try {
      return await this.checkoutService.getCheckoutSummary(req.user.sub, req.supabaseToken);
    } catch (error) {
      console.error('Error getting checkout summary:', error);
      throw new HttpException(
        'Failed to get checkout summary',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Get direct checkout summary (buy now)
  @Get('summary/direct')
  async getDirectCheckoutSummary(
    @Query('productId') productId: string,
    @Query('quantity') quantity: string,
    @Request() req,
  ) {
    try {
      const qty = parseInt(quantity, 10);
      if (!productId || isNaN(qty) || qty < 1) {
        throw new HttpException(
          'Invalid product ID or quantity',
          HttpStatus.BAD_REQUEST,
        );
      }

      return await this.checkoutService.getDirectCheckoutSummary(
        req.user.sub,
        productId,
        qty,
        req.supabaseToken,
      );
    } catch (error) {
      console.error('Error getting direct checkout summary:', error);
      throw new HttpException(
        error.message || 'Failed to get direct checkout summary',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Get available payment methods
  @Get('payment-methods')
  async getPaymentMethods(@Request() req) {
    try {
      return await this.checkoutService.getPaymentMethods(req.user.sub, req.supabaseToken);
    } catch (error) {
      console.error('Error getting payment methods:', error);
      throw new HttpException(
        'Failed to get payment methods',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Get default delivery address
  @Get('address/default')
  async getDefaultAddress(@Request() req) {
    try {
      return await this.checkoutService.getDefaultAddress(req.user.sub, req.supabaseToken);
    } catch (error) {
      console.error('Error getting default address:', error);
      return null; // Return null instead of throwing error - allows frontend to handle gracefully
    }
  }

  // Save delivery address
  @Post('address')
  async saveAddress(@Body() addressData: any, @Request() req) {
    try {
      return await this.checkoutService.saveAddress(req.user.sub, addressData, req.supabaseToken);
    } catch (error) {
      console.error('Error saving address:', error);
      throw new HttpException(
        'Failed to save address',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Create order
  @Post('order')
  async createOrder(@Body() orderData: any, @Request() req) {
    try {
      return await this.checkoutService.createOrder(req.user.sub, orderData, req.supabaseToken);
    } catch (error) {
      console.error('Error creating order:', error);
      throw new HttpException(
        error.message || 'Failed to create order',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Validate checkout
  @Post('validate')
  async validateCheckout(@Request() req) {
    try {
      return await this.checkoutService.validateCheckout(req.user.sub, req.supabaseToken);
    } catch (error) {
      console.error('Error validating checkout:', error);
      throw new HttpException(
        'Failed to validate checkout',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Calculate escrow fee
  @Get('escrow-fee')
  async calculateEscrowFee(@Query('amount') amount: string) {
    try {
      const orderAmount = parseFloat(amount);
      if (isNaN(orderAmount) || orderAmount <= 0) {
        throw new HttpException(
          'Invalid amount',
          HttpStatus.BAD_REQUEST,
        );
      }

      const fee = await this.checkoutService.calculateEscrowFee(orderAmount);
      return { fee };
    } catch (error) {
      console.error('Error calculating escrow fee:', error);
      throw new HttpException(
        'Failed to calculate escrow fee',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Get delivery options
  @Post('delivery-options')
  async getDeliveryOptions(@Body('address') address: any, @Request() req) {
    try {
      return await this.checkoutService.getDeliveryOptions(address, req.user.sub);
    } catch (error) {
      console.error('Error getting delivery options:', error);
      throw new HttpException(
        'Failed to get delivery options',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Get auction checkout summary (for auction winners)
  @Get('summary/auction')
  async getAuctionCheckoutSummary(
    @Query('auctionId') auctionId: string,
    @Request() req,
  ) {
    try {
      if (!auctionId) {
        throw new HttpException(
          'Auction ID is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      return await this.checkoutService.getAuctionCheckoutSummary(
        req.user.sub,
        auctionId,
        req.supabaseToken,
      );
    } catch (error) {
      console.error('Error getting auction checkout summary:', error);
      throw new HttpException(
        error.message || 'Failed to get auction checkout summary',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}