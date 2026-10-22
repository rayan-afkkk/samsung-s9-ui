// OneShell UI. One page, four views picked with ?view=:
//   desktop  - wallpaper, status bar and home screen widgets (sits behind all apps)
//   dock     - floating dock on the home screen / full-width taskbar while an app is open
//   overlay  - lock screen, quick panel, app drawer and recent apps
//   settings - the OneShell settings window
// Markup and sizes follow mockups/mockup.html; everything is laid out on the 1600x1000
// design canvas and the main process zooms the page to fit the real display.
(() => {
  'use strict';

  const api = window.oneshell;
  const params = new URLSearchParams(location.search);
  const VIEW = params.get('view') || 'desktop';
  const root = document.getElementById('app');

  let cfg = {};
  let st = {};
  let apps = [];

  // ---------------------------------------------------------------- tiny helpers
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (id, style = '', cls = 'i') => `<svg class="${cls}"${style ? ` style="${style}"` : ''}><use href="#${id}"/></svg>`;
  const css = (url) => `url("${String(url).replace(/"/g, '%22')}")`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function clock(pad) {
    const d = new Date();
    const h = d.getHours() % 12 || 12;
    return `${pad ? String(h).padStart(2, '0') : h}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function date(long) {
    return new Date().toLocaleDateString('en-US', { weekday: 'short', month: long ? 'long' : 'short', day: 'numeric' });
  }

  function tick() {
    $$('[data-clock]').forEach((el) => (el.textContent = clock(el.dataset.clock === 'pad')));
    $$('[data-date]').forEach((el) => (el.textContent = date(el.dataset.date === 'long')));
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => (t.style.opacity = '0'), 1800);
    setTimeout(() => t.remove(), 2200);
  }

  let menuEl = null;
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }

  // items: [[label, iconId, fn], ...]
  function menu(x, y, items) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.innerHTML = items.map(([label, icon], i) => `<div data-i="${i}">${icon ? ic(icon) : ''}${esc(label)}</div>`).join('');
    document.body.appendChild(menuEl);
    const w = menuEl.offsetWidth;
    const h = menuEl.offsetHeight;
    menuEl.style.left = clamp(x, 8, innerWidth - w - 8) + 'px';
    menuEl.style.top = clamp(y, 8, innerHeight - h - 8) + 'px';
    menuEl.addEventListener('mousedown', (e) => e.stopPropagation());
    menuEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]');
      if (!row) return;
      const fn = items[Number(row.dataset.i)][2];
      closeMenu();
      fn();
    });
  }
  document.addEventListener('mousedown', closeMenu);

  // ---------------------------------------------------------------- shared pieces
  const COLORS = ['c-red', 'c-org', 'c-blu', 'c-grn', 'c-pur', 'c-tea', 'c-pnk', 'c-dk'];
  const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  function appIcon(a, size = '', attrs = '', tip = false) {
    const t = tip ? `<span class="tip">${esc(a.name)}</span>` : '';
    if (a.icon) return `<div class="app img ${size}" ${attrs}><img src="${a.icon}" alt="">${t}</div>`;
    const color = COLORS[hash(a.name) % COLORS.length];
    return `<div class="app letter ${color} ${size}" ${attrs}>${esc((a.name || '?').trim()[0] || '?').toUpperCase()}${t}</div>`;
  }

  // Built-in wallpapers (pure CSS, see .wp-* in ui.css). 'blue' is the One UI default.
  const WALLPAPERS = [
    ['blue', 'One UI blue'], ['sky', 'Sky'], ['ocean', 'Ocean'], ['lavender', 'Lavender'],
    ['peach', 'Peach'], ['mint', 'Mint'], ['sunset', 'Sunset'], ['night', 'Night'],
  ];

  function wallClass(dim) {
    const preset = !cfg.wallpaperUrl && cfg.wallpaperPreset && cfg.wallpaperPreset !== 'blue' ? ` wp-${cfg.wallpaperPreset}` : '';
    return `wall${cfg.wallpaperUrl ? ' custom' : ''}${preset}${dim ? ' dim' : ''}`;
  }

  function wall(dim) {
    return `<div class="${wallClass(dim)}"></div>`;
  }

  // Default art for the six photo widgets (same as the mockup) until the user picks photos.
  const PHOTO_ART = ['quote', '', 'ocean', 'swan', 'tiles', 'cd'];
  const PHOTO_INNER = ['do<br>what<br>you<br>love', '', '', '', '', ''];
  const DOTS_ART = 'background:radial-gradient(circle at 30% 30%,#a9c5ec 0 18px,transparent 19px),radial-gradient(circle at 65% 55%,#a9c5ec 0 22px,transparent 23px),radial-gradient(circle at 40% 80%,#c0d5f1 0 16px,transparent 17px),#f2f6fc;';

  function photo(i, style) {
    const url = (cfg.photoUrls || [])[i];
    if (url) return `<div class="photo user" data-photo="${i}" style="${style}--img:${css(url)}"></div>`;
    const art = i === 1 ? DOTS_ART : '';
    return `<div class="photo ${PHOTO_ART[i]}" data-photo="${i}" style="${style}${art}">${PHOTO_INNER[i]}</div>`;
  }

  function statusRight() {
    const parts = [];
    if (st.volume && st.volume.mute) parts.push(ic('mute'));
    if (!st.wifi || st.wifi.connected) parts.push(ic('wifi'));
    if (st.battery && st.battery.hasBattery) parts.push(`<span class="batt">${st.battery.percent}</span>`);
    return parts.join('');
  }

  function statusBar(leftHtml) {
    return `<div class="status"><div class="l">${leftHtml}</div><div class="r" data-status-right>${statusRight()}</div></div>`;
  }

  function updateStatus() {
    $$('[data-status-right]').forEach((el) => (el.innerHTML = statusRight()));
  }

  function weatherText(w) {
    if (!w) return 'Weather unavailable';
    return `Tomorrow's high feels like ${w.tomorrowFeels}°${w.units}${w.humid ? '<br>due to humidity' : ''}`;
  }

  function fmtDuration(ms) {
    const m = Math.round((ms || 0) / 60000);
    return `${Math.floor(m / 60)}<small style="font-size:12px">h</small> ${m % 60}<small style="font-size:12px">m</small>`;
  }

  async function optimize() {
    toast('Optimizing…');
    const r = await api.optimize();
    toast(r ? `Freed ${r.freedMB} MB of memory` : 'Your PC is already optimized');
  }

  async function pickWallpaper() {
    const file = await api.pickImage();
    if (file) api.setConfig({ wallpaper: file });
  }

  async function changePhoto(i) {
    const file = await api.pickImage();
    if (!file) return;
    const photos = (cfg.photos || []).slice();
    photos[i] = file;
    api.setConfig({ photos });
  }

  function removePhoto(i) {
    const photos = (cfg.photos || []).slice();
    photos[i] = null;
    api.setConfig({ photos });
  }

  function applyTheme() {
    const html = document.documentElement;
    html.classList.toggle('dark', !!cfg.darkMode);
    html.classList.toggle('anim', cfg.animations !== false);
    html.style.setProperty('--accent', cfg.accent || '#3e7bfa');
    if (cfg.wallpaperUrl) html.style.setProperty('--wall-img', css(cfg.wallpaperUrl));
    else html.style.removeProperty('--wall-img');
    if (api.setZoom && cfg.scale) api.setZoom(cfg.scale);
  }

  // =================================================================== DESKTOP
  const desktop = {
    render() {
      document.body.className = 'v-desktop';
      root.innerHTML = `
        ${wall(false)}
        ${statusBar(`<span data-clock></span>&nbsp;&nbsp; <span data-date></span> &nbsp;${ic('chat')}<span class="dot"></span>`)}
        <div class="stage">
          <div class="w" style="left:200px;top:150px;width:560px;height:250px;background:transparent;box-shadow:none;backdrop-filter:none">
            <div id="wx-temp" style="position:absolute;left:20px;top:10px;font-size:40px;font-weight:500">--°</div>
            <div id="wx-place" style="position:absolute;left:22px;top:62px;font-size:13px;color:var(--ink2)"></div>
            <div id="wx-text" style="position:absolute;left:20px;top:130px;font-size:14px;color:var(--ink2);line-height:1.4"></div>
            <svg id="wx-icon" style="position:absolute;right:30px;top:20px;width:66px;height:66px;color:#9fbde3;fill:#c5d8f0;stroke:#9fbde3;stroke-width:1.5"><use href="#moon"/></svg>
            <div data-date="long" style="position:absolute;right:20px;top:118px;font-size:14px;font-weight:600;text-align:right"></div>
            <div data-clock style="position:absolute;right:16px;top:138px;font-size:54px;font-weight:600"></div>
          </div>
          <div class="pillsearch click${cfg.showSearch === false ? ' hidden' : ''}" id="search" style="position:absolute;left:210px;top:420px;width:540px;background:rgba(200,220,245,.6)">
            ${ic('search', 'width:22px;height:22px;color:var(--accent)')}<span>Search apps, files, settings &amp; web</span>
            <span style="margin-left:auto;display:flex;gap:18px">${ic('spark')}${ic('cam')}</span>
          </div>
          <div class="w" style="left:210px;top:510px;width:180px;height:170px;background:rgba(255,255,255,.75);padding:18px">
            <div id="st-apps" style="font-size:12px;color:var(--ink2);line-height:1.8"></div>
            <div id="st-total" style="position:absolute;left:18px;top:98px;font-size:26px;font-weight:600"></div>
            <div id="st-bar" style="position:absolute;left:18px;right:18px;bottom:18px;height:22px;border-radius:11px;background:#dfe6f1"></div>
          </div>
          <div class="w" style="left:410px;top:510px;width:340px;height:170px;background:rgba(255,255,255,.75);padding:18px 22px">
            <div style="font-size:13px;color:var(--ink2);font-weight:600">Device care</div>
            <div style="display:flex;gap:26px;margin-top:16px">
              <div><div id="dc-cpu" style="font-size:26px;font-weight:600">--%</div><small style="color:var(--ink2)">CPU</small></div>
              <div><div id="dc-ram" style="font-size:26px;font-weight:600">--</div><small style="color:var(--ink2)">RAM</small></div>
              <div><div id="dc-disk" style="font-size:26px;font-weight:600">--</div><small style="color:var(--ink2)">Free</small></div>
            </div>
            <div id="optimize" class="click" style="position:absolute;right:20px;bottom:18px;padding:8px 16px;border-radius:16px;background:var(--accent);color:#fff;font-size:13px;font-weight:600">Optimize now</div>
          </div>
          ${photo(0, 'left:880px;top:150px;width:160px;height:160px;')}
          ${photo(1, 'left:1080px;top:150px;width:160px;height:160px;')}
          ${photo(2, 'left:880px;top:330px;width:360px;height:160px;')}
          ${photo(3, 'left:880px;top:510px;width:160px;height:70px;border-radius:35px;')}
          ${photo(4, 'left:880px;top:600px;width:160px;height:70px;border-radius:24px;')}
          ${photo(5, 'left:1080px;top:510px;width:160px;height:160px;')}
          <div style="position:absolute;left:0;right:0;top:770px;display:flex;justify-content:center;gap:8px"><span class="dot"></span><span class="dot" style="background:var(--ink);width:7px;height:7px;margin-top:-1px"></span><span class="dot"></span></div>
        </div>`;
      $('#search').onclick = () => api.showOverlay('drawer', { search: true });
      $('#optimize').onclick = optimize;
      $$('[data-photo]').forEach((el) => {
        const i = Number(el.dataset.photo);
        el.ondblclick = () => changePhoto(i);
        el.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const items = [['Change photo', 'photo', () => changePhoto(i)]];
          if ((cfg.photos || [])[i]) items.push(['Remove photo', 'x', () => removePhoto(i)]);
          menu(e.clientX, e.clientY, items);
        };
      });
      root.oncontextmenu = (e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [
          ['Change wallpaper', 'photo', () => api.openSettings('style')],
          ['Choose wallpaper from PC', 'folder', pickWallpaper],
          ['Home screen settings', 'home', () => api.openSettings('home')],
          ['OneShell settings', 'gear', () => api.openSettings()],
        ]);
      };
      tick();
      this.update();
    },
    update() {
      updateStatus();
      const w = st.weather;
      $('#wx-temp').textContent = w ? `${w.temp}°` : '--°';
      $('#wx-place').innerHTML = w && w.place ? `${ic('pin', 'width:12px;height:12px;vertical-align:-1px')} ${esc(w.place)}` : '';
      $('#wx-text').innerHTML = weatherText(w);
      $('#wx-icon use').setAttribute('href', `#${(w && w.icon) || 'moon'}`);

      const t = st.screenTime || { totalMs: 0, top: [] };
      const [a, b] = t.top;
      $('#st-apps').innerHTML = a
        ? `<span style="color:#3e7bfa">●</span> ${esc(a.name)}${b ? `<br><span style="color:#58c48a">●</span> ${esc(b.name)}` : ''}`
        : 'Screen time';
      $('#st-total').innerHTML = fmtDuration(t.totalMs);
      const pa = a ? Math.round((100 * a.ms) / ((a.ms + (b ? b.ms : 0)) || 1)) : 0;
      $('#st-bar').style.background = a ? `linear-gradient(90deg,#3e7bfa ${pa}%,#58c48a ${pa}%)` : '#dfe6f1';

      const s = st.stats;
      if (s) {
        $('#dc-cpu').textContent = `${s.cpu}%`;
        $('#dc-ram').innerHTML = `${s.ramUsedGB.toFixed(1)}<small style="font-size:13px">GB</small>`;
        $('#dc-disk').innerHTML = s.diskFreeGB == null ? '--' : `${Math.round(s.diskFreeGB)}<small style="font-size:13px">GB</small>`;
      }
    },
  };

  // =================================================================== DOCK
  const dock = {
    model: { pinned: [], recent: [], mode: 'home' },
    inside: false,
    item(it, small) {
      const attrs = `data-kind="${it.kind}" data-id="${esc(it.id || '')}" data-hwnd="${it.hwnd || ''}"`;
      const icon = appIcon(it, small ? 'sm' : '', attrs, true);
      if (!small) return icon;
      return `<div style="text-align:center">${icon}<div class="run-dot${it.running ? '' : ' off'}"></div></div>`;
    },
    navs(cls) {
      return `<div class="${cls}">
        <span class="navbtn" data-nav="recents">${ic('recent')}</span>
        <span class="navbtn" data-nav="home">${ic('home')}</span>
        <span class="navbtn" data-nav="back">${ic('back')}</span></div>`;
    },
    render() {
      document.body.className = 'v-dock';
      const m = this.model;
      const nav = !!cfg.navButtons;
      if (m.mode === 'taskbar') {
        root.innerHTML = `
          <div class="taskbar">
            <div class="app sm c-wht" id="drawer-btn" style="background:#fff;color:var(--ink2)"><svg style="stroke:#5d6878"><use href="#home"/></svg><span class="tip">Apps</span></div>
            <span class="sep"></span>
            ${m.pinned.map((it) => this.item(it, true)).join('')}
            ${m.recent.length ? `<span class="sep"></span><div style="font-size:12px;color:var(--ink2)">Recent</div>${m.recent.map((it) => this.item(it, true)).join('')}` : ''}
            ${nav ? this.navs('navs') : ''}
          </div>`;
        $$('.taskbar .navs svg').forEach((s) => (s.style.cssText = 'width:22px;height:22px'));
      } else {
        root.innerHTML = `
          <div class="dock-home">
            <div class="dock">
              ${m.pinned.map((it) => this.item(it, false)).join('')}
              ${m.recent.length ? `<div class="sep"></div>${m.recent.map((it) => this.item(it, false)).join('')}` : ''}
              ${!m.pinned.length && !m.recent.length ? `<div class="app c-wht" id="drawer-btn">${ic('plus', '', '')}</div>` : ''}
            </div>
            ${nav ? this.navs('nav') : ''}
          </div>`;
      }
      const drawerBtn = $('#drawer-btn');
      if (drawerBtn) drawerBtn.onclick = () => api.showOverlay('drawer');
      $$('[data-nav]').forEach((el) => (el.onclick = () => api.nav(el.dataset.nav)));
      $$('.app[data-kind]').forEach((el) => {
        el.onclick = () => {
          const { kind, id, hwnd } = el.dataset;
          if (kind === 'window') api.activate(Number(hwnd));
          else api.openFromDock(id);
        };
        el.oncontextmenu = (e) => {
          e.preventDefault();
          const { id } = el.dataset;
          if (!id) return;
          const pinned = this.model.pinned.some((p) => p.id === id);
          menu(e.clientX - 60, e.clientY - 70, [
            pinned ? ['Unpin from dock', 'x', () => api.pin(id, false)] : ['Pin to dock', 'pin', () => api.pin(id, true)],
          ]);
        };
      });
    },
    init() {
      // The dock window covers the bottom of the screen; only let it take the mouse over real UI.
      document.addEventListener('mousemove', (e) => {
        const inside = !!(e.target.closest && e.target.closest('.dock,.taskbar,.nav,.menu'));
        if (inside !== this.inside) {
          this.inside = inside;
          api.dockMouse(inside);
        }
      });
      document.addEventListener('mouseleave', () => {
        this.inside = false;
        api.dockMouse(false);
      });
      api.onDock((m) => {
        this.model = m;
        this.render();
      });
      api.getDock().then((m) => {
        this.model = m;
        this.render();
      });
    },
    update() {},
  };

  // =================================================================== OVERLAY
  const overlay = {
    mode: null,
    page: 0,
    query: '',
    render() {
      document.body.className = 'v-overlay';
      root.innerHTML = `
        <div id="ov-lock" class="layer lock-layer fade out drop"></div>
        <div id="ov-quick" class="layer fade out"></div>
        <div id="ov-drawer" class="layer fade out zoom"></div>
        <div id="ov-recents" class="layer fade out zoom"></div>`;
      if (this.mode) this.show({ mode: this.mode });
    },

    show(msg) {
      this.mode = msg.mode;
      closeMenu();
      for (const name of ['lock', 'quick', 'drawer', 'recents']) {
        const el = $(`#ov-${name}`);
        if (name === msg.mode) {
          this[name](el, msg);
          // next frame so the CSS transition runs
          requestAnimationFrame(() => el.classList.remove('out'));
        } else {
          el.classList.add('out');
        }
      }
    },

    update() {
      updateStatus();
      if (this.mode === 'lock') this.lockUpdate();
      if (this.mode === 'quick') this.quickUpdate();
    },

    // ------------------------------------------------ lock screen
    lock(el) {
      const ssid = st.wifi && st.wifi.ssid ? esc(st.wifi.ssid) : 'OneShell';
      const lockPhoto = cfg.lockPhotoUrl
        ? `<div class="photo user" style="left:900px;top:330px;width:170px;height:170px;--img:${css(cfg.lockPhotoUrl)}"></div>`
        : '<div class="photo dice" style="left:900px;top:330px;width:170px;height:170px"></div>';
      el.innerHTML = `
        ${wall(false)}
        ${statusBar(`${ssid} <span class="dot"></span>`)}
        <div style="position:absolute;top:62px;left:0;right:0;text-align:center;color:#555c68">${ic('lock', 'width:24px;height:24px')}</div>
        <div class="stage">
          <div class="lockdate" data-date="long"></div>
          <div class="lockclock" data-clock="pad"></div>
          <div class="w lk-card" style="left:530px;top:330px;width:170px;height:170px;background:rgba(170,184,200,.45);padding:20px">
            <svg id="lk-wx-icon" style="position:absolute;right:18px;top:16px;width:60px;height:60px;fill:#6c7079;stroke:#6c7079"><use href="#moon"/></svg>
            <div id="lk-wx-temp" style="position:absolute;left:22px;top:72px;font-size:26px;font-weight:600;color:#5d6470">--°</div>
            <div id="lk-wx-text" style="position:absolute;left:22px;top:110px;right:14px;font-size:12px;color:#5d6470;line-height:1.4"></div>
          </div>
          <div class="w lk-card" style="left:716px;top:330px;width:168px;height:76px;background:rgba(170,184,200,.45);display:flex;align-items:center;justify-content:space-around;color:#5d6470">
            <div style="text-align:center"><div id="lk-batt"></div><small id="lk-batt-t">--</small></div>
            <div style="text-align:center"><div id="lk-cpu"></div><small>CPU</small></div>
          </div>
          <div class="w click lk-card" id="lk-clean" style="left:716px;top:424px;width:76px;height:76px;background:rgba(170,184,200,.45);display:flex;align-items:center;justify-content:center;color:#5d6470">${ic('clean', 'width:34px;height:34px')}</div>
          ${lockPhoto}
        </div>
        <div class="lk-hint" style="position:absolute;left:0;right:0;bottom:130px;text-align:center;font-size:20px;color:#5d6470">Swipe up or press any key to unlock</div>
        <div class="lk-hint" style="position:absolute;left:0;right:0;bottom:100px;text-align:center;font-size:13px;color:#7c8696">Windows Hello • PIN • Password</div>
        <div class="click lk-btn" id="lk-left" style="position:absolute;left:48px;bottom:50px;width:66px;height:66px;border-radius:50%;background:rgba(190,202,218,.7);display:flex;align-items:center;justify-content:center;color:#fff">${ic('leaf', 'width:28px;height:28px;stroke-width:2.4')}</div>
        <div class="click lk-btn" id="lk-right" style="position:absolute;right:48px;bottom:50px;width:66px;height:66px;border-radius:50%;background:rgba(190,202,218,.7);display:flex;align-items:center;justify-content:center;color:#fff">${ic('cam', 'width:28px;height:28px;stroke-width:2.4')}</div>`;
      tick();
      this.lockUpdate();
      $('#lk-clean', el).onclick = (e) => { e.stopPropagation(); optimize(); };
      $('#lk-left', el).onclick = (e) => { e.stopPropagation(); this.unlock(); api.openUri('ms-settings:nightlight'); };
      $('#lk-right', el).onclick = (e) => { e.stopPropagation(); this.unlock(); api.openUri('microsoft.windows.camera:'); };

      // Swipe up (mouse/touch drag), scroll, double-click or any key unlocks.
      let startY = null;
      el.onpointerdown = (e) => { startY = e.clientY; el.setPointerCapture(e.pointerId); };
      el.onpointermove = (e) => {
        if (startY == null) return;
        const dy = Math.min(0, e.clientY - startY);
        $('.stage', el).style.transform = `translateY(${dy / 3}px)`;
        el.style.opacity = String(1 + dy / 600);
      };
      el.onpointerup = (e) => {
        if (startY == null) return;
        const dy = e.clientY - startY;
        startY = null;
        $('.stage', el).style.transform = '';
        el.style.opacity = '';
        if (dy < -120) this.unlock();
      };
      el.ondblclick = () => this.unlock();
      el.onwheel = (e) => { if (e.deltaY > 0) this.unlock(); };
    },
    ring(pct, color) {
      const r = 19;
      const c = 2 * Math.PI * r;
      const arc = c * 0.75;
      const v = (arc * clamp(pct || 0, 0, 100)) / 100;
      const circle = (dash, stroke) =>
        `<circle cx="22" cy="22" r="${r}" fill="none" stroke="${stroke}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${dash} ${c}" transform="rotate(135 22 22)"/>`;
      return `<svg class="ring" viewBox="0 0 44 44">${circle(arc, 'rgba(106,112,122,.25)')}${v > 0 ? circle(v, color) : ''}</svg>`;
    },
    lockUpdate() {
      const el = $('#ov-lock');
      if (!$('#lk-wx-temp', el)) return;
      const w = st.weather;
      $('#lk-wx-temp', el).textContent = w ? `${w.temp}°` : '--°';
      $('#lk-wx-text', el).innerHTML = w ? `Tomorrow's high<br>feels like ${w.tomorrowFeels}°${w.units}…` : '';
      $('#lk-wx-icon use', el).setAttribute('href', `#${(w && w.icon) || 'moon'}`);
      const b = st.battery;
      $('#lk-batt', el).innerHTML = this.ring(b ? b.percent : 0, '#6a707a');
      $('#lk-batt-t', el).textContent = b ? (b.hasBattery ? `${b.percent}%` : 'AC') : '--';
      $('#lk-cpu', el).innerHTML = this.ring(st.stats ? st.stats.cpu : 0, '#9aa2ae');
    },
    unlock() {
      api.hideOverlay();
    },

    // ------------------------------------------------ quick panel
    quick(el) {
      el.innerHTML = `
        <div class="qp-dim" id="qp-dim"></div>
        <div class="qp fade" id="qp">
          <div style="position:absolute;top:18px;left:34px;right:34px;display:flex;justify-content:space-between;font-size:15px;color:var(--ink2)">
            <span><span data-clock></span> &nbsp;<span data-date></span></span>
            <span style="display:flex;gap:18px">
              <span class="click" id="qp-edit">${ic('edit')}</span><span class="click" id="qp-power">${ic('power')}</span><span class="click" id="qp-gear">${ic('gear')}</span>
            </span>
          </div>
          <div id="qp-tiles" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px">
            <div class="slider" id="sl-bright"><div class="fill"></div>${ic('sun')}</div>
            <div class="slider" id="sl-vol"><div class="fill"></div>${ic('vol')}</div>
          </div>
          <div style="margin-top:14px;border-radius:24px;padding:16px;background:linear-gradient(120deg,#5d87b8,#9ab8de);color:#fff;display:flex;align-items:center;gap:16px">
            <div class="photo ocean" style="position:relative;width:64px;height:64px;border-radius:16px"></div>
            <div style="flex:1;min-width:0"><b id="np-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></b><div id="np-src" style="font-size:13px;opacity:.85"></div>
              <div style="height:4px;border-radius:2px;background:rgba(255,255,255,.35);margin-top:10px"><div style="width:45%;height:4px;border-radius:2px;background:#fff"></div></div></div>
            <div style="display:flex;gap:22px;align-items:center">
              <span class="media-btn" data-media="prev">${ic('prev', 'width:22px;height:22px;color:#fff')}</span>
              <span class="media-btn" data-media="playpause">${ic('pause', 'width:30px;height:30px;color:#fff')}</span>
              <span class="media-btn" data-media="next">${ic('next', 'width:22px;height:22px;color:#fff')}</span>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:22px;font-size:14px;color:var(--ink2)"><b style="color:var(--ink)">Notifications</b><span class="click" id="qp-notif-settings">Notification settings</span></div>
          <div class="notif" style="justify-content:center;color:var(--ink2);font-size:14px;padding:22px">No notifications</div>
        </div>`;
      tick();
      $('#qp-dim', el).onclick = () => api.hideOverlay();
      $('#qp-edit', el).onclick = () => api.openSettings('taskbar');
      $('#qp-gear', el).onclick = () => api.openUri('ms-settings:');
      $('#qp-notif-settings', el).onclick = () => api.openUri('ms-settings:notifications');
      $('#qp-power', el).onclick = (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        menu(r.left - 160, r.bottom + 8, [
          ['Lock', 'lock', () => api.power('lock')],
          ['Sleep', 'moon', () => api.power('sleep')],
          ['Restart', 'recent', () => api.power('restart')],
          ['Shut down', 'power', () => api.power('shutdown')],
          ['Sign out', 'user', () => api.power('signout')],
        ]);
      };
      $$('[data-media]', el).forEach((b) => (b.onclick = () => api.media(b.dataset.media)));
      this.slider($('#sl-vol', el), (v) => api.setVolume(v));
      this.slider($('#sl-bright', el), (v) => api.setBrightness(v));
      this.quickUpdate();
    },
    slider(el, set) {
      let dragging = false;
      let last = 0;
      const apply = (e) => {
        if (el.classList.contains('disabled')) return;
        const r = el.getBoundingClientRect();
        const v = Math.round(clamp(((e.clientX - r.left) / r.width) * 100, 0, 100));
        el.querySelector('.fill').style.width = `${v}%`;
        el.dataset.value = v;
        const now = Date.now();
        if (now - last > 60) {
          last = now;
          set(v);
        }
      };
      el.onpointerdown = (e) => { dragging = true; el.dataset.dragging = '1'; el.setPointerCapture(e.pointerId); apply(e); };
      el.onpointermove = (e) => { if (dragging) apply(e); };
      el.onpointerup = () => {
        dragging = false;
        delete el.dataset.dragging;
        if (el.dataset.value) set(Number(el.dataset.value));
      };
    },
    quickUpdate() {
      const el = $('#ov-quick');
      const tiles = $('#qp-tiles', el);
      if (!tiles) return;
      const wifi = st.wifi || {};
      const vol = st.volume || {};
      const T = [
        ['wifi', 'wifi', wifi.wired ? 'Ethernet' : 'Wi-Fi', wifi.wired ? 'Connected' : wifi.ssid || 'Off', wifi.connected],
        ['bluetooth', 'bt', 'Bluetooth', '', false],
        ['sound', vol.mute ? 'mute' : 'vol', 'Sound', vol.mute ? 'Muted' : `${vol.level == null ? '' : vol.level + '%'}`, !vol.mute],
        ['dark', 'moon', 'Dark mode', '', !!cfg.darkMode],
        ['eye', 'leaf', 'Eye comfort', '', false],
        ['airplane', 'plane', 'Airplane mode', '', false],
        ['snap', 'split', 'Snap layouts', '', false],
        ['screenshot', 'cam', 'Screenshot', '', false],
        ['power', 'power', 'Power mode', st.powerPlan || '', true],
      ];
      tiles.innerHTML = T.map(([key, icon, label, sub, on]) =>
        `<div class="tog${on ? ' on' : ''}" data-tog="${key}"><div class="ic">${ic(icon)}</div><div>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>`).join('');
      $$('[data-tog]', tiles).forEach((t) => (t.onclick = () => api.quickToggle(t.dataset.tog)));

      const sv = $('#sl-vol', el);
      if (!sv.dataset.dragging) sv.querySelector('.fill').style.width = `${vol.level || 0}%`;
      const sb = $('#sl-bright', el);
      sb.classList.toggle('disabled', st.brightness == null);
      if (!sb.dataset.dragging) sb.querySelector('.fill').style.width = `${st.brightness == null ? 100 : st.brightness}%`;

      const np = st.nowPlaying;
      $('#np-title', el).textContent = np ? np.title : 'Nothing playing';
      $('#np-src', el).textContent = np ? np.source : 'Media controls';
    },

    // ------------------------------------------------ app drawer
    async drawer(el) {
      this.page = 0;
      this.query = '';
      const name = cfg.user || 'You';
      el.innerHTML = `
        ${wall(true)}
        ${statusBar('<span data-clock></span>&nbsp;&nbsp; <span data-date></span>')}
        <div class="stage">
          <div class="pillsearch" style="position:absolute;left:400px;top:80px;width:800px">
            ${ic('search', 'width:22px;height:22px')}<input id="dr-search" placeholder="Search" spellcheck="false">
            <span class="click" id="dr-more">${ic('dots')}</span>
          </div>
          <div class="drawer-page" id="dr-grid"></div>
          <div class="dots" id="dr-dots" style="top:830px"></div>
          <div class="glass-pill" style="position:absolute;left:50%;transform:translateX(-50%);bottom:70px;display:flex;gap:12px;align-items:center;padding:10px 16px 10px 10px;border-radius:30px;background:rgba(255,255,255,.7)">
            <div class="app sm c-blu" style="border-radius:50%">${ic('user', '', '')}</div><b style="font-size:14px">${esc(name)}</b>
            <span style="width:1px;height:26px;background:#ccd3de;margin:0 6px"></span>
            <span class="click" id="dr-settings">${ic('gear', 'color:var(--ink2)')}</span><span class="click" id="dr-power">${ic('power', 'color:var(--ink2);margin-left:10px')}</span>
          </div>
        </div>`;
      tick();
      const search = $('#dr-search', el);
      search.oninput = () => { this.query = search.value.trim().toLowerCase(); this.page = 0; this.drawGrid(); };
      search.onkeydown = (e) => {
        if (e.key === 'Enter') { const first = this.filtered()[0]; if (first) api.launch(first.id); }
      };
      $('#dr-settings', el).onclick = () => api.openSettings();
      $('#dr-more', el).onclick = (e) => {
        e.stopPropagation();
        menu(e.clientX - 200, e.clientY + 20, [
          ['OneShell settings', 'gear', () => api.openSettings()],
          ['Windows Settings', 'gear', () => api.openUri('ms-settings:')],
        ]);
      };
      $('#dr-power', el).onclick = (e) => {
        e.stopPropagation();
        menu(e.clientX - 100, e.clientY - 290, [
          ['Lock', 'lock', () => api.power('lock')],
          ['Sleep', 'moon', () => api.power('sleep')],
          ['Restart', 'recent', () => api.power('restart')],
          ['Shut down', 'power', () => api.power('shutdown')],
          ['Sign out', 'user', () => api.power('signout')],
        ]);
      };
      el.onmousedown = (e) => {
        if (!e.target.closest('.app,.pillsearch,.dots,.menu,[id^="dr-"],b')) api.hideOverlay();
      };
      el.onwheel = (e) => {
        const pages = this.pageCount();
        const next = clamp(this.page + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1), 0, pages - 1);
        if (next !== this.page) { this.page = next; this.drawGrid(); }
      };
      this.drawGrid();
      setTimeout(() => search.focus(), 50);
      if (!apps.length) {
        apps = await api.listApps();
        this.drawGrid();
      }
    },
    filtered() {
      if (!this.query) return apps;
      return apps.filter((a) => a.name.toLowerCase().includes(this.query));
    },
    pageCount() {
      return Math.max(1, Math.ceil(this.filtered().length / 32));
    },
    drawGrid() {
      const el = $('#ov-drawer');
      const grid = $('#dr-grid', el);
      if (!grid) return;
      const list = this.filtered();
      const pageApps = list.slice(this.page * 32, this.page * 32 + 32);
      grid.innerHTML = pageApps.length
        ? pageApps.map((a) => `<div class="drawer-app" data-id="${esc(a.id)}">${appIcon(a, '', 'style="margin:0 auto"')}<div class="lbl">${esc(a.name)}</div></div>`).join('')
        : `<div class="empty" style="position:static;grid-column:1/-1">${apps.length ? 'No results' : 'Loading apps…'}</div>`;
      const pages = this.pageCount();
      $('#dr-dots', el).innerHTML = pages > 1 ? Array.from({ length: pages }, (_, i) => `<span class="dot${i === this.page ? ' on' : ''}" data-page="${i}"></span>`).join('') : '';
      $$('[data-page]', el).forEach((d) => (d.onclick = () => { this.page = Number(d.dataset.page); this.drawGrid(); }));
      $$('.drawer-app', grid).forEach((d) => {
        d.onclick = () => api.launch(d.dataset.id);
        d.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = d.dataset.id;
          const pinned = (cfg.pinned || []).includes(id);
          menu(e.clientX, e.clientY, [
            pinned ? ['Unpin from dock', 'x', () => api.pin(id, false)] : ['Pin to dock', 'pin', () => api.pin(id, true)],
          ]);
        };
      });
    },

    // ------------------------------------------------ recent apps
    recents(el, msg) {
      const list = msg.recents || [];
      el.innerHTML = `
        ${wall(true)}
        <div class="recents-strip" id="rc-strip">
          ${list.map((w) => {
            const ratio = clamp((w.width || 16) / (w.height || 10), 0.55, 1.8);
            const width = Math.round(560 * ratio);
            const icon = appIcon({ name: w.app || w.title, icon: w.icon }, 'sm', `data-icon="${w.hwnd}"`);
            const body = w.thumb
              ? `<img src="${w.thumb}" alt="">`
              : `<div class="placeholder">${appIcon({ name: w.app || w.title, icon: w.icon })}<span>${esc(w.app || '')}</span></div>`;
            return `<div class="rcard" data-hwnd="${w.hwnd}">
              <div style="display:flex;justify-content:center;margin-bottom:14px">${icon}</div>
              <div class="win" style="width:${width}px">${body}</div>
              <div class="title">${esc(w.title)}</div></div>`;
          }).join('')}
        </div>
        ${list.length ? '' : '<div class="empty">No recent apps</div>'}
        ${list.length ? '<div class="click glass-pill" id="rc-closeall" style="position:absolute;left:50%;transform:translateX(-50%);bottom:90px;padding:12px 30px;border-radius:24px;background:rgba(255,255,255,.75);font-size:15px;font-weight:600">Close all</div>' : ''}
        ${cfg.navButtons ? `<div class="nav">
          <span class="navbtn" data-nav="recents">${ic('recent', 'color:var(--accent)')}</span>
          <span class="navbtn" data-nav="home">${ic('home')}</span>
          <span class="navbtn" data-nav="back">${ic('back')}</span>
        </div>` : ''}`;
      const strip = $('#rc-strip', el);
      // Center the strip when it fits, like One UI.
      requestAnimationFrame(() => {
        if (strip.scrollWidth <= strip.clientWidth) strip.style.justifyContent = 'center';
      });
      strip.onwheel = (e) => { strip.scrollLeft += e.deltaY + e.deltaX; };
      const closeAll = $('#rc-closeall', el);
      if (closeAll) closeAll.onclick = () => api.closeAll();
      $$('[data-nav]', el).forEach((b) => (b.onclick = () => (b.dataset.nav === 'recents' ? api.hideOverlay() : api.nav(b.dataset.nav))));
      el.onmousedown = (e) => {
        if (!e.target.closest('.rcard .win,.rcard .app,.nav,#rc-closeall,.menu')) api.hideOverlay();
      };
      $$('.rcard', el).forEach((card) => {
        const hwnd = Number(card.dataset.hwnd);
        const win = $('.win', card);
        $('[data-icon]', card).onclick = (e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          menu(r.left - 80, r.bottom + 10, [
            ['Open in split screen view', 'split', () => api.split(hwnd)],
            ['Open in pop-up view', 'popup', () => api.popup(hwnd)],
            ['Close app', 'x', () => this.closeCard(card, hwnd)],
          ]);
        };
        // Swipe a card up to close it; a plain click opens it.
        let start = null;
        win.onpointerdown = (e) => { start = e.clientY; win.setPointerCapture(e.pointerId); win.style.transition = 'none'; };
        win.onpointermove = (e) => {
          if (start == null) return;
          const dy = Math.min(0, e.clientY - start);
          win.style.transform = `translateY(${dy}px)`;
          win.style.opacity = String(1 + dy / 500);
        };
        win.onpointerup = (e) => {
          if (start == null) return;
          const dy = e.clientY - start;
          start = null;
          win.style.transition = '';
          if (dy < -150) this.closeCard(card, hwnd);
          else {
            win.style.transform = '';
            win.style.opacity = '';
            if (Math.abs(dy) < 6) api.activate(hwnd);
          }
        };
        win.onauxclick = (e) => { if (e.button === 1) this.closeCard(card, hwnd); };
      });
    },
    closeCard(card, hwnd) {
      const win = $('.win', card);
      win.style.transform = 'translateY(-700px)';
      win.style.opacity = '0';
      api.closeWindow(hwnd);
      setTimeout(() => {
        card.remove();
        if (!$$('.rcard').length) api.hideOverlay();
      }, 180);
    },

    init() {
      api.onOverlay((msg) => {
        if (!msg.mode) {
          this.mode = null;
          closeMenu();
          $$('.layer').forEach((l) => l.classList.add('out'));
          return;
        }
        this.show(msg);
      });
      document.addEventListener('keydown', (e) => {
        if (this.mode === 'lock') { this.unlock(); return; }
        if (e.key === 'Escape') { api.hideOverlay(); return; }
        if (this.mode === 'drawer') {
          const s = $('#dr-search');
          if (s && document.activeElement !== s && e.key.length === 1) s.focus();
          if (e.key === 'ArrowRight' && document.activeElement !== s) { this.page = clamp(this.page + 1, 0, this.pageCount() - 1); this.drawGrid(); }
          if (e.key === 'ArrowLeft' && document.activeElement !== s) { this.page = clamp(this.page - 1, 0, this.pageCount() - 1); this.drawGrid(); }
        }
      });
      api.listApps().then((list) => { apps = list; if (this.mode === 'drawer') this.drawGrid(); });
    },
  };

  // =================================================================== SETTINGS
  const ACCENTS = [
    ['#3e7bfa', '#c9dbf2', '#eef4fc'],
    ['#7a8aa3', '#d6dde8', '#f2f4f8'],
    ['#8d6be8', '#ddd2fb', '#f5f1ff'],
    ['#e86b9b', '#fbd2e2', '#fff1f6'],
    ['#2fae73', '#c9f0db', '#effbf4'],
  ];
  const SECTIONS = [
    ['style', 'Wallpaper & style', 'c-pur', 'photo'],
    ['home', 'Home screen', 'c-blu', 'home'],
    ['lock', 'Lock screen', 'c-tea', 'lock'],
    ['taskbar', 'Taskbar & navigation', 'c-org', 'recent'],
    ['multi', 'Multi window', 'c-grn', 'split'],
    ['anim', 'Animations & sounds', 'c-pnk', 'spark'],
    ['about', 'About OneShell', 'c-gry', 'gear'],
  ];

  const settings = {
    section: params.get('section') || 'style',
    toggle(key, title, sub, invert) {
      const on = invert ? !cfg[key] : !!cfg[key];
      return `<div class="setrow"><div class="t"><b>${title}</b><span>${sub}</span></div><div class="sw${on ? '' : ' off'}" data-key="${key}"${invert ? ' data-invert="1"' : ''}></div></div>`;
    },
    render() {
      document.body.className = 'v-settings';
      root.innerHTML = `
        <div class="win" style="background:#f2f5fa">
          <div class="bar"><div class="handle"></div><div class="ctrls">
            <span id="w-min">${ic('min')}</span><span id="w-max">${ic('max')}</span><span id="w-close">${ic('x')}</span></div></div>
          <div style="display:flex;height:calc(100% - 34px)">
            <div style="width:360px;padding:20px 26px;flex:none">
              <h1>OneShell</h1>
              <div class="pillsearch" style="margin-top:18px;background:#e6ecf5;height:44px;font-size:14px">${ic('search')}<input id="set-search" placeholder="Search settings"></div>
              <div class="group setnav" style="margin-top:20px">
                ${SECTIONS.map(([id, label, color, icon]) => `
                  <div class="setrow${id === this.section ? ' on' : ''}" data-sec="${id}"><div class="app sm ${color}" style="width:38px;height:38px;border-radius:13px"><svg style="width:22px;height:22px"><use href="#${icon}"/></svg></div><div class="t"><b style="font-size:15px">${label}</b></div></div>`).join('')}
              </div>
            </div>
            <div class="settings-body" id="set-body"></div>
          </div>
        </div>`;
      $('#w-min').onclick = () => api.minimizeSelf();
      $('#w-max').onclick = () => api.maximizeSelf();
      $('#w-close').onclick = () => api.closeSelf();
      $$('[data-sec]').forEach((r) => (r.onclick = () => { this.section = r.dataset.sec; this.render(); }));
      $('#set-search').oninput = (e) => {
        const qv = e.target.value.trim().toLowerCase();
        $$('[data-sec]').forEach((r) => r.classList.toggle('hidden', !!qv && !r.textContent.toLowerCase().includes(qv)));
      };
      this.body();
    },
    body() {
      const b = $('#set-body');
      b.innerHTML = this[`sec_${this.section}`]();
      tick();
      $$('.sw[data-key]', b).forEach((sw) => {
        sw.onclick = () => {
          const key = sw.dataset.key;
          api.setConfig({ [key]: !cfg[key] });
        };
      });
      const bind = (id, fn) => { const el = $(id, b); if (el) el.onclick = fn; };
      bind('#pick-wall', pickWallpaper);
      bind('#pick-wall2', pickWallpaper);
      bind('#pick-wall-btn', pickWallpaper);
      bind('#windows-wall', async () => {
        const f = await api.windowsWallpaper();
        if (f) api.setConfig({ wallpaper: f });
        else toast('Couldn\'t find your Windows wallpaper');
      });
      $$('[data-wp]', b).forEach((t) => (t.onclick = () => api.setConfig({ wallpaperPreset: t.dataset.wp, wallpaper: null })));
      bind('#pick-lock', async () => { const f = await api.pickImage(); if (f) api.setConfig({ lockPhoto: f }); });
      bind('#reset-lock', () => api.setConfig({ lockPhoto: null }));
      bind('#save-city', () => api.setConfig({ city: $('#city', b).value.trim() }));
      bind('#quit', () => api.quit());
      bind('#show-lock', () => api.showOverlay('lock'));
      $$('[data-accent]', b).forEach((s) => (s.onclick = () => api.setConfig({ accent: s.dataset.accent })));
      $$('[data-units]', b).forEach((s) => (s.onclick = () => api.setConfig({ units: s.dataset.units })));
      $$('[data-slot]', b).forEach((s) => {
        const i = Number(s.dataset.slot);
        s.onclick = (e) => { if (e.target.closest('.x')) removePhoto(i); else changePhoto(i); };
      });
      $$('[data-unpin]', b).forEach((s) => (s.onclick = () => api.pin(s.dataset.unpin, false)));
      const city = $('#city', b);
      if (city) city.onkeydown = (e) => { if (e.key === 'Enter') api.setConfig({ city: city.value.trim() }); };
    },
    sec_style() {
      const current = cfg.wallpaperUrl ? null : cfg.wallpaperPreset || 'blue';
      return `
        <h1 style="font-size:26px">Wallpaper &amp; style</h1>
        <div style="display:flex;gap:24px;margin-top:20px">
          <div class="preview" id="pick-wall"><div class="${wallClass(false)}"></div>
            <div style="position:absolute;top:50px;left:0;right:0;text-align:center;font-weight:200;font-size:44px;color:#6e7480" data-clock="pad"></div>
            <div style="position:absolute;bottom:10px;left:0;right:0;text-align:center;font-size:11px;color:var(--ink2)">Lock screen</div></div>
          <div class="preview" id="pick-wall2"><div class="${wallClass(false)}"></div>
            <div class="photo ocean" style="right:20px;top:30px;width:110px;height:50px;border-radius:12px"></div>
            <div class="photo quote" style="right:80px;top:90px;width:50px;height:50px;border-radius:12px;font-size:10px">do what<br>you love</div>
            <div style="position:absolute;left:24px;top:40px;font-size:26px;font-weight:600" data-clock></div>
            <div style="position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:6px"><i class="app c-red" style="width:18px;height:18px;border-radius:6px"></i><i class="app c-org" style="width:18px;height:18px;border-radius:6px"></i><i class="app c-blu" style="width:18px;height:18px;border-radius:6px"></i><i class="app c-grn" style="width:18px;height:18px;border-radius:6px"></i></div>
            <div style="position:absolute;bottom:40px;left:0;right:0;text-align:center;font-size:11px;color:var(--ink2)">Home screen</div></div>
        </div>
        <div class="sec-title">Wallpapers</div>
        <div class="wp-grid">
          ${WALLPAPERS.map(([id, label]) => `<div class="wp-tile${current === id ? ' on' : ''}" data-wp="${id}"><div class="wall${id === 'blue' ? '' : ` wp-${id}`}"></div><span>${label}</span></div>`).join('')}
        </div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn" id="pick-wall-btn">Choose from your PC</button>
          ${cfg.platform === 'win32' || !cfg.platform ? '<button class="btn ghost" id="windows-wall">Use my Windows wallpaper</button>' : ''}
        </div>
        <div class="sec-title">Color palette <span style="font-weight:400;color:var(--ink2);font-size:13px">— picked from your wallpaper</span></div>
        <div style="display:flex;gap:16px;margin-top:14px">
          ${ACCENTS.map(([a, b2, c]) => `<div class="swatch${(cfg.accent || '#3e7bfa') === a ? ' on' : ''}" data-accent="${a}" style="background:conic-gradient(${a} 0 50%,${b2} 50% 75%,${c} 75%)"></div>`).join('')}
        </div>
        <div class="sec-title">Photo widgets <span style="font-weight:400;color:var(--ink2);font-size:13px">— click to pick your own pictures</span></div>
        <div style="display:flex;gap:14px;margin-top:14px">
          ${[0, 1, 2, 3, 4, 5].map((i) => {
            const url = (cfg.photoUrls || [])[i];
            const style = url ? `background:${css(url)} center/cover` : (i === 1 ? DOTS_ART : '');
            return `<div class="photo-slot photo ${url ? '' : PHOTO_ART[i]}" data-slot="${i}" style="position:relative;${style}${PHOTO_ART[i] === 'quote' && !url ? 'font-size:20px' : ''}">${url ? `<span class="x">${ic('x', 'width:12px;height:12px')}</span>` : PHOTO_INNER[i]}</div>`;
          }).join('')}
        </div>
        <div class="group" style="margin-top:26px">
          ${this.toggle('replaceTaskbar', 'Replace Windows taskbar with One UI dock', 'Hides the Windows 10/11 taskbar while OneShell runs')}
          ${this.toggle('replaceStart', 'Replace Start menu with app drawer', 'Windows key opens the One UI app grid')}
          ${this.toggle('navButtons', 'Show Android-style navigation buttons', 'Recents • Home • Back on the right side of the dock')}
          ${this.toggle('roundedWindows', 'Rounded windows &amp; One UI title bars', 'Applies to supported apps (others keep Windows frames)')}
          ${this.toggle('darkMode', 'Dark mode', 'Also switches Windows apps to dark')}
        </div>`;
    },
    sec_home() {
      const pinned = (cfg.pinned || []).map((id) => apps.find((a) => a.id === id)).filter(Boolean);
      return `
        <h1 style="font-size:26px">Home screen</h1>
        <div class="group">
          <div class="setrow"><div class="t"><b>Weather location</b><span>Leave empty to detect it automatically</span></div>
            <input class="field" id="city" placeholder="e.g. Karachi" value="${esc(cfg.city || '')}" style="width:220px"><button class="btn" id="save-city">Save</button></div>
          <div class="setrow"><div class="t"><b>Temperature units</b><span>Used by the weather widgets</span></div>
            <button class="btn ${cfg.units === 'F' ? 'ghost' : ''}" data-units="C">°C</button><button class="btn ${cfg.units === 'F' ? '' : 'ghost'}" data-units="F">°F</button></div>
          ${this.toggle('showSearch', 'Show search bar', 'The search pill under the clock widget')}
        </div>
        <div class="sec-title">Dock apps</div>
        <div class="note">Right-click any app in the app drawer to pin it to the dock.</div>
        <div class="group">
          ${pinned.length ? pinned.map((a) => `<div class="setrow">${appIcon(a, 'sm', 'style="width:38px;height:38px;border-radius:13px"')}<div class="t"><b style="font-size:15px">${esc(a.name)}</b></div><button class="btn ghost" data-unpin="${esc(a.id)}">Unpin</button></div>`).join('') : '<div class="setrow"><div class="t"><span>No apps pinned yet</span></div></div>'}
        </div>`;
    },
    sec_lock() {
      return `
        <h1 style="font-size:26px">Lock screen</h1>
        <div class="group">
          ${this.toggle('lockOnStartup', 'Show when Windows starts', 'The One UI lock screen appears after you sign in')}
          ${this.toggle('lockOnResume', 'Show after sleep', 'Appears when your PC wakes up')}
          <div class="setrow"><div class="t"><b>Lock screen photo</b><span>The picture widget next to the clock</span></div>
            <button class="btn" id="pick-lock">Choose photo</button>${cfg.lockPhoto ? '<button class="btn ghost" id="reset-lock">Use default</button>' : ''}</div>
          <div class="setrow"><div class="t"><b>Preview</b><span>Show the lock screen now</span></div><button class="btn ghost" id="show-lock">Show</button></div>
        </div>
        <div class="note">Your PC stays protected by Windows Hello, PIN or password; the One UI lock screen is shown on top of the desktop.</div>`;
    },
    sec_taskbar() {
      return `
        <h1 style="font-size:26px">Taskbar &amp; navigation</h1>
        <div class="group">
          ${this.toggle('replaceTaskbar', 'Replace Windows taskbar with One UI dock', 'Floating dock on the home screen, taskbar while apps are open')}
          ${this.toggle('navButtons', 'Navigation buttons', 'Recents • Home • Back')}
          ${this.toggle('replaceStart', 'Windows key opens the app drawer', 'Instead of the Start menu')}
          ${this.toggle('hookWinA', 'Win + A opens the quick panel', 'Instead of Windows quick settings')}
          ${this.toggle('hookWinTab', 'Win + Tab opens recent apps', 'Instead of Task View')}
        </div>`;
    },
    sec_multi() {
      return `
        <h1 style="font-size:26px">Multi window</h1>
        <div class="group">
          ${this.toggle('roundedWindows', 'Rounded window corners', cfg.win11 ? 'Rounds every app window' : 'Needs Windows 11 — Windows 10 keeps square corners')}
        </div>
        <div class="note">Open recent apps (Win + Tab or the Recents button), then tap an app's icon above its card to open it in split screen view or pop-up view.</div>`;
    },
    sec_anim() {
      return `
        <h1 style="font-size:26px">Animations &amp; sounds</h1>
        <div class="group">${this.toggle('animations', 'Animations', 'Fade and zoom when opening panels')}</div>`;
    },
    sec_about() {
      return `
        <h1 style="font-size:26px">About OneShell</h1>
        <div class="group">
          <div class="setrow"><div class="t"><b>Version</b><span>${esc(cfg.version || '')}</span></div></div>
          <div class="setrow"><div class="t"><b>Windows</b><span>${cfg.win11 ? 'Windows 11' : 'Windows 10'}</span></div></div>
          ${this.toggle('autostart', 'Start with Windows', 'Launch OneShell when you sign in')}
          <div class="setrow"><div class="t"><b>Quit OneShell</b><span>Brings back the normal Windows taskbar and Start menu</span></div><button class="btn ghost" id="quit">Quit</button></div>
        </div>
        <div class="note">Emergency exit: press Ctrl + Alt + Shift + Q at any time to quit and restore Windows.</div>`;
    },
    init() {
      api.onSettingsSection((s) => { this.section = s; this.render(); });
      api.listApps().then((list) => { apps = list; if (this.section === 'home') this.body(); });
    },
    update() {},
  };

  // =================================================================== boot
  const views = { desktop, dock, overlay, settings };
  const view = views[VIEW] || desktop;

  async function boot() {
    cfg = await api.getConfig();
    st = (await api.getState()) || {};
    applyTheme();
    if (view.init) view.init();
    view.render();
    api.onConfig((c) => {
      cfg = c;
      applyTheme();
      // keep the drawer/search state while open
      if (VIEW === 'overlay') overlay.update();
      else if (VIEW === 'settings') settings.render();
      else if (VIEW === 'dock') dock.render();
      else view.render();
    });
    api.onState((s) => {
      st = s;
      view.update();
    });
    setInterval(tick, 1000);
  }

  boot();
})();
