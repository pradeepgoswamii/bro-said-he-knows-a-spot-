// Place analytics derived exclusively from real traveler posts stored in MongoDB.
// Nothing here is curated or simulated: every notification, heatmap point and
// metric below originates from posts that travelers actually uploaded, or from
// coordinates resolved for the place names those travelers wrote.

const INDIA_BOUNDS = { minLon: 68, maxLon: 97, minLat: 8, maxLat: 37 };
const geocodeCache = new Map();

// Resolve a traveler-written place name to real coordinates. Failure is never
// fatal: posts with explicit coordinates still work without this lookup.
async function geocodePlace(place) {
  const name = String(place || '').trim();
  if (!name) return null;
  if (geocodeCache.has(name)) return geocodeCache.get(name);

  let result = null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'BroSaidHeKnowsASpot/1.0 (community travel analytics)' },
      signal: AbortSignal.timeout(6000)
    });
    if (response.ok) {
      const rows = await response.json();
      const hit = rows && rows[0];
      if (hit) {
        const lat = parseFloat(hit.lat);
        const lon = parseFloat(hit.lon);
        if (isFinite(lat) && isFinite(lon) &&
            lat >= INDIA_BOUNDS.minLat && lat <= INDIA_BOUNDS.maxLat &&
            lon >= INDIA_BOUNDS.minLon && lon <= INDIA_BOUNDS.maxLon) {
          result = { lat, lon };
        }
      }
    }
  } catch (err) {
    // Offline or rate-limited: keep the post in the feed, just without a dot.
  }
  geocodeCache.set(name, result);
  return result;
}

// Map a post's coordinates onto the India heatmap canvas.
function coordinatesToHeatmapPoint(post, lat, lon, flags) {
  const x = ((lon - INDIA_BOUNDS.minLon) / (INDIA_BOUNDS.maxLon - INDIA_BOUNDS.minLon)) * 100;
  const y = ((INDIA_BOUNDS.maxLat - lat) / (INDIA_BOUNDS.maxLat - INDIA_BOUNDS.minLat)) * 100;
  if (!isFinite(x) || !isFinite(y)) return null;

  const categories = new Set(flags.map(f => f.category));
  let type = 'community';
  if (categories.has('safety') || categories.has('scams')) type = 'safety';
  else if (categories.has('weather')) type = 'weather';
  else if (categories.has('traffic')) type = 'traffic';

  const base = type === 'safety' ? 0.8 : type === 'weather' ? 0.7 : type === 'traffic' ? 0.65 : 0.45;
  const intensity = Math.min(1, Number((base + flags.length * 0.08).toFixed(2)));

  return {
    id: `post-${post.id}`,
    x: Math.max(2, Math.min(98, Number(x.toFixed(2)))),
    y: Math.max(2, Math.min(98, Number(y.toFixed(2)))),
    intensity,
    type,
    title: `Community upload by @${post.username || 'traveler'}`,
    detail: [post.description, post.location].filter(Boolean).join(' — ') || 'Traveler upload from the community.',
    username: post.username,
    created_at: post.created_at || null,
    flag_count: flags.length
  };
}

// Build advisories from the content of one real community post.
function flagsForPost(post, searchedLocation) {
  const text = [
    post.description, post.hotel_feedback, post.food_feedback,
    post.route_desc, post.must_visit_name, post.transport_type
  ].filter(Boolean).join(' ').toLowerCase();
  const timeStr = post.created_at ? new Date(post.created_at).toLocaleDateString() : 'Recent';
  const flags = [];

  if (post.route_desc || /traffic|jam|congest|high cost|expensive fare/.test(text)) {
    flags.push({
      id: `user-traffic-${post.id}`,
      category: 'traffic',
      icon: '🚗',
      title: `Transport note by @${post.username || 'traveler'}`,
      message: post.route_desc || 'Travelers reported costly or congested transport here.',
      urgency: 'warning',
      locationDetail: post.location || searchedLocation,
      timestamp: `Posted ${timeStr}`,
      source: 'community_post'
    });
  }

  if (/scam|cheat|overcharg|fraud|fake|dup[eé]/i.test(text)) {
    flags.push({
      id: `user-scam-${post.id}`,
      category: 'scams',
      icon: '🎣',
      title: `Scam alert by @${post.username || 'traveler'}`,
      message: 'A traveler reported scam or overcharging behaviour at this spot.',
      urgency: 'high',
      locationDetail: post.hotel_name || post.food_place || post.location || searchedLocation,
      timestamp: `Posted ${timeStr}`,
      source: 'community_post'
    });
  }

  if (/rain|storm|flood|landslide|snow|heatwave|cloudburst|weather|icy/.test(text)) {
    flags.push({
      id: `user-weather-${post.id}`,
      category: 'weather',
      icon: '🌦️',
      title: `Weather note by @${post.username || 'traveler'}`,
      message: 'A traveler mentioned weather conditions affecting this spot.',
      urgency: 'warning',
      locationDetail: post.location || searchedLocation,
      timestamp: `Posted ${timeStr}`,
      source: 'community_post'
    });
  }

  if (/bad|unlit|unsafe|danger|harass|theft|risky|scary|avoid alone/.test(text)) {
    flags.push({
      id: `user-safety-${post.id}`,
      category: 'safety',
      icon: '🚨',
      title: `Safety warning by @${post.username || 'traveler'}`,
      message: post.hotel_feedback || post.description || 'A traveler flagged a safety concern here.',
      urgency: 'high',
      locationDetail: post.hotel_name || post.location || searchedLocation,
      timestamp: `Posted ${timeStr}`,
      source: 'community_post'
    });
  }

  return flags;
}

