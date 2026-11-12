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

/* ========================================================
   AUDIO BOOSTER & CROSS-FEED SOUND ENGINE
   ======================================================== */
class AudioBooster {
  constructor() {
    this.audioCtx = null;
    this.nodes = new Map(); // video -> { source, gainNode, compressor }
    this.globalVolume = 1.0;
    this.isMuted = true; // Starts true for browser autoplay compliance
    this.boostFactor = 2.5; // +8dB preamp boost for TV broadcast loudness
  }

  initContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioCtx = new AudioCtx();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  ensureContextRunning() {
    this.initContext();
  }

  attachVideo(video) {
    if (!video || this.nodes.has(video)) return;
    this.initContext();
    if (!this.audioCtx) return;

    try {
      const source = this.audioCtx.createMediaElementSource(video);
      const gainNode = this.audioCtx.createGain();
      const compressor = this.audioCtx.createDynamicsCompressor();

      // Transparent peak limiting to prevent clipping distortion
      compressor.threshold.setValueAtTime(-12, this.audioCtx.currentTime);
      compressor.knee.setValueAtTime(24, this.audioCtx.currentTime);
      compressor.ratio.setValueAtTime(6, this.audioCtx.currentTime);
      compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
      compressor.release.setValueAtTime(0.25, this.audioCtx.currentTime);

      source.connect(gainNode);
      gainNode.connect(compressor);
      compressor.connect(this.audioCtx.destination);

      this.nodes.set(video, { source, gainNode, compressor });
    } catch (err) {
      console.warn('Web Audio attach error (falling back to native audio):', err);
    }
  }

  setVolume(vol) {
    this.globalVolume = Math.max(0, Math.min(1, vol));
    this.initContext();
    if (this.globalVolume > 0 && this.isMuted) {
      this.isMuted = false;
    } else if (this.globalVolume === 0) {
      this.isMuted = true;
    }
    this.syncAllFeeds();
  }

  setMuted(muted) {
    this.isMuted = Boolean(muted);
    this.initContext();
    this.syncAllFeeds();
  }

  toggleMute() {
    this.setMuted(!this.isMuted);
    return this.isMuted;
  }

  syncAllFeeds() {
    feeds.forEach((feed) => {
      const state = feedState.get(feed.id);
      if (!state || !state.video) return;

      const isSelected = (feed.id === selectedFeedId);
      const shouldHear = isSelected && !this.isMuted && this.globalVolume > 0;

      // HTML5 video native properties
      state.video.muted = !shouldHear;
      state.video.volume = this.globalVolume;

      // Web Audio gain node update
      const node = this.nodes.get(state.video);
      if (node && this.audioCtx) {
        const gainVal = shouldHear ? (this.globalVolume * this.boostFactor) : 0;
        node.gainNode.gain.setValueAtTime(gainVal, this.audioCtx.currentTime);
      }
    });

    updateAudioUI();
  }
}

const audioBooster = new AudioBooster();

/* ========================================================
   STATE & DOM ELEMENTS
   ======================================================== */
const feedState = new Map();
const playerContainer = document.querySelector('#player-container');
const stage = document.querySelector('#stage');
const dialog = document.querySelector('#source-dialog');
const sourceForm = document.querySelector('#source-form');
const manifestInput = document.querySelector('#manifest-url');
const sourceError = document.querySelector('#source-error');
const appMessage = document.querySelector('#app-message');
const siteLoader = document.querySelector('#site-loader');
const loaderProgress = document.querySelector('#loader-progress');
const loaderProgressBar = document.querySelector('#loader-progress-bar');
const loaderProgressText = document.querySelector('#loader-progress-text');
const loaderEnterButton = document.querySelector('#loader-enter-button');

