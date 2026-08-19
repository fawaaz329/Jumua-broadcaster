/**
 * Cloudflare Calls WebRTC SFU Backend (worker.js)
 * 1,000 GB Free Egress / Zero Minute Limits
 */

const CALLS_APP_ID = "906d403c90d6a6c46f4ca27e4df82811";
const CALLS_APP_SECRET = "dd2d91658878278404645abb2cfa3544c41c72f2b1a7d380287a9d1beefdb0a6";
const ADMIN_PASSWORD = "admin";
const CALLS_API = `https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}`;

// In-memory broadcast state
let activeBroadcast = {
  sessionId: null,
  trackName: "masjid-audio",
  isLive: false
};

// Global CORS headers applied to every response
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Content-Type": "application/json"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

export default {
  async fetch(request, env) {
    // 1. Universal CORS Preflight Handling
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 2. Intercept API routes
    if (url.pathname.startsWith("/api/")) {
      try {
        // Status endpoint: GET /api/status
        if (url.pathname === "/api/status") {
          return json({ success: true, isLive: activeBroadcast.isLive });
        }

        // Broadcaster Publish endpoint: POST /api/publish
        if (url.pathname === "/api/publish" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sdp, pass, mid } = body;

          if (pass !== ADMIN_PASSWORD) {
            return json({ success: false, error: "Unauthorized: Invalid Admin Password" }, 401);
          }

          if (!sdp) {
            return json({ success: false, error: "Missing SDP offer from phone" }, 400);
          }

          // Create new session in Cloudflare Calls with SDP offer
          const sessionRes = await fetch(`${CALLS_API}/sessions/new`, {
            method: "POST",
            headers: { 
              "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
              "Content-Type": "application/json" 
            },
            body: JSON.stringify({
              sessionDescription: { type: "offer", sdp }
            })
          });

          const sessionData = await sessionRes.json().catch(() => ({}));
          if (!sessionRes.ok || !sessionData.sessionId) {
            return json({ 
              success: false, 
              error: "Calls Session Failed: " + (sessionData.errorDescription || sessionData.message || JSON.stringify(sessionData)) 
            }, 502);
          }

          const sessionId = sessionData.sessionId;
          const answerSdp = sessionData.sessionDescription?.sdp;

          // Register local audio track with Cloudflare Calls
          const trackRes = await fetch(`${CALLS_API}/sessions/${sessionId}/tracks/new`, {
            method: "POST",
            headers: { 
              "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
              "Content-Type": "application/json" 
            },
            body: JSON.stringify({
              tracks: [{ location: "local", mid: mid || "0", trackName: activeBroadcast.trackName }]
            })
          });

          const trackData = await trackRes.json().catch(() => ({}));
          if (!trackRes.ok) {
            return json({ 
              success: false, 
              error: "Calls Track Failed: " + (trackData.errorDescription || JSON.stringify(trackData)) 
            }, 502);
          }

          activeBroadcast.sessionId = sessionId;
          activeBroadcast.isLive = true;

          return json({
            success: true,
            sessionId,
            sdp: answerSdp
          });
        }

        // Listener Subscribe endpoint: POST /api/subscribe
        if (url.pathname === "/api/subscribe" && request.method === "POST") {
          if (!activeBroadcast.isLive || !activeBroadcast.sessionId) {
            return json({ success: false, error: "Broadcast is currently offline" }, 404);
          }

          const body = await request.json().catch(() => ({}));
          const { sdp } = body;

          // Create listener session with SDP offer
          const sessionRes = await fetch(`${CALLS_API}/sessions/new`, {
            method: "POST",
            headers: { 
              "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
              "Content-Type": "application/json" 
            },
            body: JSON.stringify({
              sessionDescription: { type: "offer", sdp }
            })
          });

          const sessionData = await sessionRes.json().catch(() => ({}));
          if (!sessionRes.ok || !sessionData.sessionId) {
            return json({ success: false, error: "Listener Session Creation Failed" }, 502);
          }

          const sessionId = sessionData.sessionId;
          const answerSdp = sessionData.sessionDescription?.sdp;

          // Pull audio track from broadcaster session
          const trackRes = await fetch(`${CALLS_API}/sessions/${sessionId}/tracks/new`, {
            method: "POST",
            headers: { 
              "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
              "Content-Type": "application/json" 
            },
            body: JSON.stringify({
              tracks: [{ location: "remote", sessionId: activeBroadcast.sessionId, trackName: activeBroadcast.trackName }]
            })
          });

          const trackData = await trackRes.json().catch(() => ({}));
          if (!trackRes.ok) {
            return json({ success: false, error: "Listener Track Subscription Failed" }, 502);
          }

          return json({
            success: true,
            sessionId,
            sdp: answerSdp
          });
        }

        // Broadcaster Stop endpoint: POST /api/stop
        if (url.pathname === "/api/stop" && request.method === "POST") {
          activeBroadcast.isLive = false;
          activeBroadcast.sessionId = null;
          return json({ success: true });
        }

        return json({ success: false, error: `API route not found: ${url.pathname}` }, 404);

      } catch (err) {
        return json({ success: false, error: err.message || "Internal Server Error" }, 500);
      }
    }

    // 3. Serve static files (index.html) if request is not an /api/ route
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};
