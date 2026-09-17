import { Sun, CloudSun, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning, type LucideIcon } from 'lucide-react-native';

export type CurrentWeather = { weatherCode: number; feelsLikeC: number; windSpeedMs: number };

// Live weather for the ongoing-trip module, distinct from the backend's historical-forecast lookup for a finished trip.
export async function fetchCurrentWeather(lat: number, lon: number): Promise<CurrentWeather | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=apparent_temperature,weather_code,wind_speed_10m&wind_speed_unit=ms`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json();
  const current = body?.current;
  if (!current) return null;
  return {
    weatherCode: current.weather_code,
    feelsLikeC: current.apparent_temperature,
    windSpeedMs: current.wind_speed_10m,
  };
}

/** WMO weather_code -> icon/label, per Open-Meteo's code table (open-meteo.com/en/docs). */
export function weatherMeta(code: number | null): { Icon: LucideIcon; label: string } | null {
  if (code === null) return null;
  if (code === 0) return { Icon: Sun, label: 'Clear' };
  if (code === 1 || code === 2) return { Icon: CloudSun, label: 'Partly cloudy' };
  if (code === 3) return { Icon: Cloud, label: 'Overcast' };
  if (code === 45 || code === 48) return { Icon: CloudFog, label: 'Fog' };
  if ([51, 53, 55, 56, 57].includes(code)) return { Icon: CloudDrizzle, label: 'Drizzle' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { Icon: CloudRain, label: 'Rain' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { Icon: CloudSnow, label: 'Snow' };
  if ([95, 96, 99].includes(code)) return { Icon: CloudLightning, label: 'Thunderstorm' };
  return { Icon: Cloud, label: 'Weather' };
}

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Open-Meteo's windDirectionDeg is the direction the wind blows *from* (0=N/90=E/...);
 * this just gives that a human-readable compass label instead of raw degrees. */
export function compassDirection(deg: number | null | undefined): string {
  if (deg == null) return 'an unknown direction';
  const index = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_POINTS[index];
}