// Floating Controls DOM Elements
const topPipButton = document.querySelector('#player-top-pip');
const unmuteOverlay = document.querySelector('#player-unmute-overlay');
const btnPlayPause = document.querySelector('#btn-play-pause');
const btnVolume = document.querySelector('#btn-volume');
const volSlider = document.querySelector('#pill-vol-slider');
const btnMultiView = document.querySelector('#btn-multiview');
const btnTheater = document.querySelector('#btn-theater');
const btnQuality = document.querySelector('#btn-quality');
const qualityBadgeText = document.querySelector('#quality-badge-text');
const qualityDropdown = document.querySelector('#quality-dropdown-menu');
const btnFullscreen = document.querySelector('#btn-fullscreen');

let selectedFeedId = 'all';
let pendingFeedId = null;
let currentQuality = 'auto'; // 'auto' or number height (1080, 720, etc.)
let controlsIdleTimer = null;

// Initialize Feed State
for (const feed of feeds) {
  feedState.set(feed.id, {
    player: null,
    video: document.querySelector(`#video-${feed.id}`),
    tile: document.querySelector(`[data-feed-id="${feed.id}"]`),
    active: false,
    appliedQuality: null
  });
}

// Polyfill Shaka if present
if (window.shaka) {
  shaka.polyfill.installAll();
}

/* ========================================================
   EVENT LISTENERS & BINDINGS
   ======================================================== */
// Sidebar feed choices
document.querySelectorAll('[data-select-id]').forEach((button) => {
  button.addEventListener('click', () => {
    audioBooster.ensureContextRunning();
    selectFeed(button.dataset.selectId);
  });
});

// Grid feed tiles: clicking a tile in Multi-View selects it
document.querySelectorAll('.feed-tile').forEach((tile) => {
  tile.addEventListener('click', () => {
    const feedId = tile.dataset.feedId;
    const isGrid = stage.classList.contains('stage--grid');
    if (feedId && (feedId !== selectedFeedId || isGrid)) {
      audioBooster.ensureContextRunning();
      selectFeed(feedId);
      if (isGrid) {
        setLayout('single');
      }
    }
  });
});

// Floating Top PiP Button
if (topPipButton) {
  topPipButton.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePictureInPicture();
  });
}

// Center "Tap to unmute" Overlay
if (unmuteOverlay) {
  unmuteOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    audioBooster.ensureContextRunning();
    audioBooster.setMuted(false);
    unmuteOverlay.hidden = true;
    const activeVideo = feedState.get(selectedFeedId)?.video;
    if (activeVideo && activeVideo.paused) {
      activeVideo.play().catch(() => {});
    }
  });
}

// Play / Pause Button
if (btnPlayPause) {
  btnPlayPause.addEventListener('click', (e) => {
    e.stopPropagation();
    audioBooster.ensureContextRunning();
    togglePlayPause();
  });
}

// Mute / Volume Button
if (btnVolume) {
  btnVolume.addEventListener('click', (e) => {
    e.stopPropagation();
    audioBooster.ensureContextRunning();
    const isMutedNow = audioBooster.toggleMute();
    if (!isMutedNow && unmuteOverlay) {
      unmuteOverlay.hidden = true;
    }
  });
}

// Volume Slider
if (volSlider) {
  volSlider.addEventListener('input', (e) => {
    const val = Number.parseFloat(e.target.value);
    audioBooster.ensureContextRunning();
    audioBooster.setVolume(val);
    if (val > 0 && unmuteOverlay) {
      unmuteOverlay.hidden = true;
    }
  });
}

// Multi-View Toggle Button
if (btnMultiView) {
  btnMultiView.addEventListener('click', (e) => {
    e.stopPropagation();
    audioBooster.ensureContextRunning();
    const isGrid = stage.classList.contains('stage--grid');
    setLayout(isGrid ? 'single' : 'grid');
  });
}

// Theater / Miniplayer Button
if (btnTheater) {
  btnTheater.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePictureInPicture();
  });
}

