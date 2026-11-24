// Place analytics derived exclusively from real traveler posts stored in MongoDB.
// Nothing here is curated, hardcoded or simulated: every notification and heatmap
// point below originates from a post a traveler actually uploaded.

const INDIA_BOUNDS = { minLon: 68, maxLon: 97, minLat: 8, maxLat: 37 };

// Map a post's stored coordinates onto the India heatmap canvas.
function coordinatesToHeatmapPoint(post, lat, lon) {
  const x = ((lon - INDIA_BOUNDS.minLon) / (INDIA_BOUNDS.maxLon - INDIA_BOUNDS.minLon)) * 100;
  const y = ((INDIA_BOUNDS.maxLat - lat) / (INDIA_BOUNDS.maxLat - INDIA_BOUNDS.minLat)) * 100;
  if (!isFinite(x) || !isFinite(y)) return null;

  return {
    id: `post-${post.id}`,
    x: Math.max(2, Math.min(98, Number(x.toFixed(2)))),
    y: Math.max(2, Math.min(98, Number(y.toFixed(2)))),
    intensity: 0.5,
    type: 'community',
    title: `Community upload by @${post.username}`,
    detail: post.description || 'Traveler upload from the community.',
    username: post.username,
    created_at: post.created_at || null
  };
}

// Analyze platform posts from MongoDB matching the location
function analyzeUserPostsForPlace(location, db) {
  if (!db || !db.posts || !Array.isArray(db.posts)) return { count: 0, flags: [], heatmapPoints: [] };
  const query = (location || '').toLowerCase().trim();
  if (!query) return { count: 0, flags: [], heatmapPoints: [] };

  const queryTerms = query.split(/[\s,]+/).filter(t => t.length > 2);
  const matched = db.posts.filter(post => {
    const loc = (post.location || '').toLowerCase();
    const desc = (post.description || '').toLowerCase();
    const food = (post.food_place || '').toLowerCase();
    const hotel = (post.hotel_name || '').toLowerCase();

    if (loc.includes(query) || desc.includes(query) || food.includes(query) || hotel.includes(query)) return true;
    if (queryTerms.some(term => loc.includes(term) || desc.includes(term))) return true;
    return false;
  });

  const flags = [];
  const heatmapPoints = [];

  matched.forEach(post => {
    const timeStr = post.created_at ? new Date(post.created_at).toLocaleDateString() : 'Recent';

    if (post.route_desc || (post.transport_price && post.transport_price.includes('high'))) {
      flags.push({
        id: `user-${post.id}`,
        category: "traffic",
        icon: "🚗",
        title: `Community Transport Note (@${post.username})`,
        message: post.route_desc || `Transport cost reported: ${post.transport_price}`,
        urgency: "warning",
        locationDetail: post.location || location,
        timestamp: `Posted ${timeStr}`,
        source: "community_post"
      });
    }

    if (post.hotel_feedback && (post.hotel_feedback.toLowerCase().includes('bad') || post.hotel_feedback.toLowerCase().includes('scam') || post.hotel_feedback.toLowerCase().includes('unlit'))) {
      flags.push({
        id: `user-h-${post.id}`,
        category: "safety",
        icon: "🚨",
        title: `Residency Safety Warning (@${post.username})`,
        message: post.hotel_feedback,
        urgency: "high",
        locationDetail: post.hotel_name || post.location || location,
        timestamp: `Posted ${timeStr}`,
        source: "community_post"
      });
    }

    // Heatmap points require real coordinates on the post. Accept both the
    // documented "📍 Coordinates: <lat>, <lon>" format and the bare
    // "<lat>, <lon>" format written by the post wizard. Values embedded in
    // prose or map URLs are still ignored.
    const coordText = String(post.location || '').trim();
    const coordMatch = coordText.match(/📍\s*Coordinates:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i) ||
      coordText.match(/(?:^|[^\d.])(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)(?=$|[^\d.])/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[2]);
      if (isFinite(lat) && isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        const point = coordinatesToHeatmapPoint(post, lat, lon);
        if (point) heatmapPoints.push(point);
      }
    }
  });

  return {
    count: matched.length,
    flags,
    heatmapPoints
  };
}

// Master Analytics Generator - community data only.
function generatePlaceAnalytics(location, db) {
  const normLocation = (location || '').trim();
  const userAnalysis = analyzeUserPostsForPlace(normLocation, db);

  return {
    locationName: normLocation,
    // These metrics have no verified data source in the platform, so they stay null
    // instead of being filled with made-up values.
    safetyIndex: null,
    trafficIndex: null,
    infraRating: null,
    bestHours: null,
    avoidHours: null,
    heatmapPoints: userAnalysis.heatmapPoints,
    notifications: userAnalysis.flags,
    userPostsCount: userAnalysis.count,
    dataSource: 'community_posts'
  };
}

module.exports = {
  generatePlaceAnalytics
};
