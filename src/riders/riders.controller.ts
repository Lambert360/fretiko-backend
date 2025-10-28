import { Controller, Post, Get, Put, Body, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RidersService } from './riders.service';

export interface RiderLocation {
  latitude: number;
  longitude: number;
  address: string;
}

export interface OrderDetails {
  weight: number;
  itemCount: number;
  distance: number;
  category?: string;
}

export interface RiderAvailabilityRequest {
  pickupLocation: RiderLocation;
  deliveryLocation: RiderLocation;
  orderDetails: OrderDetails;
  maxDistance?: number;
}

export interface RiderProfile {
  id: string;
  name: string;
  avatar: string;
  rating: number;
  totalDeliveries: number;
  vehicleType: 'wheelbarrow' | 'bike' | 'car';
  price: number;
  distanceFromPickup: number;
  estimatedArrival: number;
  isAvailable: boolean;
  unavailableReason?: string;
  specialties: string[];
  isOnline: boolean;
  trustScore?: number;
  completionRate?: number;
}

@Controller('riders')
@UseGuards(JwtAuthGuard)
export class RidersController {
  constructor(private readonly ridersService: RidersService) {}

  @Post('nearby')
  async getNearbyRiders(
    @Body() request: RiderAvailabilityRequest,
    @Request() req: any,
  ): Promise<RiderProfile[]> {
    console.log('🔍 Finding nearby riders:', {
      pickup: request.pickupLocation.address,
      orderDetails: request.orderDetails,
      userId: req.user.id,
    });

    return this.ridersService.findNearbyRiders(request, req.user.id);
  }

  @Post('recommendations')
  async getRiderRecommendations(
    @Body() request: RiderAvailabilityRequest,
    @Request() req: any,
  ): Promise<Array<{
    riderId: string;
    score: number;
    reasons: string[];
  }>> {
    console.log('⭐ Getting rider recommendations:', {
      pickup: request.pickupLocation.address,
      userId: req.user.id,
    });

    return this.ridersService.getRiderRecommendations(request, req.user.id);
  }

  @Post(':riderId/availability')
  async checkRiderAvailability(
    @Param('riderId') riderId: string,
    @Body() orderDetails: OrderDetails,
    @Request() req: any,
  ): Promise<{
    available: boolean;
    reason?: string;
    estimatedArrival?: number;
  }> {
    console.log('✅ Checking rider availability:', {
      riderId,
      orderDetails,
      userId: req.user.id,
    });

    return this.ridersService.checkRiderAvailability(riderId, orderDetails);
  }

  @Get(':riderId')
  async getRiderProfile(
    @Param('riderId') riderId: string,
    @Request() req: any,
  ): Promise<RiderProfile | null> {
    console.log('👤 Getting rider profile:', {
      riderId,
      userId: req.user.id,
    });

    return this.ridersService.getRiderProfile(riderId);
  }

  @Get(':riderId/stats')
  async getRiderStats(
    @Param('riderId') riderId: string,
    @Request() req: any,
  ): Promise<{
    totalDeliveries: number;
    avgRating: number;
    completionRate: number;
    avgDeliveryTime: number;
    specialties: string[];
  }> {
    console.log('📊 Getting rider stats:', {
      riderId,
      userId: req.user.id,
    });

    return this.ridersService.getRiderStats(riderId);
  }

  @Post('/assign-rider')
  async assignRiderToOrder(
    @Body() body: { riderId: string; orderId: string },
    @Request() req: any,
  ): Promise<{
    success: boolean;
    estimatedPickup?: string;
    estimatedDelivery?: string;
  }> {
    console.log('🎯 Assigning rider to order:', {
      ...body,
      userId: req.user.id,
    });

    return this.ridersService.assignRiderToOrder(body.riderId, body.orderId, req.user.id);
  }

  // ===== LOCATION TRACKING ENDPOINTS =====

  @Post('location')
  async updateRiderLocation(
    @Body() body: {
      latitude: number;
      longitude: number;
      accuracy?: number;
      isOnline?: boolean;
      isAvailable?: boolean;
      batteryLevel?: number;
    },
    @Request() req: any,
  ): Promise<{ success: boolean; message?: string }> {
    console.log('📍 Updating rider location:', {
      userId: req.user.id,
      lat: body.latitude,
      lon: body.longitude,
    });

    return this.ridersService.updateRiderLocation(
      req.user.id,
      body.latitude,
      body.longitude,
      body.accuracy,
      body.isOnline ?? true,
      body.isAvailable ?? true,
      body.batteryLevel,
    );
  }

  @Get(':riderId/location')
  async getRiderLocation(
    @Param('riderId') riderId: string,
    @Request() req: any,
  ): Promise<{
    latitude: number;
    longitude: number;
    accuracy?: number;
    isOnline: boolean;
    isAvailable: boolean;
    lastPing: string;
    batteryLevel?: number;
    currentOrderId?: string;
  } | null> {
    console.log('📍 Getting rider location:', {
      riderId,
      requestedBy: req.user.id,
    });

    return this.ridersService.getRiderLocation(riderId);
  }

  @Put('status')
  async toggleRiderStatus(
    @Body() body: { isOnline?: boolean; isAvailable?: boolean },
    @Request() req: any,
  ): Promise<{ success: boolean }> {
    console.log('🔄 Toggling rider status:', {
      userId: req.user.id,
      ...body,
    });

    return this.ridersService.toggleRiderStatus(
      req.user.id,
      body.isOnline,
      body.isAvailable,
    );
  }

  @Put(':riderId/active-order')
  async setRiderActiveOrder(
    @Param('riderId') riderId: string,
    @Body() body: { orderId: string | null },
    @Request() req: any,
  ): Promise<{ success: boolean }> {
    console.log('📦 Setting rider active order:', {
      riderId,
      orderId: body.orderId,
      requestedBy: req.user.id,
    });

    return this.ridersService.setRiderActiveOrder(riderId, body.orderId);
  }
}