// Quality Selector Button & Dropdown Menu
if (btnQuality && qualityDropdown) {
  btnQuality.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = qualityDropdown.hidden;
    qualityDropdown.hidden = !isHidden;
    btnQuality.setAttribute('aria-expanded', String(!isHidden));
  });

  document.addEventListener('click', (e) => {
    if (!qualityDropdown.contains(e.target) && e.target !== btnQuality) {
      qualityDropdown.hidden = true;
      btnQuality.setAttribute('aria-expanded', 'false');
    }
  });

  qualityDropdown.querySelectorAll('.quality-menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetQuality = item.dataset.quality;
      setQuality(targetQuality);
      qualityDropdown.hidden = true;
      btnQuality.setAttribute('aria-expanded', 'false');
    });
  });
}

// Fullscreen Button
if (btnFullscreen) {
  btnFullscreen.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });
}

document.addEventListener('fullscreenchange', updateFullscreenState);
document.addEventListener('webkitfullscreenchange', updateFullscreenState);

// Inactivity Auto-Hide for Controls
if (playerContainer) {
  const resetIdleTimer = () => {
    playerContainer.classList.remove('is-idle');
    clearTimeout(controlsIdleTimer);
    controlsIdleTimer = setTimeout(() => {
      if (qualityDropdown && !qualityDropdown.hidden) return; // keep visible if dropdown is open
      playerContainer.classList.add('is-idle');
    }, 3200);
  };

  playerContainer.addEventListener('mousemove', resetIdleTimer);
  playerContainer.addEventListener('touchstart', resetIdleTimer, { passive: true });
  playerContainer.addEventListener('pointerdown', resetIdleTimer);
  playerContainer.addEventListener('mouseleave', () => {
    if (qualityDropdown && !qualityDropdown.hidden) return;
    playerContainer.classList.add('is-idle');
  });
}

// Header Clean View & Dialogs
document.querySelector('#clean-view-button')?.addEventListener('click', toggleCleanView);
document.querySelector('#close-dialog-button')?.addEventListener('click', closeSourceDialog);
document.querySelector('#cancel-dialog-button')?.addEventListener('click', closeSourceDialog);
sourceForm?.addEventListener('submit', connectFeed);

// Window dot fullscreen toggle
document.querySelector('#dot-fullscreen')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFullscreen();
});

// Support button
document.querySelector('#btn-support')?.addEventListener('click', (e) => {
  e.stopPropagation();
  showMessage('Thank you for supporting PBB Live!');
});

// Initial Setup
selectFeed(selectedFeedId);
initializeLoader();
document.addEventListener('DOMContentLoaded', initializeBuiltInStreams, { once: true });

/* ========================================================
   INITIALIZE & LOAD STREAMS
   ======================================================== */
function initializeBuiltInStreams() {
  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    feeds.forEach(({ id }) => {
      const state = feedState.get(id);
      const status = state.tile.querySelector('.tile-state');
      if (status) {
        status.textContent = 'ERROR';
        status.classList.remove('is-live');
      }
      state.tile.querySelector('.video-empty').hidden = false;
      updateFeedSidebar();
    });
    showMessage('Shaka Player is unavailable or this browser does not support media playback.');
    return;
  }

  // Attach audio booster to all 4 video elements
  feeds.forEach((feed) => {
    const state = feedState.get(feed.id);
    if (state.video) {
      audioBooster.attachVideo(state.video);
    }
  });

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

