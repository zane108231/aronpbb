'use strict';

const feeds = [
  { id: 'all', name: 'PBB All Access' },
  { id: 'din', name: 'PBB Dining Area' },
  { id: 'ext', name: 'PBB External Den' },
  { id: 'main', name: 'PBB Main Live' }
];

const builtInStreams = {
  all: {
    url: 'https://absp-live.akamaized.net/dash/live/2099522/pbbcollab30allaccesslivestream/manifest.mpd',
    kid: '8150b74d16324bb4b2ff62e3e202fc7a',
    key: '0c5ed4f9db9d4ee61bbc91b3a51ef8b5',
    token: '88ff41f2e8ae28371d8afc70b7121245'
  },
  ext: {
    url: 'https://absp-live.akamaized.net/dash/live/2099522/pbbcollab30allaccesslivestream-externalden/manifest.mpd',
    kid: 'b750a40736a24e60b5a4f256208b92c5',
    key: 'af07292597f692726dcac2bd297ddf8e',
    token: 'd704f1b3c3b43631b5c17acd79b38d5d'
  },
  din: {
    url: 'https://absp-live.akamaized.net/dash/live/2099522/pbbcollab30allaccesslivestream-diningarea/manifest.mpd',
    kid: 'ea6588d030c94ca89925ac0c49974430',
    key: '3e6de4afee1eff8e14f9506b76ac9ee6',
    token: '6dc8970921e7780c5f0a6b1620999461'
  },
  main: {
    url: 'https://absp-live.akamaized.net/dash/live/2099522/pinoybigbrothercollabedition30live/manifest.mpd',
    kid: '1044e7ece2d741bcafe80d8613da104f',
    key: 'f5e17f169ff05ea40c5d3f065f523942',
    token: '797f84fb9a3b7610edc86bfe1f8d1743'
  }
};

const feedState = new Map();
const stage = document.querySelector('#stage');
const dialog = document.querySelector('#source-dialog');
const sourceForm = document.querySelector('#source-form');
const manifestInput = document.querySelector('#manifest-url');
const sourceError = document.querySelector('#source-error');
const appMessage = document.querySelector('#app-message');
const qualitySelect = document.querySelector('#quality-select');
const siteLoader = document.querySelector('#site-loader');
const loaderProgress = document.querySelector('#loader-progress');
const loaderProgressBar = document.querySelector('#loader-progress-bar');
const loaderProgressText = document.querySelector('#loader-progress-text');
const loaderEnterButton = document.querySelector('#loader-enter-button');
const fullscreenButton = document.querySelector('#fullscreen-button');
let selectedFeedId = 'all';
let pendingFeedId = null;
let zoom = 1;

for (const feed of feeds) {
  feedState.set(feed.id, {
    player: null,
    video: document.querySelector(`#video-${feed.id}`),
    tile: document.querySelector(`[data-feed-id="${feed.id}"]`),
    active: false,
    appliedQuality: null
  });
}

if (window.shaka) {
  shaka.polyfill.installAll();
}

document.querySelectorAll('[data-select-id]').forEach((button) => {
  button.addEventListener('click', () => selectFeed(button.dataset.selectId));
});

document.querySelectorAll('[data-connect-id]').forEach((button) => {
  button.addEventListener('click', () => openSourceDialog(button.dataset.connectId));
});

document.querySelectorAll('[data-audio-id]').forEach((button) => {
  button.addEventListener('click', () => toggleAudio(button.dataset.audioId));
});

document.querySelector('#four-view-button').addEventListener('click', () => setLayout('grid'));
document.querySelector('#single-view-button').addEventListener('click', () => setLayout('single'));
document.querySelector('#zoom-in-button').addEventListener('click', () => setZoom(zoom + 0.1));
document.querySelector('#zoom-out-button').addEventListener('click', () => setZoom(zoom - 0.1));
document.querySelector('#reset-zoom-button').addEventListener('click', () => setZoom(1));
document.querySelector('#pip-button').addEventListener('click', togglePictureInPicture);
document.querySelector('#fullscreen-button').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.querySelector('#clean-view-button').addEventListener('click', toggleCleanView);
document.querySelector('#close-dialog-button').addEventListener('click', closeSourceDialog);
document.querySelector('#cancel-dialog-button').addEventListener('click', closeSourceDialog);
sourceForm.addEventListener('submit', connectFeed);
qualitySelect.addEventListener('change', changeQuality);

