/**
 * Site check-in geometry (DECISIONS 31).
 *
 * The threshold is a CONSTANT, not a setting, and that is deliberate. The
 * owner set it at 500 m and it is a review grouping, not a gate: attendance is
 * never refused on location grounds (DECISIONS 31), so a wrong threshold loses
 * nothing -- a far day still stands and Sushma still sees it. A threshold that
 * gates a write needs configurability; one that only colours a flag does not.
 */
export const SITE_FAR_THRESHOLD_M = 500

export interface LatLng {
  lat: number
  lng: number
}

const EARTH_RADIUS_M = 6_371_000

/**
 * Great-circle distance between two points, in metres (haversine).
 *
 * Haversine rather than an equirectangular approximation: the sites sit within
 * a few degrees of latitude of each other, but the formula is three lines and
 * the flat-earth version quietly drifts on east-west distances, which is
 * exactly the axis a check-in at the far end of a site moves along.
 */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Whether a reading is far from its site.
 *
 * `null` site coordinates mean the flag cannot be established, so it is false:
 * a missing site location must not look like a policy violation, and the
 * far-flag day view is the place Sushma finds readings with no site to compare
 * against, by their absence from it. on_duty_travel gets no exemption
 * (DECISIONS 31) -- a travel day flags far like any other if the reading is
 * beyond the threshold.
 */
export function isFarFromSite(reading: LatLng, site: LatLng | null): boolean {
  if (site === null) return false
  return distanceMeters(reading, site) > SITE_FAR_THRESHOLD_M
}

/**
 * Whether a reading is a real position, not a failure wearing coordinates.
 *
 * (0, 0) is the Atlantic off Ghana and also what a GPS failure, a denied
 * permission prompt, or an unset form field serialises to -- which is exactly
 * why a 0,0 row passed every check in the first version: it is in range, so it
 * computed a plausible distance and flagged false, recording a worker in the
 * ocean with a clean on-site bill of health. Range bounds are strict
 * latitudes (-90, 90) and longitudes (-180, 180); anything outside them is
 * garbage, not a position.
 *
 * The caller's contract for an invalid reading is DECISIONS 31's: store NULL,
 * set the flag to unavailable, and let the check-in stand. This function
 * judges the reading, never the worker.
 */
export function isValidReading(reading: LatLng): boolean {
  const { lat, lng } = reading
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  if (lat === 0 && lng === 0) return false
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}