async function loadFeed(feedId, manifestUrl, drm = null, activateFeed = true) {
  const state = feedState.get(feedId);
  const status = state.tile.querySelector('.tile-state');
  const emptyState = state.tile.querySelector('.video-empty');

  if (status) {
    status.textContent = 'LOADING';
    status.classList.remove('is-live');
  }
  state.video.controls = false;
  state.active = false;
  state.appliedQuality = null;
  emptyState.hidden = false;
  updateFeedSidebar();

  try {
    if (!state.player) {
      state.player = new shaka.Player();
      await state.player.attach(state.video);

      // Shaka ABR & Streaming Configuration
      state.player.configure({
        abr: {
          enabled: (currentQuality === 'auto'),
          defaultBandwidthEstimate: 15000000, // 15 Mbps so 1080p is selected immediately!
          switchInterval: 3,
          bandwidthUpgradeTarget: 0.85,
          bandwidthDowngradeTarget: 0.95
        },
        streaming: {
          rebufferingGoal: 2,
          bufferingGoal: 10,
          bufferBehind: 20,
          stallEnabled: true,
          stallThreshold: 1,
          stallSkip: 0.2,
          retryParameters: {
            maxAttempts: 5,
            baseDelay: 500,
            backoffFactor: 2,
            timeout: 10000
          }
        }
      });

      state.player.addEventListener('error', (event) => {
        showPlaybackError(feedId, event.detail);
      });

      state.player.addEventListener('trackschanged', () => {
        if (feedId === selectedFeedId) {
          applyQualityToPlayer(state.player);
          updateQualityMenu();
        }
      });
    } else {
      await state.player.unload();
    }

    if (drm) {
      state.player.configure({ drm });
    }

    // Attach to AudioBooster
    audioBooster.attachVideo(state.video);

    // Initial state: muted for autoplay
    state.video.muted = true;
    await state.player.load(manifestUrl.href);

    state.active = true;
    state.video.controls = false;
    emptyState.hidden = true;
    if (status) {
      status.textContent = 'CONNECTED';
      status.classList.add('is-live');
    }
    updateFeedSidebar();

    if (activateFeed || feedId === selectedFeedId) {
      selectFeed(feedId);
    }

    // Apply current quality rule (e.g. locked 1080p or auto)
    applyQualityToPlayer(state.player);

    await state.video.play().catch(() => {
      // Autoplay blocked: user will tap "Tap to unmute" or play
    });

    syncPlaybackWithLayout();
    audioBooster.syncAllFeeds();
  } catch (error) {
    showPlaybackError(feedId, error);
  }
}

function showPlaybackError(feedId, error) {
  const state = feedState.get(feedId);
  const status = state.tile.querySelector('.tile-state');
  const detail = error?.message || error?.code || 'Playback error';
  if (status) {
    status.textContent = 'ERROR';
    status.classList.remove('is-live');
  }
  state.active = false;
  state.video.controls = false;
  state.tile.querySelector('.video-empty').hidden = false;
  updateFeedSidebar();
  showMessage(`Could not load ${feeds.find((f) => f.id === feedId).name}: ${detail}`);
}

/* ========================================================
   FEED SELECTION & AUDIO ROUTING
   ======================================================== */
function selectFeed(feedId) {
  if (!feedState.has(feedId)) return;
  selectedFeedId = feedId;
  const feed = feeds.find((item) => item.id === feedId);

  // Update window title
  const isGrid = stage.classList.contains('stage--grid');
  const windowTitleText = document.querySelector('#window-title-text');
  if (windowTitleText) {
    windowTitleText.textContent = isGrid ? 'PBB Studio — 4-Camera Multi-View' : `${feed.name} — Live`;
  }

  // Update tiles
  feedState.forEach((state, id) => {
    const selected = (id === feedId);
    state.tile.classList.toggle('is-selected', selected);
  });

  updateFeedSidebar();
  updatePlayPauseUI();
  updateQualityMenu();

  // Route boosted audio to selected feed & mute others
  audioBooster.syncAllFeeds();
  syncPlaybackWithLayout();
}

