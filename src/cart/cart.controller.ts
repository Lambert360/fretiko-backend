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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CartService } from './cart.service';

@Controller('cart')
@UseGuards(JwtAuthGuard)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  async getCartItems(@Request() req) {
    console.log('🛒 Fetching cart items for user:', req.user.sub);
    return this.cartService.getCartItems(req.user.sub, req.supabaseToken);
  }

  @Get('summary')
  async getCartSummary(@Request() req) {
    console.log('🛒 Fetching cart summary for user:', req.user.sub);
    return this.cartService.getCartSummary(req.user.sub, req.supabaseToken);
  }

  @Get('count')
  async getCartCount(@Request() req) {
    console.log('🛒 Fetching cart count for user:', req.user.sub);
    return this.cartService.getCartCount(req.user.sub, req.supabaseToken);
  }

  @Post()
  async addToCart(@Request() req, @Body() cartData: { productId: string; quantity: number; price: number }) {
    console.log('🛒 Adding to cart for user:', req.user.sub, cartData);
    return this.cartService.addToCart(req.user.sub, cartData, req.supabaseToken);
  }

  @Put(':id')
  async updateQuantity(@Request() req, @Param('id') itemId: string, @Body() updateData: { quantity: number }) {
    console.log('🛒 Updating cart item quantity:', itemId, updateData);
    return this.cartService.updateQuantity(req.user.sub, itemId, updateData.quantity, req.supabaseToken);
  }

  @Delete(':id')
  async removeItem(@Request() req, @Param('id') itemId: string) {
    console.log('🛒 Removing cart item:', itemId);
    return this.cartService.removeItem(req.user.sub, itemId, req.supabaseToken);
  }

  @Delete()
  async clearCart(@Request() req) {
    console.log('🛒 Clearing cart for user:', req.user.sub);
    return this.cartService.clearCart(req.user.sub, req.supabaseToken);
  }

  @Post('validate')
  async validateCart(@Request() req) {
    console.log('🛒 Validating cart for user:', req.user.sub);
    return this.cartService.validateCart(req.user.sub, req.supabaseToken);
  }
}