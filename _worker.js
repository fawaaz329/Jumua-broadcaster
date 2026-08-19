/**
 * Cloudflare Calls WebRTC SFU Backend (_worker.js)
 * Enhanced with Structured Error Handling, Upstream Timeouts & CORS Safety
 */

const CALLS_APP_ID = "906d403c90d6a6c46f4ca27e4df82811";
const CALLS_APP_SECRET = "dd2d91658878278404645abb2cfa3544c41c72f2b1a7d380287a9d1beefdb0a6";
const ADMIN_PASSWORD = "admin";
const UPSTREAM_TIMEOUT_MS = 8000; // 8-second safety timeout for Cloudflare Calls API

let activeBroadcast = {
  sessionId: null,
  trackName: "masjid-audio",
  isLive: false,
  startedAt: null
};

// Global CORS headers applied to all responses (including errors)
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

// Standardized JSON Response Helper
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

export default {
  async fetch(request, env) {
    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      // ----------------------------------------------------
      // ROUTE: GET /api/status
      // ----------------------------------------------------
      if (url.pathname === "/api/status" && request.method === "GET") {
        return jsonResponse({
          success: true,
          isLive: activeBroadcast.isLive,
          startedAt: activeBroadcast.startedAt
        });
      }

      // ----------------------------------------------------
      // ROUTE: POST /api/publish (Broadcaster Start)
      // ----------------------------------------------------
      if (url.pathname === "/api/publish" && request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ success: false, error: "Invalid JSON body provided." }, 400);
        }

        const { sdp, pass } = body;

        // Password verification
        if (!pass || pass !== ADMIN_PASSWORD) {
          return jsonResponse({ 
            success: false, 
            error: "Authentication failed. Incorrect admin password.",
            code: "UNAUTHORIZED" 
          }, 401);
        }

        // Validate SDP Offer
        if (!sdp || typeof sdp !== "string") {
          return jsonResponse({ 
            success: false, 
            error: "Missing or invalid WebRTC SDP offer.",
            code: "INVALID_SDP" 
          }, 400);
        }

        // A. Create new Cloudflare Calls Session with Timeout
        const sessionRes = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/new`, {
          method: "POST",
          headers: { 
            "Authorization": `Bearer ${CALLS_APP_SECRET}`,
            "Content-Type": "application/json"
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });

        const sessionData = await sessionRes.json().catch(() => ({}));
        if (!sessionRes.ok || !sessionData.sessionId) {
          return jsonResponse({
            success: false,
            error: sessionData.errorDescription || sessionData.message || "Failed to initialize Cloudflare Calls session.",
            code: "UPSTREAM_SESSION_FAILED"
          }, 502);
        }

        const sessionId = sessionData.sessionId;

        // B. Register Local Audio Track
        const trackRes = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/${sessionId}/tracks/new`, {
          method: "POST",
          headers: { 
            "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
            "Content-Type": "application/json" 
          },
          body: JSON.stringify({
            sessionDescription: { sdp, type: "offer" },
            tracks: [{ location: "local", mid: "audio", trackName: activeBroadcast.trackName }]
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });

        const trackData = await trackRes.json().catch(() => ({}));
        if (!trackRes.ok || !trackData.sessionDescription?.sdp) {
          return jsonResponse({
            success: false,
            error: trackData.errorDescription || trackData.message || "Failed to publish microphone track to Cloudflare.",
            code: "UPSTREAM_TRACK_FAILED"
          }, 502);
        }

        // Update active broadcast state
        activeBroadcast.sessionId = sessionId;
        activeBroadcast.isLive = true;
        activeBroadcast.startedAt = Date.now();

        return jsonResponse({
          success: true,
          sessionId,
          sdp: trackData.sessionDescription.sdp
        });
      }

      // ----------------------------------------------------
      // ROUTE: POST /api/subscribe (Listener Connect)
      // ----------------------------------------------------
      if (url.pathname === "/api/subscribe" && request.method === "POST") {
        if (!activeBroadcast.isLive || !activeBroadcast.sessionId) {
          return jsonResponse({ 
            success: false, 
            error: "Broadcast is currently offline.",
            code: "BROADCAST_OFFLINE" 
          }, 404);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ success: false, error: "Invalid JSON body provided." }, 400);
        }

        const { sdp } = body;
        if (!sdp || typeof sdp !== "string") {
          return jsonResponse({ success: false, error: "Missing or invalid listener SDP offer." }, 400);
        }

        // A. Create Listener Session
        const sessionRes = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/new`, {
          method: "POST",
          headers: { 
            "Authorization": `Bearer ${CALLS_APP_SECRET}`,
            "Content-Type": "application/json"
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });

        const sessionData = await sessionRes.json().catch(() => ({}));
        if (!sessionRes.ok || !sessionData.sessionId) {
          return jsonResponse({
            success: false,
            error: "Failed to create listener session.",
            code: "UPSTREAM_SESSION_FAILED"
          }, 502);
        }

        const sessionId = sessionData.sessionId;

        // B. Pull Active Audio Track from Broadcaster
        const trackRes = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/${sessionId}/tracks/new`, {
          method: "POST",
          headers: { 
            "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
            "Content-Type": "application/json" 
          },
          body: JSON.stringify({
            sessionDescription: { sdp, type: "offer" },
            tracks: [{ location: "remote", sessionId: activeBroadcast.sessionId, trackName: activeBroadcast.trackName }]
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });

        const trackData = await trackRes.json().catch(() => ({}));
        if (!trackRes.ok || !trackData.sessionDescription?.sdp) {
          return jsonResponse({
            success: false,
            error: trackData.errorDescription || "Failed to subscribe to active audio track.",
            code: "UPSTREAM_SUBSCRIBE_FAILED"
          }, 502);
        }

        return jsonResponse({
          success: true,
          sessionId,
          sdp: trackData.sessionDescription.sdp
        });
      }

      // ----------------------------------------------------
      // ROUTE: POST /api/stop (Broadcaster End)
      // ----------------------------------------------------
      if (url.pathname === "/api/stop" && request.method === "POST") {
        activeBroadcast.isLive = false;
        activeBroadcast.sessionId = null;
        activeBroadcast.startedAt = null;
        return jsonResponse({ success: true, message: "Broadcast stopped successfully." });
      }

      // Static assets fallback (if hosted on Cloudflare Pages/Workers Assets)
      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return jsonResponse({ success: false, error: `Route not found: ${url.pathname}` }, 404);

    } catch (err) {
      const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
      return jsonResponse({
        success: false,
        error: isTimeout 
          ? "Cloudflare Calls upstream service timed out. Please retry."
          : (err.message || "Internal server error"),
        code: isTimeout ? "GATEWAY_TIMEOUT" : "INTERNAL_ERROR"
      }, isTimeout ? 504 : 500);
    }
  }
};
