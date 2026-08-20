/**
 * Cloudflare Calls WebRTC SFU Backend (_worker.js)
 * Secure Password Check via Cloudflare Environment Secrets
 */

const CALLS_APP_ID = "906d403c90d6a6c46f4ca27e4df82811";
const CALLS_APP_SECRET = "dd2d91658878278404645abb2cfa3544c41c72f2b1a7d380287a9d1beefdb0a6";
const CALLS_API = `https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}`;
const KV_KEY = "active_masjid_stream";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

function json(data, status = 200, customHeaders = {}) {
  return new Response(JSON.stringify(data), { 
    status, 
    headers: { ...corsHeaders, ...customHeaders } 
  });
}

// Global State Reader
async function getBroadcast(env) {
  if (env && env.JUMUA_KV) {
    try {
      const raw = await env.JUMUA_KV.get(KV_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
  }
  return null;
}

// Global State Writer
async function setBroadcast(env, data) {
  if (env && env.JUMUA_KV) {
    try {
      if (data) {
        await env.JUMUA_KV.put(KV_KEY, JSON.stringify(data), { expirationTtl: 43200 }); // 12hr TTL
      } else {
        await env.JUMUA_KV.delete(KV_KEY);
      }
    } catch (e) {}
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // SECURE: Reads password from Cloudflare dashboard secret (defaults to 'admin' if not set)
    const activeAdminPassword = env.ADMIN_PASSWORD || "admin";

    if (url.pathname.startsWith("/api/")) {
      try {
        // 1. Status Check (Edge Micro-Cached)
        if (url.pathname === "/api/status") {
          const current = await getBroadcast(env);
          return json({ 
            success: true, 
            isLive: !!(current && current.isLive),
            sessionId: current ? current.sessionId : null,
            listenerCount: current ? (current.listenerCount || 0) : 0,
            broadcasterToken: current ? current.broadcasterToken : null
          }, 200, {
            "Cache-Control": "public, max-age=2, s-maxage=2, stale-while-revalidate=4"
          });
        }

        // 2. Force Reset / Unlock Stream
        if (url.pathname === "/api/force-reset" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (body.pass !== activeAdminPassword) {
            return json({ success: false, error: "Unauthorized" }, 401);
          }
          await setBroadcast(env, null);
          return json({ success: true, message: "Stream reset successfully." });
        }

        // 3. Broadcaster Start
        if (url.pathname === "/api/publish" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sdp, pass, adminDeviceToken } = body;

          // Secure verification against Cloudflare Secret
          if (pass !== activeAdminPassword) {
            return json({ success: false, error: "Unauthorized: Invalid Admin Password" }, 401);
          }

          if (!sdp) {
            return json({ success: false, error: "Missing SDP offer" }, 400);
          }

          const current = await getBroadcast(env);
          if (current && current.isLive && current.broadcasterToken && current.broadcasterToken !== adminDeviceToken) {
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
            body: JSON.stringify({ sessionDescription: { type: "offer", sdp } })
          });

          const sessionData = await sessionRes.json().catch(() => ({}));
          if (!sessionRes.ok || !sessionData.sessionId) {
            return json({ success: false, error: "Calls Session Failed" }, 502);
          }

          return json({
            success: true,
            sessionId: sessionData.sessionId,
            sdp: sessionData.sessionDescription?.sdp
          });
        }

        // 4. Broadcaster Register Track
        if (url.pathname === "/api/register-track" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sessionId, mid, adminDeviceToken } = body;

          if (!sessionId) return json({ success: false, error: "Missing sessionId" }, 400);

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
            return json({ success: false, error: "Track Register Failed" }, 502);
          }

          await setBroadcast(env, {
            sessionId: sessionId,
            trackName: "masjid-audio",
            isLive: true,
            broadcasterToken: adminDeviceToken,
            listenerCount: 0,
            startedAt: Date.now()
          });

          return json({ success: true });
        }

        // 5. Listener Subscribe Step 1
        if (url.pathname === "/api/subscribe" && request.method === "POST") {
          const current = await getBroadcast(env);
          if (!current || !current.isLive || !current.sessionId) {
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
            body: JSON.stringify({ sessionDescription: { type: "offer", sdp } })
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

        // 6. Listener Subscribe Step 2: Pull Audio Track
        if (url.pathname === "/api/pull-track" && request.method === "POST") {
          const current = await getBroadcast(env);
          if (!current || !current.sessionId) {
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
              tracks: [{ location: "remote", sessionId: current.sessionId, trackName: "masjid-audio" }]
            })
          });

          const trackData = await trackRes.json().catch(() => ({}));
          if (!trackRes.ok || !trackData.sessionDescription) {
            return json({ success: false, error: "Listener Track Pull Failed" }, 502);
          }

          current.listenerCount = (current.listenerCount || 0) + 1;
          await setBroadcast(env, current);

          return json({
            success: true,
            renegotiationOffer: trackData.sessionDescription.sdp
          });
        }

        // 7. Listener Complete Audio Connection
        if (url.pathname === "/api/renegotiate-answer" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { sessionId, sdp } = body;

          await fetch(`${CALLS_API}/sessions/${sessionId}/renegotiate`, {
            method: "PUT",
            headers: { 
              "Authorization": `Bearer ${CALLS_APP_SECRET}`, 
              "Content-Type": "application/json" 
            },
            body: JSON.stringify({ sessionDescription: { type: "answer", sdp } })
          });

          return json({ success: true });
        }

        // 8. Listener Leave
        if (url.pathname === "/api/leave" && request.method === "POST") {
          const current = await getBroadcast(env);
          if (current && current.listenerCount > 0) {
            current.listenerCount -= 1;
            await setBroadcast(env, current);
          }
          return json({ success: true });
        }

        // 9. Stop Broadcast
        if (url.pathname === "/api/stop" && request.method === "POST") {
          await setBroadcast(env, null);
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
