const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.env');

// Simple .env parser and writer without external dependency
function loadEnv() {
  if (fs.existsSync(ENV_FILE)) {
    try {
      const content = fs.readFileSync(ENV_FILE, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.substring(0, eqIdx).trim();
          let val = trimmed.substring(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          process.env[key] = val;
        }
      });
    } catch (e) {
      console.warn('Could not read .env file:', e.message);
    }
  }
}

loadEnv();

function saveGroqKey(apiKey) {
  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  }
  let found = false;
  lines = lines.map(line => {
    if (line.trim().startsWith('GROQ_API_KEY=')) {
      found = true;
      return `GROQ_API_KEY="${apiKey}"`;
    }
    return line;
  });
  if (!found) {
    lines.push(`GROQ_API_KEY="${apiKey}"`);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
  process.env.GROQ_API_KEY = apiKey;
}

function getGroqKeyStatus() {
  const key = process.env.GROQ_API_KEY || '';
  if (!key) return { configured: false, masked: null };
  const masked = key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : '****';
  return { configured: true, masked };
}

// Search DB posts for matching destination or coordinates
function searchPlatformPosts(destination, db) {
  if (!db || !db.posts || !Array.isArray(db.posts)) return [];
  const query = (destination || '').toLowerCase().trim();
  if (!query) return [];

  const queryTerms = query.split(/[\s,]+/).filter(t => t.length > 2);

  return db.posts.filter(post => {
    const loc = (post.location || '').toLowerCase();
    const desc = (post.description || '').toLowerCase();
    const foodPlace = (post.food_place || '').toLowerCase();
    const foodLoc = (post.food_location || '').toLowerCase();
    const mustVisit = (post.must_visit_name || '').toLowerCase();
    const hotel = (post.hotel_name || '').toLowerCase();

    // Direct match
    if (loc.includes(query) || desc.includes(query) || foodPlace.includes(query) || mustVisit.includes(query) || hotel.includes(query)) {
      return true;
    }

    // Term-by-term match
    if (queryTerms.some(term => loc.includes(term) || desc.includes(term) || mustVisit.includes(term) || foodPlace.includes(term))) {
      return true;
    }

    return false;
  });
}

// Extract signals from matched platform posts
function extractInfluencerSignals(matchedPosts) {
  if (!matchedPosts || matchedPosts.length === 0) return null;

  const stays = [];
  const transports = [];
  const routes = [];
  const foods = [];
  const spots = [];
  const influencers = new Set();

  matchedPosts.forEach(post => {
    if (post.username) influencers.add(post.username);

    if (post.hotel_name || post.hotel_feedback) {
      stays.push({
        name: post.hotel_name || 'Verified Community Stay',
        note: post.hotel_feedback || 'Recommended by verified community traveler',
        contact: post.hotel_contact || 'Available via platform community',
        influencer: post.username
      });
    }

    if (post.transport_type) {
      transports.push({
        type: post.transport_type,
        price: post.transport_price || 'Local rate',
        contact: post.transport_contact || 'Local pickup point',
        influencer: post.username
      });
    }

    if (post.route_desc) {
      routes.push({
        description: post.route_desc,
        cost: post.route_cost || 'N/A',
        influencer: post.username
      });
    }

    if (post.food_place || post.food_feedback) {
      foods.push({
        place: post.food_place || 'Local Specialty Joint',
        location: post.food_location || post.location || 'Central Area',
        price: post.food_price || 'Moderate',
        feedback: post.food_feedback || 'Highly rated by verified traveler',
        influencer: post.username
      });
    }

    if (post.must_visit_name) {
      spots.push({
        name: post.must_visit_name,
        transport: post.must_visit_transport || 'Accessible via local cab/auto',
        influencer: post.username,
        description: post.description || ''
      });
    } else if (post.location && !post.location.startsWith('📍 Coordinates:')) {
      spots.push({
        name: post.location.replace(/^📍\s*/, ''),
        transport: post.transport_type || 'Local transport',
        influencer: post.username,
        description: post.description || ''
      });
    }
  });

  return {
    matchedCount: matchedPosts.length,
    influencers: Array.from(influencers),
    stays,
    transports,
    routes,
    foods,
    spots
  };
}

