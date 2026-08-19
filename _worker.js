/**
 * Cloudflare Calls WebRTC SFU Backend (_worker.js)
 * Fully CORS-enabled, HTTPS-locked, with Upstream Error Handling
 */

const CALLS_APP_ID = "906d403c90d6a6c46f4ca27e4df82811";
const CALLS_APP_SECRET = "dd2d91658878278404645abb2cfa3544c41c72f2b1a7d380287a9d1beefdb0a6";
const ADMIN_PASSWORD = "admin";
const CALLS_API = `https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}`;

let activeBroadcast = {
  sessionId: null,
  trackName: "masjid-audio",
  isLive: false
};

// Universal CORS headers applied to EVERY response
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
    // 1. Handle CORS Preflight immediately
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      // 2. Status Check: /api/status
      if (url.pathname === "/api/status" || url.pathname.endsWith("/status")) {
        return json({ success: true, isLive: activeBroadcast.isLive });
      }

      // 3. Broadcaster Publish: /api/publish
      if ((url.pathname === "/api/publish" || url.pathname.endsWith("/publish")) && request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ success: false, error: "Invalid JSON body" }, 400);
        }

        const { sdp, pass, mid } = body;

        if (pass !== ADMIN_PASSWORD) {
          return json({ success: false, error: "Unauthorized: Invalid Admin Password" }, 401);
        }

        if (!sdp) {
          return json({ success: false, error: "Missing SDP offer" }, 400);
        }

        // Create new session in Cloudflare Calls
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
            error: "Cloudflare Calls Session Error: " + (sessionData.errorDescription || sessionData.message || JSON.stringify(sessionData)) 
          }, 502);
        }

        const sessionId = sessionData.sessionId;
        const answerSdp = sessionData.sessionDescription?.sdp;

        // Register audio track
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
            error: "Cloudflare Calls Track Error: " + (trackData.errorDescription || JSON.stringify(trackData)) 
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

      // 4. Listener Subscribe: /api/subscribe
      if ((url.pathname === "/api/subscribe" || url.pathname.endsWith("/subscribe")) && request.method === "POST") {
        if (!activeBroadcast.isLive || !activeBroadcast.sessionId) {
          return json({ success: false, error: "Broadcast Offline" }, 404);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ success: false, error: "Invalid JSON body" }, 400);
        }

        const { sdp } = body;

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
          return json({ success: false, error: "Listener Session Error" }, 502);
        }

        const sessionId = sessionData.sessionId;
        const answerSdp = sessionData.sessionDescription?.sdp;

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
          return json({ success: false, error: "Listener Track Pull Error" }, 502);
        }

        return json({
          success: true,
          sessionId,
          sdp: answerSdp
        });
      }

      // 5. Broadcaster Stop: /api/stop
      if ((url.pathname === "/api/stop" || url.pathname.endsWith("/stop")) && request.method === "POST") {
        activeBroadcast.isLive = false;
        activeBroadcast.sessionId = null;
        return json({ success: true });
      }

      // Static assets fallback
      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({ success: false, error: "Route Not Found" }, 404);

    } catch (err) {
      return json({ success: false, error: err.message || "Internal Server Error" }, 500);
    }
  }
};
