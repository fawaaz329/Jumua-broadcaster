/**
 * Cloudflare Calls Backend (_worker.js)
 * Automatically deployed by Cloudflare from GitHub
 */

const CALLS_APP_ID = "906d403c90d6a6c46f4ca27e4df82811";
const CALLS_APP_SECRET = "dd2d91658878278404645abb2cfa3544c41c72f2b1a7d380287a9d1beefdb0a6";
const ADMIN_PASSWORD = "admin";

let activeBroadcast = {
  sessionId: null,
  trackName: "masjid-audio",
  isLive: false
};

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Status check
    if (url.pathname === "/api/status") {
      return new Response(JSON.stringify({ isLive: activeBroadcast.isLive }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Broadcaster Publish
    if (url.pathname === "/api/publish" && request.method === "POST") {
      const { sdp, pass } = await request.json();
      if (pass !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { 
          status: 401, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      const sessionRes = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/new`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CALLS_APP_SECRET}` }
      });
      const sessionData = await sessionRes.json();
      const sessionId = sessionData.sessionId;

      const trackRes = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/${sessionId}/tracks/new`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CALLS_APP_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionDescription: { sdp, type: "offer" },
          tracks: [{ location: "local", mid: "audio", trackName: activeBroadcast.trackName }]
        })
      });

      const trackData = await trackRes.json();
      activeBroadcast.sessionId = sessionId;
      activeBroadcast.isLive = true;

      return new Response(JSON.stringify({
        sessionId,
        sdp: trackData.sessionDescription.sdp
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Listener Subscribe
    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      if (!activeBroadcast.isLive || !activeBroadcast.sessionId) {
        return new Response(JSON.stringify({ error: "Broadcast Offline" }), { 
          status: 404, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      const { sdp } = await request.json();

      const sessionRes = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/new`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CALLS_APP_SECRET}` }
      });
      const sessionData = await sessionRes.json();
      const sessionId = sessionData.sessionId;

      const trackRes = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/${sessionId}/tracks/new`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CALLS_APP_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionDescription: { sdp, type: "offer" },
          tracks: [{ location: "remote", sessionId: activeBroadcast.sessionId, trackName: activeBroadcast.trackName }]
        })
      });

      const trackData = await trackRes.json();
      return new Response(JSON.stringify({
        sessionId,
        sdp: trackData.sessionDescription.sdp
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Stop Stream
    if (url.pathname === "/api/stop" && request.method === "POST") {
      activeBroadcast.isLive = false;
      activeBroadcast.sessionId = null;
      return new Response(JSON.stringify({ success: true }), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // Serve static files
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
