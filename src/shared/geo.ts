/**
 * Geo helpers — pure functions shared by riders, checkout, live-sales
 * and wishlist distance computation. No map/provider dependency:
 * straight-line (haversine) distance from raw lat/lng pairs.
 */

/** Urban road circuity — straight-line distance understates road
 * distance; ~1.3 is the standard Nigerian-city approximation. */
export const ROAD_CIRCUITY_FACTOR = 1.3;

export interface GeoPoint {
  latitude?: number | null;
  longitude?: number | null;
}

/** The hardcoded Lagos coord older mobile builds send as a mock.
 *  Treated as "no coords" server-side so legacy clients fall back to
 *  orderDetails.distance instead of pricing a ~0km route. */
export function isLegacyMockCoord(p: GeoPoint | null | undefined): boolean {
  return (
    !!p
    && Math.abs((p.latitude ?? 0) - 6.5244) < 0.0005
    && Math.abs((p.longitude ?? 0) - 3.3792) < 0.0005
  );
}

/** True when both coords are present and finite. */
export function hasCoords(p: GeoPoint | null | undefined): p is { latitude: number; longitude: number } {
  return (
    !!p
    && p.latitude != null
    && p.longitude != null
    && Number.isFinite(p.latitude)
    && Number.isFinite(p.longitude)
  );
}

/** Great-circle distance in km between two coord pairs. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371; // Earth radius km
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad((b.latitude ?? 0) - (a.latitude ?? 0));
  const dLon = toRad((b.longitude ?? 0) - (a.longitude ?? 0));
  const lat1 = toRad(a.latitude ?? 0);
  const lat2 = toRad(b.latitude ?? 0);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Estimated road distance in km (haversine × circuity). */
export function roadDistanceKm(a: GeoPoint, b: GeoPoint): number {
  return haversineKm(a, b) * ROAD_CIRCUITY_FACTOR;
}