selectFeed(selectedFeedId);
initializeLoader();
document.addEventListener('DOMContentLoaded', initializeBuiltInStreams, { once: true });

function initializeBuiltInStreams() {
  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    feeds.forEach(({ id }) => {
      const state = feedState.get(id);
      const status = state.tile.querySelector('.tile-state');
      status.textContent = 'ERROR';
      status.classList.remove('is-live');
      state.tile.querySelector('.video-empty').hidden = false;
      updateFeedSidebar();
    });
    showMessage('Shaka Player is unavailable or this browser does not support media playback.');
    return;
  }

  Promise.all(feeds.map((feed) => {
    const stream = builtInStreams[feed.id];
    return loadFeed(feed.id, buildTokenizedManifestUrl(stream), {
      clearKeys: {
        [stream.kid]: stream.key
      }
    }, false);
  }));
}

function buildTokenizedManifestUrl(stream) {
  const url = new URL(stream.url);
  url.searchParams.set('token', stream.token);
  return url;
}

function openSourceDialog(feedId) {
  pendingFeedId = feedId;
  const feed = feeds.find((item) => item.id === feedId);
  document.querySelector('#dialog-title').textContent = `Connect ${feed.name}`;
  sourceError.hidden = true;
  manifestInput.value = '';
  dialog.showModal();
  manifestInput.focus();
}

function closeSourceDialog() {
  dialog.close();
  pendingFeedId = null;
  sourceError.hidden = true;
}

async function connectFeed(event) {
  event.preventDefault();
  sourceError.hidden = true;

  const manifestUrl = parsePublicManifestUrl(manifestInput.value);
  if (!manifestUrl) {
    sourceError.textContent = 'Use a valid HTTPS manifest URL without query strings, fragments, or embedded credentials.';
    sourceError.hidden = false;
    return;
  }

  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    sourceError.textContent = 'Shaka Player is unavailable or this browser does not support media playback.';
    sourceError.hidden = false;
    return;
  }

  const feedId = pendingFeedId;
  closeSourceDialog();
  await loadFeed(feedId, manifestUrl);
}

async function loadFeed(feedId, manifestUrl, drm = null, activateFeed = true) {
  const state = feedState.get(feedId);
  const button = state.tile.querySelector('.connect-button');
  const status = state.tile.querySelector('.tile-state');
  const emptyState = state.tile.querySelector('.video-empty');

  button.disabled = true;
  button.textContent = 'Loading…';
  status.textContent = 'LOADING';
  status.classList.remove('is-live');
  state.video.controls = false;
  state.active = false;
  state.appliedQuality = null;
  emptyState.hidden = false;
  updateFeedSidebar();

  try {
    if (!state.player) {
      state.player = new shaka.Player();
      await state.player.attach(state.video);
      state.player.addEventListener('error', (event) => {
        showPlaybackError(feedId, event.detail);
      });
      state.player.addEventListener('trackschanged', () => {
        if (feedId === selectedFeedId) {
          updateQualityOptions();
        }
      });
    } else {
      await state.player.unload();
    }

    if (drm) {
      state.player.configure({ drm });
    }

    state.video.muted = true;
    await state.player.load(manifestUrl.href);
    state.active = true;
    state.video.controls = false;
    emptyState.hidden = true;
    status.textContent = 'CONNECTED';
    status.classList.add('is-live');
    updateFeedSidebar();
    button.textContent = 'Change feed';
    if (activateFeed || feedId === selectedFeedId) {
      selectFeed(feedId);
    }
    showMessage(`${feeds.find((feed) => feed.id === feedId).name} connected.`);
    await state.video.play().catch(() => {
      showMessage(`${feeds.find((feed) => feed.id === feedId).name} loaded, but autoplay was blocked.`);
    });
    syncPlaybackWithLayout();
  } catch (error) {
    showPlaybackError(feedId, error);
    button.textContent = state.active ? 'Change feed' : 'Connect feed';
  } finally {
    button.disabled = false;
  }
}

