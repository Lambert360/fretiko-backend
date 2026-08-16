import { Controller, Post, Get, Put, Body, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RidersService } from './riders.service';

export interface RiderLocation {
  latitude: number;
  longitude: number;
  address: string;
  state?: string;   // e.g. "Lagos" — used for rider & partner eligibility filtering
  country?: string; // e.g. "Nigeria"
  city?: string;    // e.g. "Ikeja"
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
  // Item types in the order ('product' | 'service'). When 'service' is present,
  // only motorized riders (car/van/truck) are eligible — never bikes/wheelbarrows.
  itemTypes?: string[];
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
  deliveryPromise?: string;
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

  @Post('interstate-options')
  async getInterstateOptions(
    @Body() request: {
      pickupLocation: { state?: string; country?: string };
      deliveryLocation: { state?: string; country?: string };
    },
  ) {
    console.log('🚛 Finding interstate delivery companies:', {
      pickup: request.pickupLocation,
      delivery: request.deliveryLocation,
    });

    return this.ridersService.findInterstateCompanies(
      request.pickupLocation?.state,
      request.pickupLocation?.country,
      request.deliveryLocation?.state,
      request.deliveryLocation?.country,
    );
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

  // ===== RIDER ASSIGNMENT ENDPOINTS =====

  @Post('assignments/:orderId/accept')
  async acceptAssignment(
    @Param('orderId') orderId: string,
    @Request() req: any,
  ): Promise<{
    success: boolean;
    message: string;
    order?: {
      id: string;
      orderNumber: string;
      deliveryFee: number;
      pickupAddress: string;
      deliveryAddress: string;
      estimatedPickup: string;
      estimatedDelivery: string;
    };
  }> {
    console.log('✅ Rider accepting assignment:', {
      orderId,
      riderId: req.user.id,
    });

    return this.ridersService.acceptRiderAssignment(orderId, req.user.id);
  }

  @Post('assignments/:orderId/reject')
  async rejectAssignment(
    @Param('orderId') orderId: string,
    @Body() body: { reason?: string },
    @Request() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    console.log('❌ Rider rejecting assignment:', {
      orderId,
      riderId: req.user.id,
      reason: body.reason,
    });

    return this.ridersService.rejectRiderAssignment(orderId, req.user.id, body.reason);
  }

  @Get('assignments/pending')
  async getPendingAssignments(
    @Request() req: any,
  ): Promise<{
    assignments: Array<{
      id: string;
      orderNumber: string;
      deliveryFee: number;
      pickupAddress: string;
      deliveryAddress: string;
      assignedAt: string;
      deadline: string;
      timeRemaining: number; // seconds
    }>;
  }> {
    console.log('📋 Getting pending assignments for rider:', {
      riderId: req.user.id,
    });

    const assignments = await this.ridersService.getPendingAssignments(req.user.id);
    return { assignments };
  }

  // ===== REPLACEMENT WORKFLOW ENDPOINTS =====

  @Post('replacements/:orderId/initiate')
  async initiateReplacement(
    @Param('orderId') orderId: string,
    @Request() req: any,
  ): Promise<{
    success: boolean;
    stage: 'vendor_selection' | 'fastest_finger' | 'completed' | 'failed';
    message: string;
    data?: any;
  }> {
    console.log('🔄 Initiating replacement workflow:', {
      orderId,
      userId: req.user.id,
    });

    // This would call the replacement workflow service
    // For now, return a placeholder response
    return {
      success: true,
      stage: 'vendor_selection',
      message: 'Replacement workflow initiated - implementation pending',
    };
  }

  @Post('replacements/:orderId/vendor-select')
  async vendorSelectRider(
    @Param('orderId') orderId: string,
    @Body() body: { riderId: string },
    @Request() req: any,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    console.log('🎯 Vendor selecting rider for replacement:', {
      orderId,
      riderId: body.riderId,
      vendorId: req.user.id,
    });

    // This would call the replacement workflow service
    return {
      success: true,
      message: 'Vendor selection processed - implementation pending',
    };
  }

  @Get('replacements/:orderId/status')
  async getReplacementStatus(
    @Param('orderId') orderId: string,
    @Request() req: any,
  ): Promise<{
    stage: string;
    deadline?: string;
    availableRiders?: any[];
    message: string;
  }> {
    console.log('📊 Getting replacement status:', {
      orderId,
      userId: req.user.id,
    });

    // This would call the replacement workflow service
    return {
      stage: 'none',
      message: 'No replacement in progress',
    };
  }
}