import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { RidersService } from './riders.service';
import {
  Location,
  VendorLocation,
  VendorGroup,
  Cluster,
  OptimizedRoute,
  RiderAssignment,
  OrderDetails,
} from './rider-optimization.types';

@Injectable()
export class RiderOptimizationService {
  private supabase;

  constructor(
    private ridersService: RidersService,
    private configService: ConfigService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  async optimizeRiderAssignment(
    vendorGroups: VendorGroup[],
    buyerLocation: Location,
    orderDetails: OrderDetails
  ): Promise<RiderAssignment[]> {
    
    // 1. Get vendor locations
    const vendorLocations = await this.getVendorLocations(vendorGroups.map(g => g.vendorId));
    
    // 2. Calculate proximity threshold (2km)
    const proximityThreshold = 2; // km
    
    // 3. Cluster vendors by proximity
    const clusters = this.clusterVendorsByProximity(vendorLocations, proximityThreshold);
    
    // 4. For each cluster, determine optimal rider assignment
    const assignments: RiderAssignment[] = [];
    
    for (const cluster of clusters) {
      const clusterOrders = vendorGroups.filter(g => cluster.vendorIds.includes(g.vendorId));
      
      // Calculate total weight and volume
      const totalWeight = this.calculateTotalWeight(clusterOrders);
      const totalVolume = this.calculateTotalVolume(clusterOrders);
      
      // Determine required vehicle type
      const requiredVehicle = this.determineVehicleType(totalWeight, totalVolume);
      
      // Find farthest vendor in cluster (starting point for rider)
      const farthestVendor = this.findFarthestVendorFromBuyer(cluster.vendors, buyerLocation);
      
      // Query nearby riders from farthest vendor location
      const nearbyRiders = await this.ridersService.findNearbyRiders({
        pickupLocation: {
          latitude: farthestVendor.location.latitude,
          longitude: farthestVendor.location.longitude,
          address: farthestVendor.location.address || 'Vendor Location',
        },
        deliveryLocation: {
          latitude: buyerLocation.latitude,
          longitude: buyerLocation.longitude,
          address: buyerLocation.address || 'Delivery Location',
        },
        orderDetails: {
          weight: totalWeight,
          itemCount: clusterOrders.reduce((sum, o) => sum + o.items.length, 0),
          distance: this.calculateRouteDistance(cluster.vendors, buyerLocation),
        },
        maxDistance: 5,
      }, null);
      
      // Filter by vehicle capacity
      const suitableRiders = nearbyRiders.filter(r => 
        this.canHandleCapacity(r.vehicleType, totalWeight, totalVolume)
      );
      
      if (suitableRiders.length === 0) {
        // No single rider can handle - split cluster further
        const splitAssignments = await this.splitClusterByCapacity(clusterOrders, buyerLocation);
        assignments.push(...splitAssignments);
      } else {
        // Optimize route through all vendors
        const optimizedRoute = this.optimizeMultiStopRoute(cluster.vendors, buyerLocation);
        
        // Calculate multi-stop pricing: base + (₦0.5 × extra_stops) + distance
        const baseFee = this.getBasePriceByVehicle(requiredVehicle);
        const extraStops = cluster.vendors.length - 1; // First stop included in base
        const stopFee = extraStops * 0.5;
        const distanceFee = optimizedRoute.totalDistance * this.getPerKmRate(requiredVehicle);
        const totalFee = baseFee + stopFee + distanceFee;
        
        assignments.push({
          vendorIds: cluster.vendorIds,
          rider: suitableRiders[0], // Best rated
          route: optimizedRoute,
          pricing: {
            base: baseFee,
            stops: stopFee,
            distance: distanceFee,
            total: Math.round(totalFee * 100) / 100,
          },
          vehicleType: requiredVehicle,
        });
      }
    }
    
    return assignments;
  }
  
  private clusterVendorsByProximity(vendors: VendorLocation[], threshold: number): Cluster[] {
    // Implement clustering algorithm (simple distance-based grouping)
    const clusters: Cluster[] = [];
    const visited = new Set();
    
    vendors.forEach((vendor, i) => {
      if (visited.has(vendor.id)) return;
      
      const cluster = {
        vendorIds: [vendor.id],
        vendors: [vendor],
      };
      
      // Find all vendors within threshold distance
      vendors.forEach((other, j) => {
        if (i !== j && !visited.has(other.id)) {
          const distance = this.calculateDistance(vendor.location, other.location);
          if (distance <= threshold) {
            cluster.vendorIds.push(other.id);
            cluster.vendors.push(other);
            visited.add(other.id);
          }
        }
      });
      
      visited.add(vendor.id);
      clusters.push(cluster);
    });
    
    return clusters;
  }
  
  private findFarthestVendorFromBuyer(vendors: VendorLocation[], buyerLocation: Location): VendorLocation {
    let farthest = vendors[0];
    let maxDistance = 0;
    
    vendors.forEach(vendor => {
      const distance = this.calculateDistance(vendor.location, buyerLocation);
      if (distance > maxDistance) {
        maxDistance = distance;
        farthest = vendor;
      }
    });
    
    return farthest;
  }
  
  private optimizeMultiStopRoute(vendors: VendorLocation[], buyerLocation: Location): OptimizedRoute {
    // Traveling Salesman Problem (TSP) - use nearest neighbor heuristic
    const stops = [...vendors];
    const route: VendorLocation[] = [];
    let currentLocation = vendors[0].location; // Start from farthest
    let totalDistance = 0;
    
    while (stops.length > 0) {
      let nearest = stops[0];
      let minDistance = this.calculateDistance(currentLocation, nearest.location);
      let nearestIndex = 0;
      
      stops.forEach((stop, i) => {
        const distance = this.calculateDistance(currentLocation, stop.location);
        if (distance < minDistance) {
          minDistance = distance;
          nearest = stop;
          nearestIndex = i;
        }
      });
      
      route.push(nearest);
      totalDistance += minDistance;
      currentLocation = nearest.location;
      stops.splice(nearestIndex, 1);
    }
    
    // Add final leg to buyer
    totalDistance += this.calculateDistance(currentLocation, buyerLocation);
    
    return {
      stops: route,
      totalDistance: Math.round(totalDistance * 10) / 10,
      estimatedTime: Math.round(totalDistance * 3), // 3 min per km
    };
  }

  private async getVendorLocations(vendorIds: string[]): Promise<VendorLocation[]> {
    const { data, error } = await this.supabase
      .from('user_profiles')
      .select('id, username, location')
      .in('id', vendorIds);
      
    if (error) throw new Error('Failed to fetch vendor locations');
    
    return data.map(vendor => ({
      id: vendor.id,
      name: vendor.username,
      location: vendor.location || { latitude: 6.5244, longitude: 3.3792 }, // Default Lagos
    }));
  }

  private calculateDistance(loc1: Location, loc2: Location): number {
    // Haversine formula for distance calculation
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(loc2.latitude - loc1.latitude);
    const dLon = this.toRad(loc2.longitude - loc1.longitude);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(loc1.latitude)) * Math.cos(this.toRad(loc2.latitude)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  private calculateTotalWeight(orders: any[]): number {
    return orders.reduce((sum, order) => {
      return sum + order.items.reduce((itemSum, item) => itemSum + (item.quantity * 0.5), 0);
    }, 0);
  }

  private calculateTotalVolume(orders: any[]): number {
    return orders.reduce((sum, order) => {
      return sum + order.items.reduce((itemSum, item) => itemSum + (item.quantity * 0.01), 0); // 0.01 m³ per item
    }, 0);
  }

  private determineVehicleType(weight: number, volume: number): string {
    if (weight > 50 || volume > 2) return 'truck';
    if (weight > 20 || volume > 1) return 'van';
    if (weight > 10 || volume > 0.5) return 'car';
    if (weight > 5) return 'bike';
    return 'wheelbarrow';
  }

  private canHandleCapacity(vehicleType: string, weight: number, volume: number): boolean {
    const capacities = {
      wheelbarrow: { weight: 5, volume: 0.1 },
      bike: { weight: 10, volume: 0.5 },
      car: { weight: 20, volume: 1 },
      van: { weight: 50, volume: 2 },
      truck: { weight: 200, volume: 10 },
    };
    
    const capacity = capacities[vehicleType] || capacities.bike;
    return weight <= capacity.weight && volume <= capacity.volume;
  }

  private getBasePriceByVehicle(vehicleType: string): number {
    const prices = {
      wheelbarrow: 2,
      bike: 3,
      car: 5,
      van: 7,
      truck: 10,
    };
    return prices[vehicleType] || prices.bike;
  }

  private getPerKmRate(vehicleType: string): number {
    const rates = {
      wheelbarrow: 0.3,
      bike: 0.5,
      car: 1,
      van: 1.5,
      truck: 2,
    };
    return rates[vehicleType] || rates.bike;
  }

  private calculateRouteDistance(vendors: VendorLocation[], buyerLocation: Location): number {
    let totalDistance = 0;
    
    for (let i = 0; i < vendors.length - 1; i++) {
      totalDistance += this.calculateDistance(vendors[i].location, vendors[i + 1].location);
    }
    
    // Add final leg to buyer
    if (vendors.length > 0) {
      totalDistance += this.calculateDistance(vendors[vendors.length - 1].location, buyerLocation);
    }
    
    return totalDistance;
  }

  private async splitClusterByCapacity(orders: any[], buyerLocation: Location): Promise<any[]> {
    // Split orders into smaller groups that fit vehicle capacity
    const assignments: any[] = [];
    let currentGroup: any[] = [];
    let currentWeight = 0;
    let currentVolume = 0;
    
    for (const order of orders) {
      const orderWeight = this.calculateTotalWeight([order]);
      const orderVolume = this.calculateTotalVolume([order]);
      
      // Check if adding this order exceeds max capacity (van)
      if (currentWeight + orderWeight > 50 || currentVolume + orderVolume > 2) {
        // Process current group
        if (currentGroup.length > 0) {
          const assignment = await this.createAssignmentForGroup(currentGroup, buyerLocation);
          assignments.push(assignment);
        }
        
        // Start new group
        currentGroup = [order];
        currentWeight = orderWeight;
        currentVolume = orderVolume;
      } else {
        currentGroup.push(order);
        currentWeight += orderWeight;
        currentVolume += orderVolume;
      }
    }
    
    // Process remaining group
    if (currentGroup.length > 0) {
      const assignment = await this.createAssignmentForGroup(currentGroup, buyerLocation);
      assignments.push(assignment);
    }
    
    return assignments;
  }

  private async createAssignmentForGroup(orders: any[], buyerLocation: Location): Promise<any> {
    // Helper to create assignment for a split group
    const vendorIds = orders.map(o => o.vendorId);
    const vendorLocations = await this.getVendorLocations(vendorIds);
    
    const totalWeight = this.calculateTotalWeight(orders);
    const totalVolume = this.calculateTotalVolume(orders);
    const vehicleType = this.determineVehicleType(totalWeight, totalVolume);
    
    const farthestVendor = this.findFarthestVendorFromBuyer(vendorLocations, buyerLocation);
    
    const nearbyRiders = await this.ridersService.findNearbyRiders({
      pickupLocation: {
        latitude: farthestVendor.location.latitude,
        longitude: farthestVendor.location.longitude,
        address: farthestVendor.location.address || 'Vendor Location',
      },
      deliveryLocation: {
        latitude: buyerLocation.latitude,
        longitude: buyerLocation.longitude,
        address: buyerLocation.address || 'Delivery Location',
      },
      orderDetails: {
        weight: totalWeight,
        itemCount: orders.reduce((sum, o) => sum + o.items.length, 0),
        distance: this.calculateRouteDistance(vendorLocations, buyerLocation),
      },
      maxDistance: 5,
    }, null);
    
    const suitableRiders = nearbyRiders.filter(r => 
      this.canHandleCapacity(r.vehicleType, totalWeight, totalVolume)
    );
    
    if (suitableRiders.length === 0) {
      throw new Error('No suitable riders available for split order group');
    }
    
    const optimizedRoute = this.optimizeMultiStopRoute(vendorLocations, buyerLocation);
    
    const baseFee = this.getBasePriceByVehicle(vehicleType);
    const extraStops = vendorLocations.length - 1;
    const stopFee = extraStops * 0.5;
    const distanceFee = optimizedRoute.totalDistance * this.getPerKmRate(vehicleType);
    const totalFee = baseFee + stopFee + distanceFee;
    
    return {
      vendorIds: vendorIds,
      rider: suitableRiders[0],
      route: optimizedRoute,
      pricing: {
        base: baseFee,
        stops: stopFee,
        distance: distanceFee,
        total: Math.round(totalFee * 100) / 100,
      },
      vehicleType: vehicleType,
    };
  }
}

