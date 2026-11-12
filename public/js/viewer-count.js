(() => {
  const viewerCount = document.querySelector('#viewer-count');
  const viewerCountValue = document.querySelector('#viewer-count-value');
  if (!viewerCount || !viewerCountValue) return;

  const storageKey = 'pbb-live-viewer-id';
  const viewerIdPattern = /^[a-z0-9-]{16,64}$/i;

  function createViewerId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  let viewerId;
  try {
    viewerId = window.localStorage.getItem(storageKey);
    if (!viewerIdPattern.test(viewerId || '')) {
      viewerId = createViewerId();
      window.localStorage.setItem(storageKey, viewerId);
    }
  } catch (error) {
    console.warn('Persistent viewer ID unavailable; this tab will be counted separately.', error);
    viewerId = createViewerId();
  }

  let heartbeatPending = false;
  async function updateViewerCount() {
    if (heartbeatPending) return;
    heartbeatPending = true;

    try {
      const response = await fetch('/api/viewers/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: viewerId }),
        cache: 'no-store'
      });
      if (!response.ok) {
        throw new Error(`Viewer heartbeat failed with status ${response.status}.`);
      }

      const result = await response.json();
      if (!Number.isInteger(result.count) || result.count < 0) {
        throw new Error('Viewer heartbeat returned an invalid count.');
      }

      viewerCountValue.textContent = result.count.toLocaleString();
      viewerCount.dataset.state = 'online';
      viewerCount.setAttribute('aria-label', `${result.count} viewers online`);
    } catch (error) {
      viewerCountValue.textContent = '—';
      viewerCount.dataset.state = 'unavailable';
      viewerCount.setAttribute('aria-label', 'Viewer count unavailable');
      console.warn('Unable to update the live viewer count:', error);
    } finally {
      heartbeatPending = false;
    }
  }

  updateViewerCount();
  window.setInterval(updateViewerCount, 10_000);
})();
