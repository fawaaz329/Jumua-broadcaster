/**
 * Cloudflare Pages Function: WebRTC SFU Backend
 * Location: functions/api/[[route]].js
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

export async function onRequest(context) {
  const request = context.request;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);

  try {
    // 1. Status Check: /api/status
    if (url.pathname.endsWith("/status")) {
      return new Response(JSON.stringify({ isLive: activeBroadcast.isLive }), { headers: corsHeaders });
    }

    // 2. Broadcaster Publish: /api/publish
    if (url.pathname.endsWith("/publish") && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const sdp = body.sdp;
      const pass = body.pass;
      const mid = body.mid || "0";

      if (pass !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid Admin Password" }), { 
          status: 401, 
          headers: corsHeaders 
        });
      }

      // Create Cloudflare Calls Session
      const sessionRes = await fetch(`${CALLS_API}/sessions/new`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CALLS_APP_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionDescription: { type: "offer", sdp }
        })
      });

      const sessionData = await sessionRes.json();
      if (!sessionRes.ok || !sessionData.sessionId) {
        throw new Error("Calls Session Error: " + (sessionData.errorDescription || JSON.stringify(sessionData)));
      }

      const sessionId = sessionData.sessionId;
      const answerSdp = sessionData.sessionDescription?.sdp;

      // Register audio track
      const trackRes = await fetch(`${CALLS_API}/sessions/${sessionId}/tracks/new`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CALLS_APP_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [{ location: "local", mid, trackName: activeBroadcast.trackName }]
        })
      });

      const trackData = await trackRes.json();
      if (!trackRes.ok) {
        throw new Error("Calls Track Register Error: " + (trackData.errorDescription || JSON.stringify(trackData)));
      }

      activeBroadcast.sessionId = sessionId;
      activeBroadcast.isLive = true;

      return new Response(JSON.stringify({
        sessionId,
        sdp: answerSdp
      }), { headers: corsHeaders });
    }

    // 3. Listener Subscribe: /api/subscribe
    if (url.pathname.endsWith("/subscribe") && request.method === "POST") {
      if (!activeBroadcast.isLive || !activeBroadcast.sessionId) {
        return new Response(JSON.stringify({ error: "Broadcast Offline" }), { status: 404, headers: corsHeaders });
      }

      const body = await request.json().catch(() => ({}));
      const sdp = body.sdp;

      const sessionRes = await fetch(`${CALLS_API}/sessions/new`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CALLS_APP_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionDescription: { type: "offer", sdp }
        })
      });

      const sessionData = await sessionRes.json();
      if (!sessionRes.ok || !sessionData.sessionId) {
        throw new Error("Listener Session Error: " + (sessionData.errorDescription || JSON.stringify(sessionData)));
      }

      const sessionId = sessionData.sessionId;
      const answerSdp = sessionData.sessionDescription?.sdp;

      const trackRes = await fetch(`${CALLS_API}/sessions/${sessionId}/tracks/new`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CALLS_APP_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tracks: [{ location: "remote", sessionId: activeBroadcast.sessionId, trackName: activeBroadcast.trackName }]
        })
      });

      const trackData = await trackRes.json();
      if (!trackRes.ok) {
        throw new Error("Listener Track Pull Error: " + (trackData.errorDescription || JSON.stringify(trackData)));
      }

      return new Response(JSON.stringify({
        sessionId,
        sdp: answerSdp
      }), { headers: corsHeaders });
    }

    // 4. Broadcaster Stop: /api/stop
    if (url.pathname.endsWith("/stop") && request.method === "POST") {
      activeBroadcast.isLive = false;
      activeBroadcast.sessionId = null;
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "API Route Not Found" }), { status: 404, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Server Error" }), {
      status: 500,
      headers: corsHeaders
    });
  }
        }