function parsePublicManifestUrl(value) {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function showPlaybackError(feedId, error) {
  const state = feedState.get(feedId);
  const status = state.tile.querySelector('.tile-state');
  const detail = error?.message || error?.code || 'Unknown playback error';
  status.textContent = 'ERROR';
  status.classList.remove('is-live');
  state.active = false;
  state.video.controls = false;
  state.tile.querySelector('.video-empty').hidden = false;
  updateFeedSidebar();
  showMessage(`Could not load ${feeds.find((feed) => feed.id === feedId).name}: ${detail}`);
}

function selectFeed(feedId) {
  if (!feedState.has(feedId)) {
    return;
  }

  selectedFeedId = feedId;
  const feed = feeds.find((item) => item.id === feedId);

  document.querySelectorAll('[data-select-id]').forEach((button) => {
    const selected = button.dataset.selectId === feedId;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });

  feedState.forEach((state, id) => {
    const selected = id === feedId;
    state.tile.classList.toggle('is-selected', selected);
    state.video.style.setProperty('--video-zoom', selected ? String(zoom) : '1');
  });

  document.querySelector('#selected-feed-title').textContent = feed.name;
  const selectedState = feedState.get(feedId);
  document.querySelector('#connection-label').textContent = selectedState.active ? 'FEED CONNECTED' : 'NO FEED CONNECTED';
  updateFeedSidebar();
  updateQualityOptions();
  syncPlaybackWithLayout();
}

function updateFeedSidebar() {
  let activeCount = 0;

  feeds.forEach((feed) => {
    const state = feedState.get(feed.id);
    const status = document.querySelector(`[data-feed-status="${feed.id}"]`);
    status.textContent = state.active ? 'ON AIR' : feed.id === selectedFeedId ? 'SELECTED' : 'READY';
    status.classList.toggle('is-on-air', state.active);
    activeCount += Number(state.active);
  });

  document.querySelector('#active-feed-count').textContent = `${activeCount} LIVE`;
  document.querySelector('.active-count').classList.toggle('has-live', activeCount > 0);
}

function setLayout(layout) {
  const singleView = layout === 'single';
  stage.classList.toggle('stage--single', singleView);
  stage.classList.toggle('stage--grid', !singleView);
  document.querySelector('#single-view-button').classList.toggle('is-active', singleView);
  document.querySelector('#single-view-button').setAttribute('aria-pressed', String(singleView));
  document.querySelector('#four-view-button').classList.toggle('is-active', !singleView);
  document.querySelector('#four-view-button').setAttribute('aria-pressed', String(!singleView));
  syncPlaybackWithLayout();
}

function syncPlaybackWithLayout() {
  const singleView = stage.classList.contains('stage--single');
  feedState.forEach((state, id) => {
    if (!state.active) {
      return;
    }

    if (singleView && id !== selectedFeedId) {
      if (!state.video.paused) {
        state.video.pause();
      }
    } else if (state.video.paused) {
      state.video.play().catch(() => {});
    }
  });
}

function toggleAudio(feedId) {
  const selected = feedState.get(feedId);
  if (!selected.active) {
    showMessage('Connect this feed before enabling audio.');
    return;
  }

  const shouldUnmute = selected.video.muted;
  feedState.forEach((state, id) => {
    const button = state.tile.querySelector('.audio-button');
    state.video.muted = id !== feedId || !shouldUnmute;
    button.textContent = state.video.muted ? 'Unmute' : 'Mute';
    button.setAttribute('aria-pressed', String(!state.video.muted));
    button.setAttribute('aria-label', `${state.video.muted ? 'Unmute' : 'Mute'} ${feeds.find((feed) => feed.id === id).name}`);
  });
}

function setZoom(nextZoom) {
  zoom = Math.min(2.5, Math.max(1, Math.round(nextZoom * 10) / 10));
  feedState.get(selectedFeedId).video.style.setProperty('--video-zoom', String(zoom));
  document.querySelector('#zoom-value').textContent = `${Math.round(zoom * 100)}%`;
}

async function togglePictureInPicture() {
  const state = feedState.get(selectedFeedId);
  if (!state.active) {
    showMessage('Connect the selected feed before using picture-in-picture.');
    return;
  }

  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled && state.video.requestPictureInPicture) {
      await state.video.requestPictureInPicture();
    } else {
      showMessage('Picture-in-picture is not supported by this browser.');
    }
  } catch (error) {
    showMessage(`Could not open picture-in-picture: ${error.message}`);
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    const state = feedState.get(selectedFeedId);
    if (!state.active) {
      showMessage('Wait for the selected feed to load before using fullscreen.');
      return;
    }

    if (state.tile.requestFullscreen) {
      await state.tile.requestFullscreen();
    } else {
      showMessage('Fullscreen is not supported by this browser.');
    }
  } catch (error) {
    showMessage(`Could not toggle fullscreen: ${error.message}`);
  }
}

