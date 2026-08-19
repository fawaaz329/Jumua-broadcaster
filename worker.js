/**
 * Cloudflare Calls WebRTC SFU Backend (worker.js)
 * 2-Step Handshake Protocol
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        // Status endpoint
        if (url.pathname === "/api/status") {
          return json({ success: true, isLive: activeBroadcast.isLive });
        }

        // Broadcaster Step 1: Initialize Session
        if (url.pathname === "/api/publish" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sdp, pass } = body;

          if (pass !== ADMIN_PASSWORD) {
            return json({ success: false, error: "Unauthorized: Invalid Admin Password" }, 401);
          }

          if (!sdp) {
            return json({ success: false, error: "Missing SDP offer" }, 400);
          }

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
              error: "Calls Session Failed: " + (sessionData.errorDescription || JSON.stringify(sessionData)) 
            }, 502);
          }

          return json({
            success: true,
            sessionId: sessionData.sessionId,
            sdp: sessionData.sessionDescription?.sdp
          });
        }

        // Broadcaster Step 2: Register Track (Called once PeerConnection is connected)
        if (url.pathname === "/api/register-track" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sessionId, mid } = body;

          if (!sessionId) {
            return json({ success: false, error: "Missing sessionId" }, 400);
          }

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
              error: "Track Register Failed: " + (trackData.errorDescription || JSON.stringify(trackData)) 
            }, 502);
          }

          activeBroadcast.sessionId = sessionId;
          activeBroadcast.isLive = true;

          return json({ success: true });
        }

        // Listener Subscribe Step 1: Create Session
        if (url.pathname === "/api/subscribe" && request.method === "POST") {
          if (!activeBroadcast.isLive || !activeBroadcast.sessionId) {
            return json({ success: false, error: "Broadcast is currently offline" }, 404);
          }

          const body = await request.json().catch(() => ({}));
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
            return json({ success: false, error: "Listener Session Creation Failed" }, 502);
          }

          return json({
            success: true,
            sessionId: sessionData.sessionId,
            sdp: sessionData.sessionDescription?.sdp
          });
        }

        // Listener Subscribe Step 2: Pull Audio Track
        if (url.pathname === "/api/pull-track" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sessionId } = body;

          if (!activeBroadcast.sessionId) {
            return json({ success: false, error: "Broadcast is offline" }, 404);
          }

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
            return json({ success: false, error: "Listener Track Pull Failed" }, 502);
          }

          return json({ success: true });
        }

        // Stop Broadcast
        if (url.pathname === "/api/stop" && request.method === "POST") {
          activeBroadcast.isLive = false;
          activeBroadcast.sessionId = null;
          return json({ success: true });
        }

        return json({ success: false, error: "API route not found" }, 404);

      } catch (err) {
        return json({ success: false, error: err.message || "Internal Server Error" }, 500);
      }
    }

    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};