function updateFeedSidebar() {
  const isGrid = stage.classList.contains('stage--grid');
  feeds.forEach((feed) => {
    const isSelected = (feed.id === selectedFeedId);
    const card = document.querySelector(`[data-select-id="${feed.id}"]`);
    const badge = document.querySelector(`[data-feed-badge="${feed.id}"]`);
    if (card) {
      card.classList.toggle('is-active', !isGrid && isSelected);
    }
    if (badge) {
      if (!isGrid && isSelected) {
        badge.textContent = 'ON AIR';
        badge.className = 'feed-status-badge badge--on-air';
      } else {
        badge.textContent = 'HD';
        badge.className = 'feed-status-badge badge--hd';
      }
    }
  });
}

/* ========================================================
   QUALITY LOCK & FULLSCREEN LOSS PREVENTION
   ======================================================== */
function setQuality(quality) {
  currentQuality = quality;
  const state = feedState.get(selectedFeedId);
  if (state && state.player) {
    applyQualityToPlayer(state.player);
  }
  updateQualityMenu();
}

function applyQualityToPlayer(player) {
  if (!player) return;

  if (currentQuality === 'auto') {
    player.configure({
      abr: {
        enabled: true,
        restrictions: {
          minHeight: 0,
          maxHeight: Infinity
        }
      }
    });
  } else {
    const height = Number.parseInt(currentQuality, 10);
    player.configure({
      abr: {
        enabled: false,
        restrictions: {
          minHeight: 0,
          maxHeight: height
        }
      }
    });

    const tracks = player.getVariantTracks()
      .filter((t) => Number.isFinite(t.height) && t.height > 0 && t.height <= height)
      .sort((a, b) => (b.height - a.height) || ((b.bandwidth || 0) - (a.bandwidth || 0)));

    if (tracks.length > 0) {
      player.selectVariantTrack(tracks[0], true);
    }
  }
}

function updateQualityMenu() {
  const badgeText = (currentQuality === 'auto') ? 'AUTO' : `${currentQuality}P`;
  if (qualityBadgeText) qualityBadgeText.textContent = badgeText;

  if (!qualityDropdown) return;
  qualityDropdown.querySelectorAll('.quality-menu-item').forEach((item) => {
    const isSelected = (item.dataset.quality === String(currentQuality));
    item.classList.toggle('is-active', isSelected);
  });
}

/* ========================================================
   PLAYBACK, MULTI-VIEW & LAYOUT
   ======================================================== */
function togglePlayPause() {
  const state = feedState.get(selectedFeedId);
  if (!state || !state.video) return;

  if (state.video.paused) {
    state.video.play().catch(() => {});
  } else {
    state.video.pause();
  }
  updatePlayPauseUI();
}

function updatePlayPauseUI() {
  const state = feedState.get(selectedFeedId);
  if (!state || !state.video || !btnPlayPause) return;

  const isPaused = state.video.paused;
  const iconPause = btnPlayPause.querySelector('.icon-pause');
  const iconPlay = btnPlayPause.querySelector('.icon-play');

  if (iconPause && iconPlay) {
    iconPause.hidden = isPaused;
    iconPlay.hidden = !isPaused;
  }
  btnPlayPause.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
  btnPlayPause.title = isPaused ? 'Play' : 'Pause';
}

function setLayout(layout) {
  const singleView = (layout === 'single');
  stage.classList.toggle('stage--single', singleView);
  stage.classList.toggle('stage--grid', !singleView);

  const windowTitleText = document.querySelector('#window-title-text');
  const feed = feeds.find((item) => item.id === selectedFeedId);
  if (windowTitleText) {
    windowTitleText.textContent = singleView ? `${feed.name} — Live` : 'PBB Studio — 4-Camera Multi-View';
  }

  if (btnMultiView) {
    btnMultiView.classList.toggle('is-active', !singleView);
  }

  syncPlaybackWithLayout();
  audioBooster.syncAllFeeds();
}

function syncPlaybackWithLayout() {
  const singleView = stage.classList.contains('stage--single');

  feedState.forEach((state, id) => {
    if (!state.active || !state.video) return;

    if (singleView && id !== selectedFeedId) {
      if (!state.video.paused) {
        state.video.pause();
      }
    } else if (state.video.paused) {
      state.video.play().catch(() => {});
    }
  });

  setTimeout(updatePlayPauseUI, 100);
}

