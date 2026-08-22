// main.js — Cheap Chess app bootstrap: registers the PWA service worker,
// mounts the <cheap-chess> component, and exposes a debug handle.

import './chess-board.js';

const VERSION = '0.1.0';

// PWA: offline support via service worker (works over http/https; no-op on file://)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('service worker registration failed', err);
    });
  });
}

// debug handle for experiments / automation
window.cheapChess = {
  version: VERSION,
  get component() { return document.querySelector('cheap-chess'); },
};

document.addEventListener('DOMContentLoaded', () => {
  const el = document.querySelector('cheap-chess');
  if (el) {
    el.addEventListener('cheap-chess:move', (e) => {
      console.debug('cheap-chess:move', e.detail.result.status, e.detail.result.winner);
    });
  }
  console.info(`Cheap Chess v${VERSION} — the browser is the OS`);
});
