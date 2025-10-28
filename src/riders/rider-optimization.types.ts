export interface Location {
  latitude: number;
  longitude: number;
  address?: string;
}

export interface VendorLocation {
  id: string;
  name: string;
  location: Location;
}

export interface VendorGroup {
  vendorId: string;
  items: any[];
  subtotal: number;
}

export interface Cluster {
  vendorIds: string[];
  vendors: VendorLocation[];
}

export interface OptimizedRoute {
  stops: VendorLocation[];
  totalDistance: number;
  estimatedTime: number;
}

export interface RiderAssignment {
  vendorIds: string[];
  rider: any;
  route: OptimizedRoute;
  pricing: {
    base: number;
    stops: number;
    distance: number;
    total: number;
  };
  vehicleType: string;
}

export interface OrderDetails {
  weight: number;
  itemCount: number;
  distance: number;
}