function updateFullscreenButton() {
  const isFullscreen = Boolean(document.fullscreenElement);
  fullscreenButton.textContent = isFullscreen ? 'Exit full' : 'Full';
  fullscreenButton.setAttribute('aria-pressed', String(isFullscreen));
}

function toggleCleanView() {
  const cleanView = document.body.classList.toggle('clean-view');
  document.querySelector('#clean-view-button').setAttribute('aria-pressed', String(cleanView));
}

function updateQualityOptions() {
  const state = feedState.get(selectedFeedId);
  const previousValue = qualitySelect.value;
  qualitySelect.replaceChildren(new Option('Auto', 'auto'));

  if (!state.player || !state.active) {
    qualitySelect.disabled = true;
    return;
  }

  const heights = [...new Set(
    state.player.getVariantTracks()
      .filter((track) => track.height > 0)
      .map((track) => track.height)
  )].sort((a, b) => b - a);

  for (const height of heights) {
    qualitySelect.add(new Option(`${height}p`, String(height)));
  }
  qualitySelect.disabled = false;
  qualitySelect.value = [...qualitySelect.options].some((option) => option.value === previousValue)
    ? previousValue
    : 'auto';
  changeQuality();
}

function changeQuality() {
  const state = feedState.get(selectedFeedId);
  if (!state.player || !state.active) {
    return;
  }

  const selectedHeight = qualitySelect.value;
  if (state.appliedQuality === selectedHeight) {
    return;
  }

  if (selectedHeight === 'auto') {
    state.player.configure('abr.enabled', true);
    state.appliedQuality = 'auto';
    return;
  }

  state.player.configure('abr.enabled', false);
  const track = state.player.getVariantTracks()
    .filter((item) => item.height === Number(selectedHeight))
    .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  if (track) {
    state.player.selectVariantTrack(track, true);
    state.appliedQuality = selectedHeight;
  } else {
    state.player.configure('abr.enabled', true);
    state.appliedQuality = 'auto';
    qualitySelect.value = 'auto';
  }
}

function initializeLoader() {
  if (!siteLoader || !loaderProgress || !loaderProgressBar || !loaderProgressText || !loaderEnterButton) {
    return;
  }

  const startedAt = performance.now();
  const minimumDuration = 2400;
  const maximumDuration = 10000;
  let displayedProgress = 0;

  const tick = () => {
    const elapsed = performance.now() - startedAt;
    const settledCount = feeds.filter((feed) => {
      const state = feedState.get(feed.id);
      return state.active || state.tile.querySelector('.tile-state').textContent === 'ERROR';
    }).length;
    const settledFraction = settledCount / feeds.length;
    const timeFraction = Math.min(1, elapsed / minimumDuration);
    const targetProgress = Math.min(0.95, Math.max(timeFraction * 0.95, settledFraction * 0.95));
    displayedProgress += (targetProgress - displayedProgress) * 0.1;
    if (Math.abs(targetProgress - displayedProgress) < 0.002) {
      displayedProgress = targetProgress;
    }
    setLoaderProgress(displayedProgress);

    if ((elapsed >= minimumDuration && settledCount === feeds.length) || elapsed >= maximumDuration) {
      completeLoader();
      return;
    }
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  loaderEnterButton.addEventListener('click', () => {
    setLayout('single');
    siteLoader.classList.add('is-leaving');
    window.setTimeout(() => {
      siteLoader.hidden = true;
    }, 460);
  }, { once: true });
}

function setLoaderProgress(value) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  loaderProgressBar.style.width = `${percent}%`;
  loaderProgressText.textContent = `${percent}%`;
  loaderProgress.setAttribute('aria-valuenow', String(percent));
}

function completeLoader() {
  setLoaderProgress(100);
  siteLoader.classList.add('is-complete');
  loaderEnterButton.hidden = false;
}

function showMessage(message) {
  appMessage.textContent = message;
}
