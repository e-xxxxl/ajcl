/**
 * Google Maps Platform configuration.
 *
 * The browser does the real map work (autocomplete, place details, routing).
 * The server's only Maps use is an optional cross-check of the browser-measured
 * distance before pricing — it needs an unrestricted or IP-restricted
 * GOOGLE_MAPS_API_KEY with "Places API (New)" + "Routes API" enabled.
 */

export const MAPS_CONFIG = {
  autocompleteDebounceMs: 400,
  autocompleteMinChars: 3,
  region: "ng",
  language: "en",
  placesAutocompleteUrl: "https://places.googleapis.com/v1/places:autocomplete",
  placeDetailsUrl: (placeId: string) => `https://places.googleapis.com/v1/places/${placeId}`,
  computeRoutesUrl: "https://routes.googleapis.com/directions/v2:computeRoutes",
  defaultCenter: { lat: 6.5244, lng: 3.3792 },
  defaultZoom: 11,
} as const;

/** Fallback average speed (km/h) for ETA when Routes API is not configured. */
export const FALLBACK_AVERAGE_SPEED_KMH = 24;