// Call Groq API with System Prompt and strict JSON schema
async function callGroqAPI(apiKey, promptPayload) {
  const systemPrompt = `# ROLE
You are an AI Travel Planner for "Bro Said He Knows A Spot" (a platform for verified travel recommendations).
Your job is to turn a verified influencer's post about a destination into a complete, actionable travel plan, enriched with real data — and to do the same for any destination even when no influencer post exists on the platform.

# GUIDELINES:
- If influencer signals are provided: prioritize those exact spots, hotels, foods, and transport, but fill all missing elements (transports, multiple stay tiers, sequencing, daily routes) with accurate travel intelligence.
- If NO influencer post exists on the platform: state so clearly, and provide accurate, realistic travel recommendations (real hotels, real heritage/scenic spots, real iconic eateries, accurate transit options, and sensible budget breakdowns).
- Never fabricate fake hotels or prices; use established real accommodations and realistic costs.
- For every stay, activity, spot and food item include a "nearest_location" string written in words (e.g. "Near Hawa Mahal, 5 minutes from City Palace"). Never return map links or bare coordinates.
- Use ONLY these source values: "verified_professional_post" (from a verified pro creator post), "community_post" (from a normal community member post), "government_and_public_sources" (all other research).
- Always return clean, parseable JSON matching the schema below.

# JSON SCHEMA REQUIRED:
{
  "destination": "Name of destination",
  "has_platform_post": true or false,
  "influencer_names": ["username1"],
  "snapshot": "2-3 sentences on vibe, ideal season, and recommended trip length.",
  "getting_there": "Detailed flight/train/road options with nearest airport/station, travel times, and estimated costs.",
  "stay_options": [
    {
      "tier": "budget",
      "name": "Specific real hotel/hostel name",
      "area": "Neighborhood name",
      "price_per_night": "e.g. ₹800 - ₹1,500 / $15 - $25",
      "note": "Description and why stay here",
      "source": "influencer_post" or "web_search",
      "verified": true or false
    },
    {
      "tier": "mid",
      "name": "Specific real hotel name",
      "area": "Neighborhood name",
      "price_per_night": "e.g. ₹3,000 - ₹5,500 / $45 - $75",
      "note": "Description",
      "source": "influencer_post" or "web_search",
      "verified": true or false
    },
    {
      "tier": "luxury",
      "name": "Specific real luxury stay name",
      "area": "Neighborhood name",
      "price_per_night": "e.g. ₹9,000+ / $150+",
      "note": "Description",
      "source": "influencer_post" or "web_search",
      "verified": true or false
    }
  ],
  "itinerary": [
    {
      "day": 1,
      "title": "Theme of Day (e.g. Heritage & Old City Trails)",
      "activities": [
        {
          "time": "Morning (09:00 AM)",
          "title": "Spot or Activity Name",
          "source": "influencer_post" or "web_search",
          "transport": "e.g. Metro / Auto Rickshaw (₹150)",
          "cost": "e.g. ₹200 entry",
          "note": "Tips and details"
        },
        {
          "time": "Afternoon (01:30 PM)",
          "title": "Lunch & Exploration",
          "source": "influencer_post" or "web_search",
          "transport": "Walkable / 10 min cab",
          "cost": "e.g. ₹600",
          "note": "Recommended dish or activity"
        },
        {
          "time": "Evening (05:30 PM)",
          "title": "Sunset View & Local Bazaar",
          "source": "influencer_post" or "web_search",
          "transport": "Local transport",
          "cost": "Free entry",
          "note": "Key highlights"
        }
      ]
    }
  ],
  "spots": [
    {
      "name": "Spot Name",
      "source": "influencer_post" or "web_search",
      "note": "Highlight description and best time to visit"
    }
  ],
  "food": [
    {
      "name": "Dish or Famous Restaurant Name",
      "source": "influencer_post" or "web_search",
      "note": "Must-try specialties, price range, and location"
    }
  ],
  "local_transport": "Comprehensive guide on how to get around (ride apps, autos, bike rentals, metro, pricing).",
  "budget_estimate": {
    "budget": "e.g. ₹2,000 - ₹3,000 / $30 - $45 per day",
    "mid": "e.g. ₹5,000 - ₹8,000 / $70 - $110 per day",
    "luxury": "e.g. ₹15,000+ / $200+ per day",
    "total_estimated": "Calculated total for the requested duration"
  },
  "tips": [
    "Practical tip 1: safety, booking ahead, local etiquette",
    "Practical tip 2: dress codes or permits needed",
    "Practical tip 3: peak crowd hours to avoid"
  ],
  "has_verified_pro_post": true or false,
  "pro_influencer_names": ["username1"],
  "location_format_notice": "Brief note that all locations are described in words, not map links",
  "sources_summary": "One sentence describing where these recommendations came from",
  "sources_used": ["verified_professional_post" or "community_post" or "government_and_public_sources"]
}`;

  const userMessage = JSON.stringify(promptPayload, null, 2);

  // Groq retires and adds models regularly. Discover what the current key can
  // actually use instead of relying on hard-coded IDs that may be gone.
  const preferredModels = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'allam-2-7b'];
  let modelsToTry = preferredModels;
  try {
    const modelsResponse = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    });
    if (modelsResponse.ok) {
      const payload = await modelsResponse.json();
      const available = (payload.data || []).map(m => m.id).filter(id =>
        !/whisper|tts|playai|guard|transcri/i.test(id));
      const preferred = preferredModels.filter(id => available.includes(id));
      modelsToTry = [...preferred, ...available.filter(id => !preferred.includes(id))].slice(0, 5);
      if (modelsToTry.length === 0) modelsToTry = preferredModels;
    }
  } catch (err) {
    console.warn('Could not discover Groq models, using known model list:', err.message);
  }

  const errors = [];
  for (const model of modelsToTry) {
    // Some models reject response_format; retry the same model without it.
    for (const withJsonMode of [true, false]) {
      try {
        const body = {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Create the travel plan for this input:\n${userMessage}` }
          ],
          temperature: 0.3,
          max_tokens: 3800
        };
        if (withJsonMode) body.response_format = { type: 'json_object' };

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Groq API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const contentStr = data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : '';
        if (!contentStr) throw new Error('Groq returned an empty response');
        return JSON.parse(contentStr);
      } catch (err) {
        errors.push(`${model}${withJsonMode ? '' : ' (json mode off)'}: ${err.message}`);
        if (/response_format|json_object|json_schema/i.test(err.message) && withJsonMode) continue;
        break;
      }
    }
  }

  throw new Error(`All Groq models failed. ${errors.join(' | ')}`);
}

// Master Generator: Combines DB scanning + Groq AI / Intelligent Fallback
async function generateTravelPlan(params, db) {
  const {
    destination = '',
    days = 3,
    budget = '',
    budgetTier = 'mid',
    travelStyle = 'balanced',
    groupSize = 'solo',
    interests = '',
    groqApiKey = ''
  } = params;

  if (!destination || !destination.trim()) {
    throw new Error('Destination name is required.');
  }

  // 1. Search DB for matching posts
  const matchedPosts = searchPlatformPosts(destination, db);
  const influencerSignals = extractInfluencerSignals(matchedPosts);
  const hasPlatformPost = !!(influencerSignals && influencerSignals.matchedCount > 0);

  // 2. Determine Groq API Key
  const activeGroqKey = (groqApiKey || process.env.GROQ_API_KEY || '').trim();
  if (!activeGroqKey) {
    throw new Error('AI planner key is not configured. Add a Groq API key to generate a live itinerary — the planner does not return pre-written plans.');
  }

  // 3. Generate the plan with Groq. Failures are surfaced instead of being replaced
  //    by a generic itinerary that would look like real travel research.
  const promptPayload = {
    destination_name: destination,
    influencer_post: hasPlatformPost ? {
      status: "VERIFIED_PLATFORM_POSTS_FOUND",
      matched_posts_count: influencerSignals.matchedCount,
      influencers: influencerSignals.influencers,
      concrete_signals: {
        stays: influencerSignals.stays,
        transports: influencerSignals.transports,
        routes: influencerSignals.routes,
        foods: influencerSignals.foods,
        spots: influencerSignals.spots
      },
      instruction: "Prioritize these exact spots, stays, and food joints in the itinerary, labeling their source as 'influencer_post'. Fill all missing tiers and logistics with reliable travel knowledge."
    } : {
      status: "NO_POST_ON_PLATFORM",
      instruction: "No post exists on the platform for this destination. Act as the verified AI travel planner by utilizing complete, accurate web travel knowledge. Label sources as 'web_search'."
    },
    user_preferences: {
      trip_duration_days: parseInt(days) || 3,
      budget_tier: budgetTier,
      budget_amount: budget,
      group_size: groupSize,
      travel_style: travelStyle,
      interests: interests || "food, sightseeing, culture, relaxation"
    }
  };

  let groqResult;
  try {
    groqResult = await callGroqAPI(activeGroqKey, promptPayload);
  } catch (err) {
    throw new Error(`AI planner request failed: ${err.message}`);
  }

  if (!groqResult || !groqResult.destination) {
    throw new Error('AI planner returned an unusable response. Please try again.');
  }

  // Normalize the AI output to the shape the planner UI renders.
  const proPosts = matchedPosts.filter(p => p.is_verified_pro);
  const proNames = Array.from(new Set(proPosts.map(p => p.username).filter(Boolean)));
  const communityNames = Array.from(new Set(matchedPosts.map(p => p.username).filter(Boolean)));

  groqResult.has_platform_post = hasPlatformPost;
  groqResult.influencer_names = communityNames;
  groqResult.has_verified_pro_post = proPosts.length > 0;
  groqResult.pro_influencer_names = proNames;
  groqResult.location_format_notice = groqResult.location_format_notice ||
    'All nearest locations and transit routes are described in words (text), not map links or raw coordinates.';
  groqResult.sources_summary = groqResult.sources_summary ||
    (proPosts.length
      ? `Verified pro creator posts from @${proNames.join(', @')}, community posts, and reliable public travel sources.`
      : hasPlatformPost
        ? 'Community traveler posts on the platform and reliable public travel sources.'
        : 'Official tourism websites and other reliable public travel sources.');

  const normalizeSource = (source) => {
    if (source === 'influencer_post' || source === 'platform_post') {
      return proPosts.length ? 'verified_professional_post' : 'community_post';
    }
    // The model may claim a pro source even when no pro post matched.
    if (source === 'verified_professional_post' && !proPosts.length) return 'community_post';
    if (source === 'community_post' && proPosts.length) return 'verified_professional_post';
    if (source === 'web_search') return 'government_and_public_sources';
    return source;
  };
  const addNearestLocation = (item, fallback) => {
    if (!item || typeof item !== 'object') return item;
    if (!item.nearest_location) {
      item.nearest_location = item.area || fallback || 'Located in the central landmark area (word form)';
    }
    item.source = normalizeSource(item.source);
    return item;
  };

  ['stay_options', 'itinerary', 'spots', 'food'].forEach(key => {
    if (!Array.isArray(groqResult[key])) return;
    groqResult[key].forEach(item => {
      if (key === 'itinerary') {
        if (Array.isArray(item.activities)) {
          item.activities.forEach(act => addNearestLocation(act, `Within ${groqResult.destination} city centre`));
        }
      } else {
        addNearestLocation(item, `Within ${groqResult.destination} city centre`);
      }
    });
  });

  if (Array.isArray(groqResult.sources_used)) {
    groqResult.sources_used = Array.from(new Set(groqResult.sources_used.map(normalizeSource)));
  } else {
    groqResult.sources_used = proPosts.length
      ? ['verified_professional_post', 'government_and_public_sources']
      : hasPlatformPost
        ? ['community_post', 'government_and_public_sources']
        : ['government_and_public_sources'];
  }
  return groqResult;
}

module.exports = {
  generateTravelPlan,
  saveGroqKey,
  getGroqKeyStatus,
  searchPlatformPosts
};
