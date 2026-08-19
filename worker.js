/**
 * Cloudflare Calls WebRTC SFU Backend (worker.js)
 * Includes Admin Force-Reset & Session Recovery
 */

const CALLS_APP_ID = "906d403c90d6a6c46f4ca27e4df82811";
const CALLS_APP_SECRET = "dd2d91658878278404645abb2cfa3544c41c72f2b1a7d380287a9d1beefdb0a6";
const ADMIN_PASSWORD = "admin";
const CALLS_API = `https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}`;

// Shared broadcast state in Cloudflare memory
let activeBroadcast = {
  sessionId: null,
  trackName: "masjid-audio",
  isLive: false,
  broadcasterToken: null,
  listeners: new Set()
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
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
        // 1. Status Check & Listener Count
        if (url.pathname === "/api/status") {
          return json({ 
            success: true, 
            isLive: activeBroadcast.isLive,
            broadcasterToken: activeBroadcast.broadcasterToken,
            listenerCount: activeBroadcast.listeners.size 
          });
        }

        // 2. Force Reset / Takeover Endpoint
        if (url.pathname === "/api/force-reset" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (body.pass !== ADMIN_PASSWORD) {
            return json({ success: false, error: "Unauthorized: Invalid Password" }, 401);
          }

          // Reset broadcast state
          activeBroadcast.isLive = false;
          activeBroadcast.sessionId = null;
          activeBroadcast.broadcasterToken = null;
          activeBroadcast.listeners.clear();

          return json({ success: true, message: "Broadcast state reset successfully." });
        }

        // 3. Broadcaster Publish (Step 1: Session Init)
        if (url.pathname === "/api/publish" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sdp, pass, adminDeviceToken } = body;

          if (pass !== ADMIN_PASSWORD) {
            return json({ success: false, error: "Unauthorized: Invalid Admin Password" }, 401);
          }

          if (!sdp) {
            return json({ success: false, error: "Missing SDP offer" }, 400);
          }

          // If a broadcast is live, only allow if it's the SAME device reclaiming or if forced
          if (activeBroadcast.isLive && activeBroadcast.broadcasterToken && activeBroadcast.broadcasterToken !== adminDeviceToken) {
            return json({
              success: false,
              error: "Stream Occupied: Another Admin is currently broadcasting.",
              isOccupied: true
            }, 409);
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

          activeBroadcast.broadcasterToken = adminDeviceToken;

          return json({
            success: true,
            sessionId: sessionData.sessionId,
            sdp: sessionData.sessionDescription?.sdp
          });
        }

        // 4. Broadcaster Register Track (Step 2: Connect Mic)
        if (url.pathname === "/api/register-track" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sessionId, mid, adminDeviceToken } = body;

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
          activeBroadcast.broadcasterToken = adminDeviceToken;
          activeBroadcast.listeners.clear();

          return json({ success: true });
        }

        // 5. Listener Subscribe (Step 1: Session Init)
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

        // 6. Listener Pull Track (Step 2: Get Audio Track)
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
          if (!trackRes.ok || !trackData.sessionDescription) {
            return json({ 
              success: false, 
              error: "Listener Track Pull Failed: " + (trackData.errorDescription || JSON.stringify(trackData)) 
            }, 502);
          }

          activeBroadcast.listeners.add(sessionId);

          return json({
            success: true,
            renegotiationOffer: trackData.sessionDescription.sdp
          });
        }

        // 7. Listener Renegotiate Answer (Step 3: Complete Audio Link)
        if (url.pathname === "/api/renegotiate-answer" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sessionId, sdp } = body;

          await fetch(`${CALLS_API}/sessions/${sessionId}/renegotiate`, {
            method: "PUT",
            headers: { 
              "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
              "Content-Type": "application/json" 
            },
            body: JSON.stringify({
              sessionDescription: { type: "answer", sdp }
            })
          });

          return json({ success: true });
        }

        // 8. Listener Leave
        if (url.pathname === "/api/leave" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (body.sessionId) activeBroadcast.listeners.delete(body.sessionId);
          return json({ success: true });
        }

        // 9. Broadcaster Stop
        if (url.pathname === "/api/stop" && request.method === "POST") {
          activeBroadcast.isLive = false;
          activeBroadcast.sessionId = null;
          activeBroadcast.broadcasterToken = null;
          activeBroadcast.listeners.clear();
          return json({ success: true });
        }

        return json({ success: false, error: "API route not found" }, 404);

      } catch (err) {
        return json({ success: false, error: err.message || "Server Error" }, 500);
      }
    }

    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};
