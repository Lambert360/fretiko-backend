/**
 * Delivery pricing helpers — pure functions shared by riders, checkout,
 * live-sales and wishlist fee computation.
 *
 * Model:
 *   chargeableWeightKg = max(actual weight, volumetric weight) per unit
 *   volumetric weight  = L*W*H(cm) / divisor (courier standard 5000)
 *   delivery fee       = base_price + per_km_rate*km
 *                        + per_kg_rate * max(0, kg - included_weight_kg)
 *   fixed mode         = fixed_price regardless of distance/weight
 *
 * Configs that predate weight pricing keep working: missing keys make the
 * weight terms no-ops (included_weight_kg defaults to infinity).
 */

export const DEFAULT_VOLUMETRIC_DIVISOR = 5000;
export const DEFAULT_FALLBACK_WEIGHT_KG = 1.0;

export interface WeightedItem {
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
}

export interface DeliveryRate {
  base_price?: number;
  per_km_rate?: number;
  included_weight_kg?: number;
  per_kg_rate?: number;
  mode?: 'fixed' | 'formula';
  fixed_price?: number;
  max_weight_kg?: number;
}

/** Chargeable weight of ONE unit of an item (max of actual vs volumetric). */
export function chargeableWeightKg(
  item: WeightedItem,
  divisor: number = DEFAULT_VOLUMETRIC_DIVISOR,
  fallbackKg: number = DEFAULT_FALLBACK_WEIGHT_KG,
): number {
  const actual = item.weight_kg ?? fallbackKg;
  const volumetric =
    item.length_cm && item.width_cm && item.height_cm
      ? (item.length_cm * item.width_cm * item.height_cm) / divisor
      : 0;
  return Math.max(actual, volumetric);
}

/** Total chargeable weight for a list of items with quantities. */
export function orderWeightKg(
  items: Array<{ item: WeightedItem; quantity: number }>,
  divisor: number = DEFAULT_VOLUMETRIC_DIVISOR,
): number {
  return items.reduce(
    (sum, { item, quantity }) => sum + chargeableWeightKg(item, divisor) * Math.max(1, quantity),
    0,
  );
}

/**
 * Unified delivery fee. Unused terms must be absent/zero in `rate`
 * (e.g. interstate partners set per_km_rate to 0/undefined → pure weight pricing).
 */
export function computeDeliveryFee(
  rate: DeliveryRate,
  distanceKm: number,
  weightKg: number,
): number {
  if (rate.mode === 'fixed') {
    return rate.fixed_price ?? 0;
  }
  const base = (rate.base_price ?? 0) + (rate.per_km_rate ?? 0) * distanceKm;
  const included = rate.included_weight_kg ?? Number.MAX_SAFE_INTEGER;
  const overageKg = Math.max(0, weightKg - included);
  return base + (rate.per_kg_rate ?? 0) * overageKg;
}

/** True when the order weight exceeds the vehicle/partner declared capacity. */
export function exceedsCapacity(rate: DeliveryRate | undefined, weightKg: number): boolean {
  return !!rate?.max_weight_kg && weightKg > rate.max_weight_kg;
}

/**
 * Vehicle-type aliases → pricing_config keys.
 * Single source of truth — used by riders.service quotes and every
 * checkout path that recomputes fees server-side.
 */
export function normalizeVehicleType(type: string): string {
  const map: Record<string, string> = {
    bicycle: 'bike',
    motorcycle: 'bike',
    tricycle: 'wheelbarrow',
    wheelbarrow: 'wheelbarrow',
    car: 'car',
    van: 'van',
    truck: 'truck',
    bike: 'bike',
  };
  return map[type.toLowerCase().trim()] ?? type.toLowerCase().trim();
}

/**
 * Server-side delivery fee for a verified partner rider. Looks up the
 * rider's company in verified_riders, reads that company's
 * pricing_config[vehicleType], and recomputes the fee — the client-sent
 * price is never trusted for charging.
 *
 * Returns null when the rider or their company has no usable pricing
 * config; the caller decides the legacy fallback.
 */
export async function recomputeRiderDeliveryFee(
  supabase: any,
  riderId: string,
  vehicleType: string | undefined,
  distanceKm: number | undefined,
  weightKg: number,
): Promise<number | null> {
  const { data: verifiedRider } = await supabase
    .from('verified_riders')
    .select('company_id, vehicle_type')
    .eq('user_id', riderId)
    .single();

  if (!verifiedRider?.company_id) return null;

  const vehicleKey = normalizeVehicleType(
    vehicleType || verifiedRider.vehicle_type || 'bike',
  );

  const { data: company } = await supabase
    .from('verified_logistics_partners')
    .select('pricing_config')
    .eq('id', verifiedRider.company_id)
    .single();

  const rate: DeliveryRate | undefined = company?.pricing_config?.[vehicleKey];
  if (!rate || (!rate.base_price && rate.fixed_price == null)) return null;

  // If the partner prices by distance but no distance was supplied, the
  // server cannot reproduce the quote — return null so the caller falls
  // back to the legacy client price rather than silently charging base-only.
  if ((rate.per_km_rate ?? 0) > 0 && !(distanceKm != null && distanceKm > 0)) {
    return null;
  }

  return Math.round(computeDeliveryFee(rate, distanceKm ?? 0, weightKg) * 100) / 100;
}

/**
 * Server-side delivery fee for an interstate/international logistics
 * partner, from their interstate_config rates + the order's chargeable
 * weight. Returns null when the partner is missing/inactive or has no
 * pricing configured — caller decides the fallback.
 */
export async function recomputeInterstateDeliveryFee(
  supabase: any,
  companyId: string,
  isInternational: boolean,
  weightKg: number,
): Promise<number | null> {
  const { data: partner } = await supabase
    .from('verified_logistics_partners')
    .select('interstate_config')
    .eq('id', companyId)
    .eq('partner_status', 'active')
    .single();

  const cfg = partner?.interstate_config;
  if (!cfg) return null;

  const rate: DeliveryRate = {
    base_price: isInternational
      ? (cfg.international_base_price ?? cfg.base_price ?? 0)
      : (cfg.base_price ?? 0),
    per_kg_rate: isInternational
      ? (cfg.international_per_kg_rate ?? cfg.per_kg_rate ?? 0)
      : (cfg.per_kg_rate ?? 0),
    included_weight_kg: cfg.included_weight_kg,
  };

  if (!((rate.per_kg_rate ?? 0) > 0 || (rate.base_price ?? 0) > 0)) return null;

  return Math.round(computeDeliveryFee(rate, 0, weightKg) * 100) / 100;
}