// Extract coordinates the post wizard stores as "<lat>, <lon>", optionally
// prefixed with a place name or the documented "📍 Coordinates:" label.
function coordinatesFromLocation(location) {
  const coordText = String(location || '').trim();
  const match = coordText.match(/📍\s*Coordinates:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i) ||
    coordText.match(/(?:^|[^\d.])(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)(?=$|[^\d.])/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function matchPosts(location, db) {
  const query = (location || '').toLowerCase().trim();
  if (!query) return [];
  const terms = query.split(/[\s,]+/).filter(t => t.length > 2);
  return (db.posts || []).filter(post => {
    const fields = [post.location, post.description, post.food_place, post.hotel_name, post.must_visit_name]
      .filter(Boolean).map(v => String(v).toLowerCase());
    if (fields.some(field => field.includes(query))) return true;
    return terms.some(term => fields.some(field => field.includes(term)));
  });
}

// Analyze platform posts from MongoDB matching the location.
async function analyzeUserPostsForPlace(location, db) {
  if (!db || !Array.isArray(db.posts)) return { count: 0, flags: [], heatmapPoints: [] };
  const matched = matchPosts(location, db);
  const flags = [];
  const heatmapPoints = [];

  matched.forEach(post => {
    const postFlags = flagsForPost(post, location);
    flags.push(...postFlags);

    const coords = coordinatesFromLocation(post.location);
    if (coords) {
      const point = coordinatesToHeatmapPoint(post, coords.lat, coords.lon, postFlags);
      if (point) heatmapPoints.push(point);
    }
  });

  // Posts that only name a place still deserve a real map position. Resolve
  // distinct names once, up to a small limit, so a search stays responsive.
  const unresolved = matched.filter(post => !coordinatesFromLocation(post.location));
  const uniqueNames = [...new Set(unresolved.map(post => String(post.location || '').trim()).filter(Boolean))].slice(0, 5);
  for (const name of uniqueNames) {
    const coords = await geocodePlace(name);
    if (!coords) continue;
    unresolved.filter(post => String(post.location || '').trim() === name).forEach(post => {
      const point = coordinatesToHeatmapPoint(post, coords.lat, coords.lon, flags.filter(f => f.id.endsWith(`-${post.id}`)));
      if (point) heatmapPoints.push(point);
    });
  }

  return { count: matched.length, flags, heatmapPoints };
}

// Master analytics generator - community data only.
async function generatePlaceAnalytics(location, db) {
  const normLocation = String(location || '').trim();
  const analysis = await analyzeUserPostsForPlace(normLocation, db);
  const categories = analysis.flags.reduce((acc, f) => {
    acc[f.category] = (acc[f.category] || 0) + 1;
    return acc;
  }, {});
  const totalFlags = analysis.flags.length;

  // Every metric is derived from uploaded posts; null means no reports yet.
  const safetyIndex = analysis.count
    ? Math.max(1, Math.min(10, 10 - (categories.safety || 0) * 2 - (categories.scams || 0) * 2 - (categories.traffic || 0)))
    : null;
  const trafficIndex = analysis.count
    ? `${categories.traffic || 0} transport ${(categories.traffic || 0) === 1 ? 'note' : 'notes'}`
    : null;
  const avoidHours = analysis.count && (categories.weather || 0)
    ? 'Weather-affected hours reported'
    : analysis.count && (categories.traffic || 0)
      ? 'Peak travel hours reported'
      : null;

  return {
    locationName: normLocation,
    safetyIndex,
    trafficIndex,
    infraRating: null,
    bestHours: null,
    avoidHours,
    heatmapPoints: analysis.heatmapPoints,
    notifications: analysis.flags,
    userPostsCount: analysis.count,
    flagCount: totalFlags,
    dataSource: 'community_posts'
  };
}

module.exports = { generatePlaceAnalytics };