/* ========================================================
   AUDIO UI UPDATES
   ======================================================== */
function updateAudioUI() {
  if (!btnVolume) return;
  const isMuted = audioBooster.isMuted || audioBooster.globalVolume === 0;

  const iconHigh = btnVolume.querySelector('.icon-vol-high');
  const iconMute = btnVolume.querySelector('.icon-vol-mute');

  if (iconHigh && iconMute) {
    iconHigh.hidden = isMuted;
    iconMute.hidden = !isMuted;
  }
  btnVolume.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
  btnVolume.title = isMuted ? 'Unmute' : 'Mute';

  if (volSlider) {
    volSlider.value = isMuted ? 0 : audioBooster.globalVolume;
    const pct = Math.round(volSlider.value * 100);
    volSlider.style.background = `linear-gradient(to right, #ffffff 0%, #ffffff ${pct}%, rgba(255,255,255,0.28) ${pct}%, rgba(255,255,255,0.28) 100%)`;
  }

  if (unmuteOverlay) {
    unmuteOverlay.hidden = !isMuted;
  }
}

/* ========================================================
   FULLSCREEN & PICTURE-IN-PICTURE
   ======================================================== */
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      }
      return;
    }

    // Go fullscreen on the unified playerContainer so controls & unmute overlay remain accessible!
    if (playerContainer.requestFullscreen) {
      await playerContainer.requestFullscreen();
    } else if (playerContainer.webkitRequestFullscreen) {
      await playerContainer.webkitRequestFullscreen();
    } else {
      showMessage('Fullscreen is not supported by this browser.');
    }
  } catch (error) {
    showMessage(`Could not toggle fullscreen: ${error.message}`);
  }
}

function updateFullscreenState() {
  const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  if (!btnFullscreen) return;

  const iconEnter = btnFullscreen.querySelector('.icon-fs-enter');
  const iconExit = btnFullscreen.querySelector('.icon-fs-exit');

  if (iconEnter && iconExit) {
    iconEnter.hidden = isFs;
    iconExit.hidden = !isFs;
  }
  btnFullscreen.setAttribute('aria-label', isFs ? 'Exit Fullscreen' : 'Fullscreen');
  btnFullscreen.title = isFs ? 'Exit Fullscreen' : 'Fullscreen';

  // Ensure locked quality is re-verified upon entering/exiting fullscreen
  const activeState = feedState.get(selectedFeedId);
  if (activeState && activeState.player) {
    applyQualityToPlayer(activeState.player);
  }
}

async function togglePictureInPicture() {
  const state = feedState.get(selectedFeedId);
  if (!state || !state.active || !state.video) {
    showMessage('Wait for the feed to load before using Picture-in-Picture.');
    return;
  }

  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled && state.video.requestPictureInPicture) {
      await state.video.requestPictureInPicture();
    } else {
      showMessage('Picture-in-picture is not supported on this device/browser.');
    }
  } catch (error) {
    showMessage(`Could not open Picture-in-Picture: ${error.message}`);
  }
}

/* ========================================================
   CUSTOM STREAM DIALOG & CLEAN VIEW
   ======================================================== */
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

  const feedId = pendingFeedId;
  closeSourceDialog();
  await loadFeed(feedId, manifestUrl);
}

function parsePublicManifestUrl(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function toggleCleanView() {
  const cleanView = document.body.classList.toggle('clean-view');
  document.querySelector('#clean-view-button')?.setAttribute('aria-pressed', String(cleanView));
}

/* ========================================================
   LOADER & MESSAGING
   ======================================================== */
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
      return state.active || state.tile.querySelector('.tile-state')?.textContent === 'ERROR';
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
    audioBooster.ensureContextRunning();
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
  if (appMessage) appMessage.textContent = message;
}
