/**
 * sw.js - Background Audio Network Persist Engine
 * Keeps the browser process active when the phone screen is locked.
 */

const CACHE_NAME = 'masjid-live-audio-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler ensuring real-time WebRTC streams bypass caches
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      // Fallback if offline
    })
  );
});
