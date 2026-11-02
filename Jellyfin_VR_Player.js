/*
 * Jellyfin supports plugins for VR v1
 */
(function () {
  'use strict';

  if (window.__JELLYFIN_VR_V42__) return;
  window.__JELLYFIN_VR_V42__ = true;

  const THREE_URL = document.currentScript?.dataset.threeUrl
    || 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.min.js';
  const BUTTON_ID = 'jvr-v4-button';
  const OVERLAY_ID = 'jvr-v4-overlay';
  const PANEL_WIDTH = 1.82;
  const PANEL_HEIGHT = 0.82;
  const PANEL_HOME = { x: 0, y: -0.13, z: -1.32 };
  const TIMELINE = { x: 80, y: 164, width: 1440, height: 76, trackY: 192, trackHeight: 20 };
  const HUD = {
    canvasWidth: 1600,
    canvasHeight: 210,
    width: 1.0,
    height: 0.131,
    home: { x: 0, y: -0.42, z: -1.2 },
    progress: { x: 40, y: 126, width: 1140, height: 34 },
    zoomMinus: { x: 1232, y: 120, width: 52, height: 46 },
    zoomTrack: { x: 1298, y: 126, width: 158, height: 34 },
    zoomPlus: { x: 1482, y: 120, width: 52, height: 46 },
    close: { x: 1530, y: 14, width: 54, height: 50 }
  };
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 3;

  let overlay = null;
  let statusEl = null;
  let sourceVideo = null;
  let activeVideo = null;
  let compatVideo = null;
  let originalState = null;
  let compatUrl = '';
  let compatOffset = 0;
  let sourceMode = 'original';
  let loadSerial = 0;

  let world = null;
  let camera = null;
  let renderer = null;
  let videoTexture = null;
  let videoRoot = null;
  let videoMeshes = [];
  let controllers = [];
  let panelMesh = null;
  let panelCanvas = null;
  let panelContext = null;
  let panelTexture = null;
  let panelBorder = null;
  let panelCursor = null;
  let panelVisible = false;
  let panelButtons = [];
  let hoverAction = '';
  let lastPanelDraw = 0;
  let lastStickAction = 0;
  let hudMesh = null;
  let hudCanvas = null;
  let hudContext = null;
  let hudTexture = null;
  let hudVisible = false;
  let hudHover = '';
  let hudDockEl = null;
  let hudSeekEl = null;
  let hudSeekTimeEl = null;
  let hudZoomEl = null;
  let hudZoomValueEl = null;
  let hudSeeking = false;
  let zoom = 1;
  let xrSession = null;
  let closing = false;

  let scanTimer = 0;
  let resizeHandler = null;
  let pointerDrag = null;
  let pointerHud = null;
  let pointerHandlers = null;
  const inputStates = new WeakMap();
  const triggerStates = new WeakMap();
  const gripTimers = new WeakMap();
  const dragState = {
    controller: null,
    type: '',
    startTime: 0,
    startDirection: null,
    startYaw: 0,
    startPitch: 0,
    startPanelPosition: null,
    seekTime: 0,
    moved: false
  };
  const currentMode = { projection: '180', stereo: 'sbs', swap: false };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.THREE?.WebGLRenderer) return resolve();
      // 已存在的同源标签可能是失败/加载中的，复用它只会永远等不到 load 事件。
      const script = document.createElement('script');
      script.src = src;
      script.crossOrigin = 'anonymous';
      const timer = setTimeout(() => reject(new Error('Three.js 加载超时')), 20000);
      script.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
      script.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Three.js 加载失败')); }, { once: true });
      document.head.appendChild(script);
    });
  }

  async function ensureThree() {
    if (!window.THREE?.WebGLRenderer) await loadScript(THREE_URL);
    if (!window.THREE?.WebGLRenderer) throw new Error('Three.js 初始化失败');
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video')).filter((video) => video.id !== 'jvr-compat-video');
    return videos.find((video) => video.currentSrc && !video.paused)
      || videos.find((video) => video.currentSrc || video.src)
      || null;
  }

  function formatTime(value) {
    if (!Number.isFinite(value)) return '0:00';
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = Math.floor(value % 60).toString().padStart(2, '0');
    return hours
      ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds}`
      : `${minutes}:${seconds}`;
  }

  function setQueryParam(url, name, value) {
    Array.from(url.searchParams.keys()).forEach((key) => {
      if (key.toLowerCase() === name.toLowerCase()) url.searchParams.delete(key);
    });
    if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
  }

  function buildCompatStreamUrl(video) {
    const raw = video?.currentSrc || video?.src;
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      const match = url.pathname.match(/^(.*\/Videos\/)([^/]+)\/stream(?:\.[^/]*)?$/i);
      if (!match) return '';
      url.pathname = `${match[1]}${match[2]}/stream.mp4`;
      setQueryParam(url, 'Static', 'false');
      setQueryParam(url, 'VideoCodec', 'h264');
      setQueryParam(url, 'AudioCodec', 'aac');
      setQueryParam(url, 'EnableAutoStreamCopy', 'false');
      setQueryParam(url, 'AllowVideoStreamCopy', 'false');
      setQueryParam(url, 'AllowAudioStreamCopy', 'false');
      setQueryParam(url, 'MaxVideoBitDepth', '8');
      setQueryParam(url, 'RequireAvc', 'true');
      setQueryParam(url, 'VideoBitRate', '40000000');
      setQueryParam(url, 'AudioBitRate', '320000');
      setQueryParam(url, 'AudioChannels', '2');
      setQueryParam(url, 'MaxWidth', '4096');
      setQueryParam(url, 'MaxHeight', '4096');
      setQueryParam(url, 'Context', 'Streaming');
      setQueryParam(url, 'SubtitleStreamIndex', null);
      setQueryParam(url, 'SubtitleMethod', null);
      setQueryParam(url, 'StartTimeTicks', null);
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function getCurrentTime() {
    if (!activeVideo) return 0;
    return sourceMode === 'compat'
      ? compatOffset + (activeVideo.currentTime || 0)
      : (activeVideo.currentTime || 0);
  }

  function getDuration() {
    const candidates = [originalState?.duration, sourceVideo?.duration, activeVideo?.duration];
    return candidates.find((value) => Number.isFinite(value) && value > 0) || 0;
  }

  function addStyles() {
    if (document.getElementById('jvr-v4-style')) return;
    const style = document.createElement('style');
    style.id = 'jvr-v4-style';
    style.textContent = `
      #${OVERLAY_ID}{position:fixed;inset:0;z-index:2147483646;background:#000;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
       #${OVERLAY_ID} .jvr-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab}
      #${OVERLAY_ID} .jvr-bar{position:absolute;top:0;left:0;right:0;z-index:5;display:flex;align-items:center;gap:7px;padding:10px;background:linear-gradient(#000e,transparent);pointer-events:auto}
      #${OVERLAY_ID} button{border:1px solid #ffffff45;border-radius:7px;background:#17191ddd;color:#fff;padding:8px 10px;font:inherit;cursor:pointer}
      #${OVERLAY_ID} button.active{border-color:#20b9ed;background:#075c78}
      #${OVERLAY_ID} button:disabled{opacity:.4;cursor:not-allowed}
      #${OVERLAY_ID} .jvr-enter{margin-left:auto;background:#008fbd;font-weight:700}
      #${OVERLAY_ID} .jvr-close{font-size:20px;padding:4px 12px}
      #${OVERLAY_ID} .jvr-dock{position:absolute;left:50%;bottom:56px;z-index:6;transform:translateX(-50%);display:flex;align-items:center;gap:10px;width:min(780px,92vw);padding:8px 12px;border-radius:12px;background:#0b0f14e6;border:1px solid #ffffff26}
      #${OVERLAY_ID} .jvr-dock[hidden]{display:none}
      #${OVERLAY_ID} .jvr-dock span{font-size:12px;color:#9fb2c2;white-space:nowrap;font-variant-numeric:tabular-nums}
      #${OVERLAY_ID} .jvr-dock input[type=range]{appearance:none;-webkit-appearance:none;height:20px;background:transparent;cursor:pointer;margin:0}
      #${OVERLAY_ID} .jvr-dock .jvr-seek{flex:1;min-width:80px}
      #${OVERLAY_ID} .jvr-dock .jvr-zoom{width:110px}
      #${OVERLAY_ID} .jvr-dock input[type=range]::-webkit-slider-runnable-track{height:8px;border-radius:4px;background:#2b3742}
      #${OVERLAY_ID} .jvr-dock input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;margin-top:-5px;border-radius:50%;background:#fff;border:2px solid #0b1116}
      #${OVERLAY_ID} .jvr-dock input[type=range]::-moz-range-track{height:8px;border-radius:4px;background:#2b3742}
      #${OVERLAY_ID} .jvr-dock input[type=range]::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:#fff}
      #${OVERLAY_ID} .jvr-dock button{font-size:16px;line-height:1;padding:2px 9px}
      #${OVERLAY_ID} .jvr-status{position:absolute;left:50%;bottom:20px;z-index:5;transform:translateX(-50%);padding:8px 12px;border-radius:7px;background:#111e;color:#ccd3da;font-size:13px;white-space:nowrap;pointer-events:none}
      @media(max-width:780px){#${OVERLAY_ID} .jvr-bar{flex-wrap:wrap}.jvr-label{display:none}}
    `;
    document.head.appendChild(style);
  }

  function createButton(label, action, value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = action;
    if (value) button.dataset.value = value;
    return button;
  }

  function buildOverlay() {
    addStyles();
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    const bar = document.createElement('div');
    bar.className = 'jvr-bar';
    const close = createButton('←', 'exit');
    close.className = 'jvr-close';
    bar.append(close);
    const version = document.createElement('span');
    version.className = 'jvr-label';
    version.textContent = 'Jellyfin VR v4.3';
    bar.append(version);
    [['360°', '360'], ['180° 经编', '180'], ['180° 鱼眼', 'fisheye'], ['影院', 'flat']]
      .forEach(([label, value]) => bar.append(createButton(label, 'projection', value)));
    [['单眼', 'mono'], ['SBS', 'sbs'], ['OU', 'ou']]
      .forEach(([label, value]) => bar.append(createButton(label, 'stereo', value)));
    bar.append(createButton('交换眼睛', 'swap'));
    const source = createButton('原始源', 'source');
    source.id = 'jvr-source-toggle';
    bar.append(source);
    const hudToggle = createButton('控制条', 'hud');
    hudToggle.id = 'jvr-hud-toggle';
    bar.append(hudToggle);
    const enter = createButton('进入 VR', 'enter');
    enter.className = 'jvr-enter';
    bar.append(enter);
    buildDock();
    statusEl = document.createElement('div');
    statusEl.className = 'jvr-status';
    statusEl.textContent = '正在初始化原生 WebXR 渲染器…';
    overlay.append(bar, hudDockEl, statusEl);
    document.body.appendChild(overlay);
    bar.addEventListener('click', handleToolbar);
  }

  function createPanel() {
    panelCanvas = document.createElement('canvas');
    panelCanvas.width = 1600;
    panelCanvas.height = 720;
    panelContext = panelCanvas.getContext('2d');
    panelTexture = new THREE.CanvasTexture(panelCanvas);
    panelTexture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT);
    const material = new THREE.MeshBasicMaterial({
      map: panelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    panelMesh = new THREE.Mesh(geometry, material);
    panelMesh.name = 'jvr-control-panel';
    panelMesh.position.set(PANEL_HOME.x, PANEL_HOME.y, PANEL_HOME.z);
    panelMesh.renderOrder = 10000;
    panelMesh.visible = false;
    camera.add(panelMesh);

    const borderGeometry = new THREE.EdgesGeometry(geometry);
    const borderMaterial = new THREE.LineBasicMaterial({ color: 0x35cfff, transparent: true, opacity: 0.95, depthTest: false });
    panelBorder = new THREE.LineSegments(borderGeometry, borderMaterial);
    panelBorder.name = 'jvr-panel-drag-border';
    panelBorder.position.z = 0.006;
    panelBorder.renderOrder = 10002;
    panelMesh.add(panelBorder);

    const cursorGeometry = new THREE.RingGeometry(0.013, 0.023, 32);
    const cursorMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    panelCursor = new THREE.Mesh(cursorGeometry, cursorMaterial);
    panelCursor.name = 'jvr-panel-cursor';
    panelCursor.position.z = 0.012;
    panelCursor.renderOrder = 10003;
    panelCursor.visible = false;
    const cursorDot = new THREE.Mesh(
      new THREE.CircleGeometry(0.008, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
    );
    cursorDot.position.z = 0.001;
    panelCursor.add(cursorDot);
    panelMesh.add(panelCursor);
    drawPanel();
  }

  // VR 底部常驻 HUD：进度条 + 缩放条。面板打开时自动让位，避免两块面片在视野底部重叠。
  function createHud() {
    hudCanvas = document.createElement('canvas');
    hudCanvas.width = HUD.canvasWidth;
    hudCanvas.height = HUD.canvasHeight;
    hudContext = hudCanvas.getContext('2d');
    hudTexture = new THREE.CanvasTexture(hudCanvas);
    hudTexture.colorSpace = THREE.SRGBColorSpace;
    hudMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(HUD.width, HUD.height),
      new THREE.MeshBasicMaterial({
        map: hudTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    hudMesh.name = 'jvr-hud';
    hudMesh.position.set(HUD.home.x, HUD.home.y, HUD.home.z);
    hudMesh.renderOrder = 9990;
    hudMesh.visible = false;
    camera.add(hudMesh);
    drawHud();
  }

  function hudHovered(action) {
    return hudHover === action;
  }

  function hudTrack(box, ratio, active) {
    const context = hudContext;
    const value = THREE.MathUtils.clamp(ratio, 0, 1);
    roundedRect(context, box.x, box.y, box.width, box.height, box.height / 2);
    context.fillStyle = '#2b3742cc';
    context.fill();
    roundedRect(context, box.x, box.y, Math.max(box.height, box.width * value), box.height, box.height / 2);
    context.fillStyle = active ? '#5fe3ff' : '#eef6fb';
    context.fill();
    const knobX = box.x + box.width * value;
    const knobY = box.y + box.height / 2;
    context.beginPath();
    context.arc(knobX, knobY, box.height * 0.85, 0, Math.PI * 2);
    context.fillStyle = '#fff';
    context.fill();
    context.strokeStyle = '#0b1116';
    context.lineWidth = 4;
    context.stroke();
  }

  function hudButton(box, text, action) {
    const context = hudContext;
    const hovered = hudHovered(action);
    roundedRect(context, box.x, box.y, box.width, box.height, 16);
    context.fillStyle = hovered ? '#008fc2' : '#27303a';
    context.fill();
    context.strokeStyle = hovered ? '#83ddff' : '#ffffff30';
    context.lineWidth = hovered ? 4 : 2;
    context.stroke();
    context.fillStyle = '#fff';
    context.font = '52px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, box.x + box.width / 2, box.y + box.height / 2);
  }

  function drawHud() {
    if (!hudContext || !hudTexture) return;
    const context = hudContext;
    const now = dragState.type === 'hud-seek' ? dragState.seekTime : getCurrentTime();
    const duration = getDuration();
    const ratio = duration > 0 ? now / duration : 0;
    context.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
    roundedRect(context, 0, 0, HUD.canvasWidth, HUD.canvasHeight, 34);
    context.fillStyle = '#0b0f14e0';
    context.fill();
    context.strokeStyle = hudHovered('progress') || hudHovered('zoom') ? '#4fd8ffcc' : '#ffffff26';
    context.lineWidth = 4;
    context.stroke();
    context.textBaseline = 'middle';
    context.textAlign = 'left';
    context.fillStyle = '#fff';
    context.font = '42px system-ui, sans-serif';
    context.fillText(`${formatTime(now)} / ${formatTime(duration)}`, HUD.progress.x, 56);
    context.textAlign = 'right';
    context.fillStyle = '#8fb3c7';
    context.font = '36px system-ui, sans-serif';
    context.fillText(`缩放 ${Math.round(zoom * 100)}%`, HUD.close.x - 22, 56);
    hudTrack(HUD.progress, ratio, hudHovered('progress'));
    hudTrack(HUD.zoomTrack, (zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN), hudHovered('zoom'));
    hudButton(HUD.zoomMinus, '\u2212', 'zoom-out');
    hudButton(HUD.zoomPlus, '+', 'zoom-in');
    hudButton(HUD.close, '\u00d7', 'hide');
    context.textAlign = 'center';
    context.fillStyle = '#7c8b98';
    context.font = '34px system-ui, sans-serif';
    context.fillText('拖动进度条跳转  ·  右侧缩放画面  ·  × 隐藏控制条  ·  握柄打开面板', HUD.canvasWidth / 2, 190);
    hudTexture.needsUpdate = true;
  }

  function hudPoint(intersection) {
    if (!intersection?.uv) return null;
    return {
      x: intersection.uv.x * HUD.canvasWidth,
      y: (1 - intersection.uv.y) * HUD.canvasHeight
    };
  }

  function inBox(point, box, pad) {
    return point.x >= box.x - pad && point.x <= box.x + box.width + pad
      && point.y >= box.y - pad && point.y <= box.y + box.height + pad;
  }

  function hudActionFromIntersection(intersection) {
    const point = hudPoint(intersection);
    if (!point) return '';
    if (inBox(point, HUD.progress, 24)) return 'progress';
    if (inBox(point, HUD.zoomTrack, 24)) return 'zoom';
    if (inBox(point, HUD.zoomMinus, 8)) return 'zoom-out';
    if (inBox(point, HUD.zoomPlus, 8)) return 'zoom-in';
    if (inBox(point, HUD.close, 8)) return 'hide';
    return '';
  }

  function hudSeekTime(intersection) {
    const point = hudPoint(intersection);
    if (!point || !getDuration()) return getCurrentTime();
    return THREE.MathUtils.clamp((point.x - HUD.progress.x) / HUD.progress.width, 0, 1) * getDuration();
  }

  function hudZoomValue(intersection) {
    const point = hudPoint(intersection);
    if (!point) return zoom;
    const ratio = THREE.MathUtils.clamp((point.x - HUD.zoomTrack.x) / HUD.zoomTrack.width, 0, 1);
    return ZOOM_MIN + ratio * (ZOOM_MAX - ZOOM_MIN);
  }

  function syncHudToggle() {
    overlay?.querySelector('#jvr-hud-toggle')?.classList.toggle('active', hudVisible);
  }

  // 普通屏幕用原生 DOM 控件：鼠标/触摸/键盘都能拖，不依赖 WebGL 射线。
  function buildDock() {
    hudDockEl = document.createElement('div');
    hudDockEl.className = 'jvr-dock';
    hudSeekTimeEl = document.createElement('span');
    hudSeekTimeEl.textContent = '0:00 / 0:00';
    hudSeekEl = document.createElement('input');
    hudSeekEl.type = 'range';
    hudSeekEl.className = 'jvr-seek';
    hudSeekEl.min = '0';
    hudSeekEl.max = '1000';
    hudSeekEl.step = '1';
    hudSeekEl.setAttribute('aria-label', '播放进度');
    const zoomLabel = document.createElement('span');
    zoomLabel.textContent = '缩放';
    hudZoomEl = document.createElement('input');
    hudZoomEl.type = 'range';
    hudZoomEl.className = 'jvr-zoom';
    hudZoomEl.min = String(Math.round(ZOOM_MIN * 100));
    hudZoomEl.max = String(Math.round(ZOOM_MAX * 100));
    hudZoomEl.step = '1';
    hudZoomEl.setAttribute('aria-label', '缩放画面');
    hudZoomValueEl = document.createElement('span');
    hudZoomValueEl.textContent = '100%';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '\u00d7';
    close.title = '隐藏控制条';
    close.addEventListener('click', hideHud);

    hudSeekEl.addEventListener('input', () => {
      // 拖动时只更新读数，松手才真正跳转（兼容源跳转会重起转码）。
      hudSeeking = true;
      hudSeekTimeEl.textContent = `${formatTime((hudSeekEl.value / 1000) * getDuration())} / ${formatTime(getDuration())}`;
    });
    hudSeekEl.addEventListener('change', () => {
      hudSeeking = false;
      seekAbsolute((hudSeekEl.value / 1000) * getDuration());
    });
    hudZoomEl.addEventListener('input', () => setZoom(hudZoomEl.value / 100));

    hudDockEl.append(hudSeekTimeEl, hudSeekEl, zoomLabel, hudZoomEl, hudZoomValueEl, close);
    hudDockEl.hidden = true;
  }

  function syncDock() {
    if (!hudDockEl) return;
    if (hudSeeking) return;
    const duration = getDuration();
    const now = getCurrentTime();
    hudSeekTimeEl.textContent = `${formatTime(now)} / ${formatTime(duration)}`;
    hudSeekEl.value = String(Math.round((duration > 0 ? now / duration : 0) * 1000));
    hudZoomEl.value = String(Math.round(zoom * 100));
    hudZoomValueEl.textContent = `${Math.round(zoom * 100)}%`;
  }

  function showHud() {
    hudVisible = true;
    if (hudDockEl) hudDockEl.hidden = false;
    syncHudToggle();
    syncDock();
    if (hudMesh?.visible) drawHud();
  }

  function hideHud() {
    hudVisible = false;
    hudHover = '';
    if (hudDockEl) hudDockEl.hidden = true;
    if (hudMesh) hudMesh.visible = false;
    syncHudToggle();
  }

  function updateHudHover() {
    if (!hudVisible) {
      if (hudHover) { hudHover = ''; drawHud(); }
      return;
    }
    let next = '';
    for (const controller of controllers) {
      const action = hudActionFromIntersection(raycastHud(controller));
      if (action) { next = action; break; }
    }
    if (next !== hudHover) { hudHover = next; drawHud(); }
  }

  function roundedRect(context, x, y, width, height, radius) {
    context.beginPath();
    if (typeof context.roundRect === 'function') {
      context.roundRect(x, y, width, height, radius);
      return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function addPanelButton(x, y, width, height, label, action, color = '#27303a') {
    const context = panelContext;
    const hovered = hoverAction === action;
    roundedRect(context, x, y, width, height, 18);
    context.fillStyle = hovered ? '#008fc2' : color;
    context.fill();
    context.strokeStyle = hovered ? '#83ddff' : '#ffffff30';
    context.lineWidth = hovered ? 5 : 2;
    context.stroke();
    context.fillStyle = '#fff';
    context.font = '44px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, x + width / 2, y + height / 2);
    panelButtons.push({ x, y, width, height, action });
  }

  function fillFittedText(context, text, centerX, centerY, maxWidth, startSize, minSize = 26) {
    let size = startSize;
    do {
      context.font = `${size}px system-ui, sans-serif`;
      if (context.measureText(text).width <= maxWidth) break;
      size -= 2;
    } while (size > minSize);
    let output = text;
    if (context.measureText(output).width > maxWidth) {
      while (output.length > 4 && context.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
      output += '…';
    }
    context.fillText(output, centerX, centerY);
  }

  function drawPanel() {
    if (!panelContext || !panelTexture) return;
    const context = panelContext;
    panelButtons = [];
    context.clearRect(0, 0, panelCanvas.width, panelCanvas.height);
    roundedRect(context, 0, 0, 1600, 720, 30);
    context.fillStyle = '#10151bf7';
    context.fill();
    context.strokeStyle = '#36d2ffff';
    context.lineWidth = 12;
    context.stroke();
    context.fillStyle = '#123848';
    context.fillRect(28, 18, 1544, 16);
    context.fillStyle = '#5edcff';
    context.font = '28px system-ui, sans-serif';
    context.textAlign = 'right';
    context.fillText('按住边框拖动面板', 1530, 52);
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const title = (document.title || 'Jellyfin VR').replace(/\s+/g, ' ');
    fillFittedText(context, title, 800, 76, 1440, 52, 30);
    context.fillStyle = '#aeb9c4';
    context.font = '42px system-ui, sans-serif';
    const shownTime = dragState.type === 'seek' ? dragState.seekTime : getCurrentTime();
    context.fillText(`${formatTime(shownTime)} / ${formatTime(getDuration())}`, 800, 125);
    const duration = getDuration();
    const progress = duration > 0 ? THREE.MathUtils.clamp(shownTime / duration, 0, 1) : 0;
    roundedRect(context, TIMELINE.x, TIMELINE.trackY, TIMELINE.width, TIMELINE.trackHeight, 10);
    context.fillStyle = '#34414c';
    context.fill();
    roundedRect(context, TIMELINE.x, TIMELINE.trackY, Math.max(20, TIMELINE.width * progress), TIMELINE.trackHeight, 10);
    context.fillStyle = '#f5f8fb';
    context.fill();
    context.beginPath();
    context.arc(TIMELINE.x + TIMELINE.width * progress, TIMELINE.trackY + TIMELINE.trackHeight / 2, 24, 0, Math.PI * 2);
    context.fillStyle = '#fff';
    context.fill();
    context.strokeStyle = '#171d22';
    context.lineWidth = 5;
    context.stroke();
    addPanelButton(55, 275, 170, 105, '-10', 'back');
    addPanelButton(245, 275, 220, 105, activeVideo?.paused ? 'PLAY' : 'PAUSE', 'play', '#006f96');
    addPanelButton(485, 275, 170, 105, '+10', 'forward');
    addPanelButton(675, 275, 210, 105, activeVideo?.muted ? 'MUTED' : 'SOUND', 'mute');
    addPanelButton(905, 275, 210, 105, currentMode.projection.toUpperCase(), 'projection');
    addPanelButton(1135, 275, 180, 105, currentMode.stereo.toUpperCase(), 'stereo');
    addPanelButton(1335, 275, 210, 105, sourceMode === 'compat' ? 'H264' : 'SOURCE', 'source', '#25536a');
    addPanelButton(55, 435, 330, 105, 'SWAP EYES', 'swap');
    addPanelButton(425, 435, 330, 105, 'RESET ALL', 'reset', '#365061');
    addPanelButton(795, 435, 330, 105, 'HIDE PANEL', 'hide');
    addPanelButton(1165, 435, 380, 105, 'EXIT VR', 'exit-vr', '#652d34');
    context.fillStyle = '#81909f';
    context.font = '36px system-ui, sans-serif';
    context.fillText('时间轴：按住拖动  ·  长按扳机拖动画面  ·  长按握柄：全部复位', 800, 635);
    panelTexture.needsUpdate = true;
  }

  function buildRenderer() {
    world = new THREE.Scene();
    world.background = new THREE.Color(0x000000);
    camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 120);
    camera.position.set(0, 1.6, 0);
    camera.layers.enable(0);
    camera.layers.enable(1);
    world.add(camera);
    videoRoot = new THREE.Group();
    videoRoot.name = 'jvr-video-view-root';
    videoRoot.position.set(0, 1.6, 0);
    world.add(videoRoot);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.domElement.className = 'jvr-canvas';
    overlay.prepend(renderer.domElement);
    createPanel();
    createHud();
    showHud();
    setupControllers();
    bindPointerLook();
    resizeHandler = () => {
      if (!renderer || !camera) return;
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    };
    window.addEventListener('resize', resizeHandler);
    renderer.setAnimationLoop(renderFrame);
  }

  function hudHitFromPointer(event) {
    if (!hudVisible || !hudMesh?.visible || !camera) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1),
      camera
    );
    return raycaster.intersectObject(hudMesh, false)[0] || null;
  }

  function beginHudPointer(event) {
    if (dragState.controller || pointerHud) return false;
    const intersection = hudHitFromPointer(event);
    const action = hudActionFromIntersection(intersection);
    if (!action) return false;
    pointerHud = { pointerId: event.pointerId, action, moved: false };
    if (action === 'progress') {
      dragState.type = 'hud-seek';
      dragState.seekTime = hudSeekTime(intersection);
    } else if (action === 'zoom') {
      dragState.type = 'hud-zoom';
    }
    drawHud();
    return true;
  }

  function moveHudPointer(event) {
    if (!pointerHud || pointerHud.pointerId !== event.pointerId) return false;
    const intersection = hudHitFromPointer(event);
    if (intersection && pointerHud.action === 'progress') {
      dragState.seekTime = hudSeekTime(intersection);
      pointerHud.moved = true;
      drawHud();
    } else if (intersection && pointerHud.action === 'zoom') {
      setZoom(hudZoomValue(intersection));
      pointerHud.moved = true;
    }
    return true;
  }

  function endHudPointer(event) {
    if (!pointerHud || pointerHud.pointerId !== event.pointerId) return false;
    const { action } = pointerHud;
    if (action === 'progress') seekAbsolute(dragState.seekTime);
    else if (action === 'zoom-in') setZoom(zoom * 1.12);
    else if (action === 'zoom-out') setZoom(zoom / 1.12);
    else if (action === 'hide') hideHud();
    pointerHud = null;
    dragState.type = '';
    dragState.seekTime = 0;
    if (hudVisible) drawHud();
    return true;
  }

  function bindPointerLook() {
    const canvas = renderer?.domElement;
    if (!canvas) return;
    const onPointerDown = (event) => {
      if (beginHudPointer(event)) {
        canvas.setPointerCapture?.(event.pointerId);
        canvas.style.cursor = 'ew-resize';
        event.preventDefault();
        return;
      }
      const isMouse = event.pointerType === 'mouse';
      const isTouch = event.pointerType === 'touch';
      if ((!isMouse && !isTouch) || (isMouse && event.button !== 0) || pointerDrag || !videoRoot) return;
      pointerDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startYaw: videoRoot.rotation.y,
        startPitch: videoRoot.rotation.x
      };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.style.cursor = 'grabbing';
      event.preventDefault();
    };
    const onPointerMove = (event) => {
      if (moveHudPointer(event)) { event.preventDefault(); return; }
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId || !videoRoot) return;
      const dx = event.clientX - pointerDrag.startX;
      const dy = event.clientY - pointerDrag.startY;
      videoRoot.rotation.y = pointerDrag.startYaw - dx * 0.005;
      videoRoot.rotation.x = THREE.MathUtils.clamp(
        pointerDrag.startPitch + dy * 0.005,
        -Math.PI / 2,
        Math.PI / 2
      );
      event.preventDefault();
    };
    const endPointerDrag = (event) => {
      if (endHudPointer(event)) {
        canvas.releasePointerCapture?.(event.pointerId);
        canvas.style.cursor = 'grab';
        event.preventDefault();
        return;
      }
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      canvas.releasePointerCapture?.(event.pointerId);
      pointerDrag = null;
      canvas.style.cursor = 'grab';
    };
    // 触摸由 Pointer Events 覆盖：pointerdown 先于 touchstart 触发并占住 pointerDrag，
    // 旧的 touch 监听器永远走不到，已删除。
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endPointerDrag);
    canvas.addEventListener('pointercancel', endPointerDrag);
    pointerHandlers = { canvas, onPointerDown, onPointerMove, endPointerDrag };
  }

  function unbindPointerLook() {
    if (!pointerHandlers) return;
    const { canvas, onPointerDown, onPointerMove, endPointerDrag } = pointerHandlers;
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', endPointerDrag);
    canvas.removeEventListener('pointercancel', endPointerDrag);
    pointerHandlers = null;
    pointerDrag = null;
    pointerHud = null;
  }

  function makeGeometry(projection, eye) {
    let geometry;
    if (projection === '360') {
      geometry = new THREE.SphereGeometry(50, 64, 32, 0, Math.PI * 2, 0, Math.PI);
      geometry.scale(-1, 1, 1);
    } else if (projection === 'flat') {
      geometry = new THREE.PlaneGeometry(7.2, 4.05, 1, 1);
    } else {
      geometry = new THREE.SphereGeometry(50, 64, 32, -Math.PI / 2, Math.PI, 0, Math.PI);
      geometry.scale(-1, 1, 1);
    }
    if (currentMode.stereo !== 'mono') {
      const selectedEye = currentMode.swap ? 1 - eye : eye;
      const uv = geometry.attributes.uv;
      for (let index = 0; index < uv.count; index += 1) {
        let u = uv.getX(index);
        let v = uv.getY(index);
        if (currentMode.stereo === 'sbs') u = u * 0.5 + selectedEye * 0.5;
        else v = v * 0.5 + (selectedEye === 0 ? 0.5 : 0);
        uv.setXY(index, u, v);
      }
      uv.needsUpdate = true;
    }
    return geometry;
  }

  function makeMaterial(eye) {
    if (currentMode.projection !== 'fisheye') {
      return new THREE.MeshBasicMaterial({
        map: videoTexture,
        side: currentMode.projection === 'flat' ? THREE.DoubleSide : THREE.FrontSide,
        toneMapped: false
      });
    }
    const selectedEye = currentMode.swap ? 1 - eye : eye;
    const stereoLine = currentMode.stereo === 'sbs'
      ? `p.x=p.x*0.5+${selectedEye ? '0.5' : '0.0'};`
      : currentMode.stereo === 'ou'
        ? `p.y=p.y*0.5+${selectedEye ? '0.0' : '0.5'};`
        : '';
    return new THREE.ShaderMaterial({
      side: THREE.FrontSide,
      uniforms: { map: { value: videoTexture }, uZoom: { value: zoom } },
      vertexShader: `varying vec3 vLocal;void main(){vLocal=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      // 鱼眼用方向投影，缩放几何体不影响方向，只能用 uZoom 缩小采样范围来放大画面。
      fragmentShader: `uniform sampler2D map;uniform float uZoom;varying vec3 vLocal;void main(){vec2 p=vLocal.xy*0.5/uZoom+0.5;${stereoLine}gl_FragColor=texture2D(map,p);}`
    });
  }

  function disposeVideoMeshes() {
    videoMeshes.forEach((mesh) => {
      videoRoot?.remove(mesh);
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    });
    videoMeshes = [];
  }

  function rebuildVideoMeshes() {
    if (!world || !videoTexture) return;
    disposeVideoMeshes();
    const stereo = currentMode.stereo !== 'mono';
    const left = new THREE.Mesh(makeGeometry(currentMode.projection, 0), makeMaterial(0));
    left.name = 'jvr-left-video';
    if (currentMode.projection === 'flat') left.position.set(0, 0, -4.5);
    else if (currentMode.projection !== '360') left.rotation.y = Math.PI / 2;
    left.layers.set(stereo ? 1 : 0);
      videoRoot.add(left);
    videoMeshes.push(left);
    if (stereo) {
      const right = new THREE.Mesh(makeGeometry(currentMode.projection, 1), makeMaterial(1));
      right.name = 'jvr-right-video';
      if (currentMode.projection === 'flat') right.position.set(0, 0, -4.5);
      else if (currentMode.projection !== '360') right.rotation.y = Math.PI / 2;
      right.layers.set(2);
      videoRoot.add(right);
      videoMeshes.push(right);
    }
    applyZoom();
    updateToolbar();
    drawPanel();
  }

  function applyZoom() {
    videoMeshes.forEach((mesh) => {
      if (mesh.material.uniforms?.uZoom) mesh.material.uniforms.uZoom.value = zoom;
      // 球面/鱼眼靠缩小几何体放大画面；平面影院幕布则放大几何体。
      else mesh.scale.setScalar(currentMode.projection === 'flat' ? zoom : 1 / zoom);
    });
  }

  function setZoom(value) {
    const target = Number(value);
    zoom = THREE.MathUtils.clamp(Number.isFinite(target) ? target : 1, ZOOM_MIN, ZOOM_MAX);
    applyZoom();
    syncDock();
    drawHud();
  }

  function replaceVideoTexture(video) {
    if (!video || !world) return;
    if (videoTexture?.image === video) {
      drawPanel();
      return;
    }
    videoTexture?.dispose?.();
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.generateMipmaps = false;
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    rebuildVideoMeshes();
  }

  function configureEyeLayers() {
    if (!renderer?.xr?.isPresenting || !camera) return;
    const xrCamera = renderer.xr.getCamera(camera);
    const eyeCameras = xrCamera?.cameras || [];
    eyeCameras.forEach((eyeCamera, index) => {
      eyeCamera.layers.disableAll();
      eyeCamera.layers.enable(0);
      if (currentMode.stereo !== 'mono') eyeCamera.layers.enable(index === 0 ? 1 : 2);
    });
  }

  function setupControllers() {
    for (let index = 0; index < 2; index += 1) {
      const controller = renderer.xr.getController(index);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0028, 0.0028, 5, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthTest: false, depthWrite: false })
      );
      beam.name = 'jvr-ray';
      beam.rotation.x = -Math.PI / 2;
      beam.position.z = -2.5;
      beam.renderOrder = 9998;
      beam.visible = false;
      controller.add(beam);
      controller.addEventListener('selectstart', () => beginTrigger(controller));
      controller.addEventListener('selectend', () => endTrigger(controller));
      controller.addEventListener('squeezestart', () => {
        const oldTimer = gripTimers.get(controller);
        if (oldTimer) clearTimeout(oldTimer);
        gripTimers.set(controller, setTimeout(() => {
          gripTimers.delete(controller);
          resetAll();
        }, 1200));
      });
      // 短按切换面板，长按交由上面的复位计时器，避免长按复位时顺带翻转面板。
      controller.addEventListener('squeezeend', () => {
        const timer = gripTimers.get(controller);
        if (!timer) return;
        clearTimeout(timer);
        gripTimers.delete(controller);
        panelVisible ? hidePanel() : showPanel();
      });
      world.add(controller);
      controllers.push(controller);
    }
  }

  function raycastMesh(controller, mesh) {
    if (!mesh?.visible) return null;
    const rotation = new THREE.Matrix4().extractRotation(controller.matrixWorld);
    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotation);
    return raycaster.intersectObject(mesh, false)[0] || null;
  }

  function raycastPanel(controller) {
    return panelVisible ? raycastMesh(controller, panelMesh) : null;
  }

  function raycastHud(controller) {
    return hudVisible ? raycastMesh(controller, hudMesh) : null;
  }

  function panelActionFromIntersection(intersection) {
    if (!intersection?.uv) return '';
    const x = intersection.uv.x * panelCanvas.width;
    const y = (1 - intersection.uv.y) * panelCanvas.height;
    return panelButtons.find((button) => x >= button.x && x <= button.x + button.width && y >= button.y && y <= button.y + button.height)?.action || '';
  }

  function isTimelineArea(intersection) {
    const point = panelPoint(intersection);
    return Boolean(point
      && point.x >= TIMELINE.x - 35
      && point.x <= TIMELINE.x + TIMELINE.width + 35
      && point.y >= TIMELINE.y - 28
      && point.y <= TIMELINE.y + TIMELINE.height);
  }

  function timelineTimeFromIntersection(intersection) {
    const point = panelPoint(intersection);
    if (!point || !getDuration()) return getCurrentTime();
    const ratio = THREE.MathUtils.clamp((point.x - TIMELINE.x) / TIMELINE.width, 0, 1);
    return ratio * getDuration();
  }

  function panelPoint(intersection) {
    if (!intersection?.uv) return null;
    return {
      x: intersection.uv.x * panelCanvas.width,
      y: (1 - intersection.uv.y) * panelCanvas.height
    };
  }

  function isPanelDragArea(intersection) {
    const point = panelPoint(intersection);
    if (!point) return false;
    const edge = 62;
    return point.x < edge || point.x > panelCanvas.width - edge
      || point.y < 105 || point.y > panelCanvas.height - edge;
  }

  function controllerDirection(controller) {
    const direction = new THREE.Vector3(0, 0, -1);
    const quaternion = new THREE.Quaternion();
    controller.getWorldQuaternion(quaternion);
    return direction.applyQuaternion(quaternion).normalize();
  }

  function beginTrigger(controller) {
    if (dragState.controller) return;
    dragState.controller = controller;
    dragState.startTime = performance.now();
    dragState.startDirection = controllerDirection(controller);
    dragState.startYaw = videoRoot?.rotation.y || 0;
    dragState.startPitch = videoRoot?.rotation.x || 0;
    dragState.startPanelPosition = panelMesh?.position.clone() || null;
    dragState.seekTime = getCurrentTime();
    dragState.moved = false;

    const hudIntersection = raycastHud(controller);
    const hudAction = hudActionFromIntersection(hudIntersection);
    if (hudAction) {
      dragState.type = hudAction === 'progress' ? 'hud-seek'
        : hudAction === 'zoom' ? 'hud-zoom'
          : 'hud-click';
      if (dragState.type === 'hud-seek') dragState.seekTime = hudSeekTime(hudIntersection);
      triggerStates.set(controller, { hudAction });
      drawHud();
      return;
    }

    const intersection = raycastPanel(controller);
    const action = panelActionFromIntersection(intersection);
    dragState.type = panelVisible && intersection && isTimelineArea(intersection)
      ? 'seek'
      : panelVisible && intersection && isPanelDragArea(intersection) && !action
        ? 'panel'
        : panelVisible ? 'panel-click' : 'view';
    dragState.seekTime = dragState.type === 'seek' ? timelineTimeFromIntersection(intersection) : dragState.seekTime;
    triggerStates.set(controller, { intersection, action, hudAction });
  }

  function updateTriggerDrag() {
    const controller = dragState.controller;
    if (!controller) return;
    const elapsed = performance.now() - dragState.startTime;
    if (dragState.type === 'hud-seek') {
      const intersection = raycastHud(controller);
      if (intersection) {
        const nextTime = hudSeekTime(intersection);
        dragState.moved = dragState.moved || Math.abs(nextTime - dragState.seekTime) > Math.max(1, getDuration() * 0.002);
        dragState.seekTime = nextTime;
        drawHud();
      }
      return;
    }
    if (dragState.type === 'hud-zoom') {
      const intersection = raycastHud(controller);
      if (intersection) setZoom(hudZoomValue(intersection));
      return;
    }
    if (dragState.type === 'seek') {
      const intersection = raycastPanel(controller);
      if (intersection) {
        const nextTime = timelineTimeFromIntersection(intersection);
        dragState.moved = dragState.moved || Math.abs(nextTime - dragState.seekTime) > Math.max(1, getDuration() * 0.002);
        dragState.seekTime = nextTime;
        drawPanel();
      }
      return;
    }
    if (dragState.type === 'panel') {
      const direction = controllerDirection(controller);
      const distance = dragState.startPanelPosition?.length() || 1.35;
      const targetWorld = new THREE.Vector3().copy(direction).multiplyScalar(distance);
      const cameraWorld = new THREE.Vector3();
      camera.getWorldPosition(cameraWorld);
      targetWorld.add(cameraWorld);
      camera.worldToLocal(targetWorld);
      if (panelMesh && dragState.startPanelPosition) {
        panelMesh.position.lerp(targetWorld, 0.35);
        panelMesh.lookAt(cameraWorld);
        dragState.moved = dragState.moved || panelMesh.position.distanceToSquared(dragState.startPanelPosition) > 0.0004;
      }
      return;
    }
    if (dragState.type !== 'view' || elapsed < 280 || !videoRoot) return;
    const current = controllerDirection(controller);
    const start = dragState.startDirection;
    const startYaw = Math.atan2(start.x, -start.z);
    const currentYaw = Math.atan2(current.x, -current.z);
    const startPitch = Math.asin(THREE.MathUtils.clamp(start.y, -1, 1));
    const currentPitch = Math.asin(THREE.MathUtils.clamp(current.y, -1, 1));
    videoRoot.rotation.y = dragState.startYaw - (currentYaw - startYaw) * 1.35;
    videoRoot.rotation.x = THREE.MathUtils.clamp(dragState.startPitch + (currentPitch - startPitch) * 1.1, -Math.PI / 2, Math.PI / 2);
    dragState.moved = dragState.moved || Math.abs(currentYaw - startYaw) > 0.025 || Math.abs(currentPitch - startPitch) > 0.025;
  }

  function endTrigger(controller) {
    if (dragState.controller !== controller) return;
    const elapsed = performance.now() - dragState.startTime;
    const stored = triggerStates.get(controller) || {};
    if (dragState.type === 'hud-seek') {
      seekAbsolute(dragState.seekTime);
      drawHud();
    } else if (dragState.type === 'hud-zoom') {
      drawHud();
    } else if (dragState.type === 'hud-click') {
      if (!dragState.moved && elapsed < 650) {
        if (stored.hudAction === 'hide') hideHud();
        else setZoom(zoom * (stored.hudAction === 'zoom-in' ? 1.12 : 1 / 1.12));
      }
    } else if (dragState.type === 'seek') {
      seekAbsolute(dragState.seekTime);
      drawPanel();
    } else if (dragState.type === 'panel-click' && !dragState.moved) {
      const currentIntersection = raycastPanel(controller);
      const currentAction = panelActionFromIntersection(currentIntersection);
      if (stored.action && currentAction === stored.action) runAction(currentAction);
      else if (!stored.action && elapsed < 650) hidePanel();
    } else if (dragState.type === 'panel' && !dragState.moved && elapsed < 650) {
      hidePanel();
    } else if (dragState.type === 'view' && elapsed < 280 && !dragState.moved) {
      showPanel();
    }
    triggerStates.delete(controller);
    dragState.controller = null;
    dragState.type = '';
    dragState.startDirection = null;
    dragState.startPanelPosition = null;
    dragState.seekTime = 0;
    dragState.moved = false;
  }

  function updateControllerHover() {
    updateHudHover();
    if (!panelVisible) {
      if (panelCursor) panelCursor.visible = false;
      return;
    }
    let nextHover = '';
    let cursorIntersection = null;
    for (const controller of controllers) {
      const intersection = raycastPanel(controller);
      const ray = controller.getObjectByName('jvr-ray');
      if (ray) {
        const distance = intersection ? Math.max(0.03, intersection.distance) : 5;
        ray.scale.y = distance / 5;
        ray.position.z = -distance / 2;
      }
      if (intersection && !cursorIntersection) cursorIntersection = intersection;
      nextHover = panelActionFromIntersection(intersection);
      if (nextHover) { cursorIntersection = intersection; break; }
    }
    if (panelCursor) {
      panelCursor.visible = Boolean(cursorIntersection?.uv);
      if (cursorIntersection?.uv) {
        panelCursor.position.x = (cursorIntersection.uv.x - 0.5) * PANEL_WIDTH;
        panelCursor.position.y = (cursorIntersection.uv.y - 0.5) * PANEL_HEIGHT;
      }
    }
    if (nextHover !== hoverAction) {
      hoverAction = nextHover;
      drawPanel();
    }
  }

  function pollGamepads() {
    if (!xrSession) return;
    for (const inputSource of xrSession.inputSources) {
      const gamepad = inputSource.gamepad;
      if (!gamepad) continue;
      const previous = inputStates.get(inputSource) || [];
      const pressed = gamepad.buttons.map((button) => button.pressed);
      if (pressed[4] && !previous[4]) runAction('play');
      if (pressed[5] && !previous[5]) panelVisible ? hidePanel() : showPanel();
      const x = Math.abs(gamepad.axes[2] || 0) > Math.abs(gamepad.axes[0] || 0) ? gamepad.axes[2] : gamepad.axes[0];
      if (Date.now() - lastStickAction > 650) {
        if (x > 0.8) { lastStickAction = Date.now(); runAction('forward'); }
        else if (x < -0.8) { lastStickAction = Date.now(); runAction('back'); }
      }
      inputStates.set(inputSource, pressed);
    }
  }

  function showPanel() {
    panelVisible = true;
    if (panelMesh) panelMesh.visible = true;
    controllers.forEach((controller) => {
      const ray = controller.getObjectByName('jvr-ray');
      if (ray) ray.visible = true;
    });
    hideHud();
    drawPanel();
  }

  function hidePanel() {
    panelVisible = false;
    hoverAction = '';
    if (panelMesh) panelMesh.visible = false;
    if (panelCursor) panelCursor.visible = false;
    controllers.forEach((controller) => {
      const ray = controller.getObjectByName('jvr-ray');
      if (ray) { ray.visible = false; ray.scale.y = 1; ray.position.z = -2.5; }
    });
    showHud();
  }

  function resetAll() {
    if (videoRoot) videoRoot.rotation.set(0, 0, 0);
    setZoom(1);
    if (panelMesh) {
      panelMesh.position.set(PANEL_HOME.x, PANEL_HOME.y, PANEL_HOME.z);
      panelMesh.quaternion.identity();
      panelMesh.scale.set(1, 1, 1);
    }
    showPanel();
    if (statusEl) statusEl.textContent = '控制面板和视频视角已复位。';
    drawPanel();
  }

  function renderFrame(time) {
    if (!renderer || !world || !camera) return;
    // 头盔里只有 3D 面片能看见，普通屏幕上用 DOM 控制条，避免两套控件叠在一起。
    if (hudMesh) hudMesh.visible = hudVisible && renderer.xr.isPresenting;
    configureEyeLayers();
    pollGamepads();
    updateTriggerDrag();
    updateControllerHover();
    if (time - lastPanelDraw > 250) {
      lastPanelDraw = time;
      if (panelVisible) drawPanel();
      if (hudVisible) {
        syncDock();
        if (hudMesh?.visible) drawHud();
      }
    }
    renderer.render(world, camera);
  }

  function bindMediaEvents(video, enabled) {
    if (!video) return;
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    video[method]('timeupdate', handleMediaTick);
    video[method]('play', handleMediaReady);
    video[method]('pause', handleMediaTick);
    video[method]('loadedmetadata', handleMediaReady);
    video[method]('canplay', handleMediaReady);
    video[method]('error', handleMediaError);
  }

  function handleMediaTick() {
    if (hudVisible) {
      syncDock();
      if (hudMesh?.visible) drawHud();
    }
    if (panelVisible) drawPanel();
  }

  function handleMediaReady() {
    if (this !== activeVideo) return;
    replaceVideoTexture(activeVideo);
    const label = sourceMode === 'compat' ? 'H.264/8-bit 兼容源' : '原始源';
    statusEl.textContent = `${label}已连接 · ${activeVideo.videoWidth || '?'}×${activeVideo.videoHeight || '?'} · 可进入 VR`;
    drawPanel();
  }

  function handleMediaError() {
    if (this !== activeVideo) return;
    const code = activeVideo.error?.code;
    statusEl.textContent = `视频源播放失败${code ? `（MediaError ${code}）` : ''}，请检查 Jellyfin 转码日志。`;
  }

  async function startCompatAt(position, shouldPlay = true) {
    if (!compatUrl) throw new Error('当前地址无法生成 Jellyfin H264 兼容源');
    const serial = ++loadSerial;
    const duration = getDuration();
    const target = Math.max(0, Math.min(Number(position) || 0, duration ? duration - 0.25 : Infinity));
    const url = new URL(compatUrl);
    setQueryParam(url, 'StartTimeTicks', Math.round(target * 10000000));
    const muted = activeVideo?.muted ?? sourceVideo.muted;
    const volume = activeVideo?.volume ?? sourceVideo.volume;
    bindMediaEvents(activeVideo, false);
    activeVideo?.pause?.();
    if (compatVideo) {
      compatVideo.removeAttribute('src');
      compatVideo.load();
      compatVideo.remove();
    }
    compatVideo = document.createElement('video');
    compatVideo.id = 'jvr-compat-video';
    compatVideo.preload = 'auto';
    compatVideo.playsInline = true;
    compatVideo.setAttribute('playsinline', '');
    compatVideo.setAttribute('webkit-playsinline', '');
    compatVideo.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
    compatVideo.muted = muted;
    compatVideo.volume = volume;
    compatOffset = target;
    sourceMode = 'compat';
    activeVideo = compatVideo;
    bindMediaEvents(activeVideo, true);
    overlay.appendChild(compatVideo);
    replaceVideoTexture(activeVideo);
    updateToolbar();
    statusEl.textContent = `正在从 ${formatTime(target)} 启动 H.264/8-bit 转码…`;
    compatVideo.src = url.href;
    compatVideo.load();
    if (shouldPlay) {
      try {
        await compatVideo.play();
      } catch (_) {
        if (serial === loadSerial) statusEl.textContent = '兼容源已建立；请按 PLAY 开始播放。';
      }
    }
  }

  async function useOriginalSource() {
    const position = getCurrentTime();
    const shouldPlay = !activeVideo?.paused;
    const muted = activeVideo?.muted ?? false;
    const volume = activeVideo?.volume ?? 1;
    ++loadSerial;
    bindMediaEvents(activeVideo, false);
    activeVideo?.pause?.();
    sourceMode = 'original';
    sourceVideo.currentTime = Math.max(0, Math.min(position, sourceVideo.duration || position));
    sourceVideo.muted = muted;
    sourceVideo.volume = volume;
    activeVideo = sourceVideo;
    bindMediaEvents(activeVideo, true);
    replaceVideoTexture(activeVideo);
    updateToolbar();
    statusEl.textContent = '已切回原始源。';
    if (shouldPlay) await sourceVideo.play().catch(() => {});
  }

  function toggleSource() {
    if (!compatUrl) return;
    const position = getCurrentTime();
    const shouldPlay = !activeVideo?.paused;
    if (sourceMode === 'compat') useOriginalSource();
    else startCompatAt(position, shouldPlay).catch((error) => {
      statusEl.textContent = `兼容源启动失败：${error?.message || error}`;
    });
  }

  function seekAbsolute(position) {
    const target = Math.max(0, Math.min(Number(position) || 0, getDuration() || Infinity));
    if (sourceMode !== 'compat') {
      activeVideo.currentTime = target;
      return;
    }
    const relative = target - compatOffset;
    if (relative >= 0 && Number.isFinite(activeVideo.duration) && relative <= activeVideo.duration) {
      activeVideo.currentTime = relative;
    } else {
      startCompatAt(target, !activeVideo.paused).catch((error) => {
        statusEl.textContent = `兼容源跳转失败：${error?.message || error}`;
      });
    }
  }

  function cycleProjection() {
    const values = ['360', '180', 'fisheye', 'flat'];
    currentMode.projection = values[(values.indexOf(currentMode.projection) + 1) % values.length];
    rebuildVideoMeshes();
  }

  function cycleStereo() {
    const values = ['mono', 'sbs', 'ou'];
    currentMode.stereo = values[(values.indexOf(currentMode.stereo) + 1) % values.length];
    rebuildVideoMeshes();
  }

  function runAction(action) {
    if (action === 'exit-vr') {
      exitVrOnly(true);
      return;
    }
    if (!activeVideo) return;
    if (action === 'play') activeVideo.paused ? activeVideo.play().catch(() => {}) : activeVideo.pause();
    else if (action === 'back') seekAbsolute(getCurrentTime() - 10);
    else if (action === 'forward') seekAbsolute(getCurrentTime() + 10);
    else if (action === 'mute') activeVideo.muted = !activeVideo.muted;
    else if (action === 'projection') cycleProjection();
    else if (action === 'stereo') cycleStereo();
    else if (action === 'swap') { currentMode.swap = !currentMode.swap; rebuildVideoMeshes(); }
    else if (action === 'source') toggleSource();
    else if (action === 'reset') resetAll();
    else if (action === 'hide') hidePanel();
    if (panelVisible) drawPanel();
  }

  function updateToolbar() {
    if (!overlay) return;
    overlay.querySelectorAll('[data-action="projection"][data-value]').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === currentMode.projection);
    });
    overlay.querySelectorAll('[data-action="stereo"][data-value]').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === currentMode.stereo);
    });
    const sourceButton = overlay.querySelector('#jvr-source-toggle');
    if (sourceButton) {
      sourceButton.textContent = sourceMode === 'compat' ? 'H264 兼容源 ✓' : '原始源';
      sourceButton.classList.toggle('active', sourceMode === 'compat');
      sourceButton.disabled = !compatUrl;
    }
  }

  async function enterVr() {
    if (!window.isSecureContext) return alert('WebXR 需要 HTTPS。');
    if (!navigator.xr) return alert('当前浏览器没有 WebXR。');
    if (!renderer) return alert('WebXR 渲染器尚未初始化。');
    try {
      // requestSession must run directly in the Enter VR click's user-activation task.
      const sessionPromise = navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
      });
      activeVideo?.play?.().catch(() => {});
      xrSession = await sessionPromise;
      xrSession.addEventListener('end', () => {
        xrSession = null;
        hidePanel();
        if (!closing && statusEl) statusEl.textContent = '已退出 VR，可再次进入或返回 Jellyfin。';
      }, { once: true });
      await renderer.xr.setSession(xrSession);
      statusEl.textContent = '已进入原生 WebXR。按扳机打开控制面板。';
      showHud();
    } catch (error) {
      alert(`进入 VR 失败：${error?.message || error}`);
    }
  }

  async function exitVrOnly(closeAfter = false) {
    try {
      const session = xrSession || renderer?.xr?.getSession?.();
      if (session) await session.end();
    } catch (_) {}
    if (closeAfter) closePlayer();
  }

  function handleToolbar(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, value } = button.dataset;
    if (action === 'exit') closePlayer();
    else if (action === 'enter') enterVr();
    else if (action === 'projection') { currentMode.projection = value; rebuildVideoMeshes(); }
    else if (action === 'stereo') { currentMode.stereo = value; rebuildVideoMeshes(); }
    else if (action === 'swap') { currentMode.swap = !currentMode.swap; rebuildVideoMeshes(); }
    else if (action === 'source') toggleSource();
    else if (action === 'hud') { hudVisible ? hideHud() : showHud(); }
  }

  async function openPlayer() {
    if (overlay) return;
    sourceVideo = findVideo();
    if (!sourceVideo) return alert('请先在 Jellyfin 中开始播放视频。');
    try {
      activeVideo = sourceVideo;
      compatUrl = buildCompatStreamUrl(sourceVideo);
      originalState = {
        currentTime: sourceVideo.currentTime || 0,
        duration: sourceVideo.duration || 0,
        paused: sourceVideo.paused,
        muted: sourceVideo.muted,
        volume: sourceVideo.volume
      };
      await ensureThree();
      buildOverlay();
      buildRenderer();
      bindMediaEvents(sourceVideo, true);
      replaceVideoTexture(sourceVideo);
      updateToolbar();
      statusEl.textContent = `原生 WebXR 已就绪 · 原始源 ${sourceVideo.videoWidth || '?'}×${sourceVideo.videoHeight || '?'}`;
      if (!originalState.paused) sourceVideo.play().catch(() => {});
    } catch (error) {
      closePlayer();
      alert(`VR 播放器初始化失败：${error?.message || error}`);
    }
  }

  function closePlayer() {
    if (closing) return;
    closing = true;
    const finalTime = getCurrentTime();
    const finalPaused = activeVideo?.paused ?? originalState?.paused ?? true;
    const finalMuted = activeVideo?.muted;
    const finalVolume = activeVideo?.volume;
    const session = xrSession || renderer?.xr?.getSession?.();
    session?.end?.().catch?.(() => {});
    xrSession = null;
    ++loadSerial;
    bindMediaEvents(activeVideo, false);
    if (compatVideo) {
      compatVideo.pause();
      compatVideo.removeAttribute('src');
      compatVideo.load();
      compatVideo.remove();
      compatVideo = null;
    }
    if (sourceVideo) {
      bindMediaEvents(sourceVideo, false);
      if (Number.isFinite(finalTime)) sourceVideo.currentTime = Math.min(finalTime, sourceVideo.duration || finalTime);
      if (typeof finalMuted === 'boolean') sourceVideo.muted = finalMuted;
      if (Number.isFinite(finalVolume)) sourceVideo.volume = finalVolume;
      if (finalPaused) sourceVideo.pause();
      else sourceVideo.play().catch(() => {});
    }
    renderer?.setAnimationLoop?.(null);
    disposeVideoMeshes();
    videoTexture?.dispose?.();
    panelMesh?.geometry?.dispose?.();
    panelMesh?.material?.dispose?.();
    panelBorder?.geometry?.dispose?.();
    panelBorder?.material?.dispose?.();
    panelCursor?.traverse?.((object) => {
      if (object !== panelCursor) object.geometry?.dispose?.();
      if (object !== panelCursor) object.material?.dispose?.();
    });
    panelCursor?.geometry?.dispose?.();
    panelCursor?.material?.dispose?.();
    panelTexture?.dispose?.();
    hudMesh?.geometry?.dispose?.();
    hudMesh?.material?.dispose?.();
    hudTexture?.dispose?.();
    controllers.forEach((controller) => {
      const gripTimer = gripTimers.get(controller);
      if (gripTimer) clearTimeout(gripTimer);
      gripTimers.delete(controller);
      controller.children.forEach((child) => {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
    });
    // dispose() 不释放 WebGL 上下文，反复进出会把浏览器的上下文配额耗尽。
    renderer?.forceContextLoss?.();
    renderer?.dispose?.();
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    unbindPointerLook();
    overlay?.remove();
    overlay = null;
    statusEl = null;
    sourceVideo = null;
    activeVideo = null;
    originalState = null;
    compatUrl = '';
    compatOffset = 0;
    sourceMode = 'original';
    world = null;
    camera = null;
    renderer = null;
    videoTexture = null;
    videoMeshes = [];
    videoRoot = null;
    controllers = [];
    panelMesh = null;
    panelCanvas = null;
    panelContext = null;
    panelTexture = null;
    panelBorder = null;
    panelCursor = null;
    hudMesh = null;
    hudCanvas = null;
    hudContext = null;
    hudTexture = null;
    hudVisible = false;
    hudHover = '';
    hudDockEl = null;
    hudSeekEl = null;
    hudSeekTimeEl = null;
    hudZoomEl = null;
    hudZoomValueEl = null;
    hudSeeking = false;
    zoom = 1;
    panelButtons = [];
    panelVisible = false;
    hoverAction = '';
    resizeHandler = null;
    dragState.controller = null;
    dragState.type = '';
    dragState.startDirection = null;
    dragState.startPanelPosition = null;
    dragState.seekTime = 0;
    dragState.moved = false;
    closing = false;
  }

  function locateControls() {
    const fullscreen = document.querySelector('.btnFullscreen,[aria-label="Fullscreen"],[aria-label="全屏"],[title="Fullscreen"],[title="全屏"],.button-fullscreen');
    if (fullscreen?.parentElement) return { parent: fullscreen.parentElement, before: fullscreen };
    for (const selector of ['.videoOsdBottom .buttons', '.osdControls', '.videoControls', '.videoOsdBottom', '[class*="videoOsdBottom"]']) {
      const bar = document.querySelector(selector);
      if (bar) return { parent: bar, before: null };
    }
    return null;
  }

  function addVrButton() {
    const target = locateControls();
    let button = document.getElementById(BUTTON_ID);
    // 菜单栏可能比视频晚加载，等待后续扫描，不创建独立悬浮入口。
    if (!target) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.textContent = 'VR';
      button.title = 'Jellyfin VR Player v4.3';
      button.setAttribute('aria-label', 'VR Player');
      button.onclick = openPlayer;
      button.className = 'autoSize paper-icon-button-light';
      button.style.cssText = 'min-width:42px;height:42px;border:0;background:transparent;color:inherit;font-weight:800;font-size:13px;cursor:pointer';
    }
    // 菜单栏重建或全屏按钮稍后出现时重新定位；位置正确时不改 DOM，避免观察器循环。
    if (button.parentElement !== target.parent || (target.before && button.nextElementSibling !== target.before)) {
      target.parent.insertBefore(button, target.before);
    }
  }

  function scan() {
    const button = document.getElementById(BUTTON_ID);
    if (findVideo()) addVrButton();
    else button?.remove();
  }

  function init() {
    scan();
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scanTimer = setInterval(scan, 1000);
    window.addEventListener('beforeunload', () => clearInterval(scanTimer), { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
