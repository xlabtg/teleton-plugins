const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";

const WEATHER_CODES = {
  0: "ясно",
  1: "преимущественно ясно",
  2: "переменная облачность",
  3: "пасмурно",
  45: "туман",
  48: "изморозь",
  51: "лёгкая морось",
  53: "морось",
  55: "сильная морось",
  61: "небольшой дождь",
  63: "дождь",
  65: "сильный дождь",
  66: "ледяной дождь",
  67: "сильный ледяной дождь",
  71: "небольшой снег",
  73: "снег",
  75: "сильный снег",
  77: "снежные зёрна",
  80: "ливень",
  81: "сильный ливень",
  82: "очень сильный ливень",
  85: "снегопад",
  86: "сильный снегопад",
  95: "гроза",
  96: "гроза с градом",
  99: "гроза с сильным градом",
};

async function geocode(city) {
  const url = `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=ru`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  return data.results[0];
}

export const manifest = {
  name: "weather",
  version: "1.0.0",
  sdkVersion: ">=1.0.0",
  description: "Current weather and 7-day forecast via Open-Meteo (no API key required).",
};

export const tools = (sdk) => [
  {
    name: "weather_current",
    description:
      "Get current weather for a city. Returns temperature, feels like, humidity, wind speed, and description in Russian. Supports any city name.",
    category: "data-bearing",
    scope: "always",
    parameters: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description:
            'City name (e.g. "Moscow", "Туапсе", "New York", "London")',
        },
      },
      required: ["city"],
    },
    execute: async (params) => {
      try {
        const geo = await geocode(params.city);
        if (!geo) {
          return { success: false, error: `City "${params.city}" not found` };
        }

        const url = `${WEATHER_URL}?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,surface_pressure,weather_code&timezone=auto`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          return { success: false, error: `Weather API error: ${res.status}` };
        }

        const data = await res.json();
        const c = data.current;

        return {
          success: true,
          data: {
            city: geo.name,
            country: geo.country,
            temp: `${Math.round(c.temperature_2m)}°C`,
            feels_like: `${Math.round(c.apparent_temperature)}°C`,
            description: WEATHER_CODES[c.weather_code] || `code ${c.weather_code}`,
            humidity: `${c.relative_humidity_2m}%`,
            wind: `${c.wind_speed_10m} km/h`,
            pressure: `${Math.round(c.surface_pressure)} hPa`,
          },
        };
      } catch (err) {
        sdk.log.error("weather_current:", err.message);
        return {
          success: false,
          error: String(err.message || err).slice(0, 500),
        };
      }
    },
  },

  {
    name: "weather_forecast",
    description:
      "Get 7-day weather forecast for a city. Returns daily min/max temperature and conditions.",
    category: "data-bearing",
    scope: "always",
    parameters: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City name",
        },
      },
      required: ["city"],
    },
    execute: async (params) => {
      try {
        const geo = await geocode(params.city);
        if (!geo) {
          return { success: false, error: `City "${params.city}" not found` };
        }

        const url = `${WEATHER_URL}?latitude=${geo.latitude}&longitude=${geo.longitude}&daily=temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max&timezone=auto`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          return { success: false, error: `Weather API error: ${res.status}` };
        }

        const data = await res.json();
        const d = data.daily;

        const forecast = d.time.map((date, i) => ({
          date,
          temp: `${Math.round(d.temperature_2m_min[i])}..${Math.round(d.temperature_2m_max[i])}°C`,
          description: WEATHER_CODES[d.weather_code[i]] || `code ${d.weather_code[i]}`,
          wind_max: `${d.wind_speed_10m_max[i]} km/h`,
        }));

        return {
          success: true,
          data: {
            city: geo.name,
            country: geo.country,
            forecast,
          },
        };
      } catch (err) {
        sdk.log.error("weather_forecast:", err.message);
        return {
          success: false,
          error: String(err.message || err).slice(0, 500),
        };
      }
    },
  },
];
