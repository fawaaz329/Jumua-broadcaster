/**
 * Cloudflare Calls WebRTC SFU Backend (worker.js)
 * Powered by Cloudflare KV Global Memory (1,000 GB Free Data)
 */

const CALLS_APP_ID = "906d403c90d6a6c46f4ca27e4df82811";
const CALLS_APP_SECRET = "dd2d91658878278404645abb2cfa3544c41c72f2b1a7d380287a9d1beefdb0a6";
const ADMIN_PASSWORD = "admin";
const CALLS_API = `https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}`;
const KV_KEY = "active_broadcast_state";

// In-memory fallback if KV binding is pending
let memoryFallback = {
  sessionId: null,
  trackName: "masjid-audio",
  isLive: false
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

// Helper to get broadcast state from Global KV (or memory)
async function getBroadcastState(env) {
  if (env && env.JUMUA_KV) {
    const raw = await env.JUMUA_KV.get(KV_KEY);
    return raw ? JSON.parse(raw) : null;
  }
  return memoryFallback.isLive ? memoryFallback : null;
}

// Helper to save broadcast state to Global KV (or memory)
async function setBroadcastState(env, state) {
  if (env && env.JUMUA_KV) {
    if (state) {
      await env.JUMUA_KV.put(KV_KEY, JSON.stringify(state), { expirationTtl: 43200 }); // 12hr auto-cleanup
    } else {
      await env.JUMUA_KV.delete(KV_KEY);
    }
  }
  if (state) {
    memoryFallback = state;
  } else {
    memoryFallback = { sessionId: null, trackName: "masjid-audio", isLive: false };
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        // 1. Status Check: /api/status
        if (url.pathname === "/api/status") {
          const state = await getBroadcastState(env);
          return json({
            success: true,
            isLive: !!(state && state.isLive),
            sessionId: state ? state.sessionId : null
          });
        }

        // 2. Broadcaster Step 1: Session Init
        if (url.pathname === "/api/publish" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sdp, pass } = body;

          if (pass !== ADMIN_PASSWORD) {
            return json({ success: false, error: "Unauthorized: Invalid Admin Password" }, 401);
          }

          if (!sdp) {
            return json({ success: false, error: "Missing SDP offer" }, 400);
          }

          // Check if another Admin is already broadcasting
          const currentState = await getBroadcastState(env);
          if (currentState && currentState.isLive) {
            return json({ 
              success: false, 
              error: "Collision Detected: Another Admin is currently broadcasting on this stream." 
            }, 409);
          }

          // Create session in Cloudflare Calls
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

        // 3. Broadcaster Step 2: Register Local Track & Save to Global KV
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
              tracks: [{ location: "local", mid: mid || "0", trackName: "masjid-audio" }]
            })
          });

          const trackData = await trackRes.json().catch(() => ({}));
          if (!trackRes.ok) {
            return json({ 
              success: false, 
              error: "Track Register Failed: " + (trackData.errorDescription || JSON.stringify(trackData)) 
            }, 502);
          }

          // Save active broadcast state to Cloudflare Global KV database
          await setBroadcastState(env, {
            sessionId: sessionId,
            trackName: "masjid-audio",
            isLive: true,
            startedAt: Date.now()
          });

          return json({ success: true });
        }

        // 4. Listener Step 1: Subscribe & Create Session
        if (url.pathname === "/api/subscribe" && request.method === "POST") {
          const state = await getBroadcastState(env);
          if (!state || !state.isLive || !state.sessionId) {
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

        // 5. Listener Step 2: Pull Audio Track from Global Broadcaster Session
        if (url.pathname === "/api/pull-track" && request.method === "POST") {
          const state = await getBroadcastState(env);
          if (!state || !state.sessionId) {
            return json({ success: false, error: "Broadcast is offline" }, 404);
          }

          const body = await request.json().catch(() => ({}));
          const { sessionId } = body;

          const trackRes = await fetch(`${CALLS_API}/sessions/${sessionId}/tracks/new`, {
            method: "POST",
            headers: { 
              "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
              "Content-Type": "application/json" 
            },
            body: JSON.stringify({
              tracks: [{ location: "remote", sessionId: state.sessionId, trackName: state.trackName || "masjid-audio" }]
            })
          });

          const trackData = await trackRes.json().catch(() => ({}));
          if (!trackRes.ok || !trackData.sessionDescription) {
            return json({ 
              success: false, 
              error: "Listener Track Pull Failed: " + (trackData.errorDescription || JSON.stringify(trackData)) 
            }, 502);
          }

          return json({
            success: true,
            renegotiationOffer: trackData.sessionDescription.sdp
          });
        }

        // 6. Listener Step 3: Complete Renegotiation
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

        // 7. Broadcaster Stop: Clear Global KV State
        if (url.pathname === "/api/stop" && request.method === "POST") {
          await setBroadcastState(env, null);
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
