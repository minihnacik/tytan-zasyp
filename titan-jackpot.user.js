// ==UserScript==
// @name         Margonem — Tytan Jackpot
// @namespace    https://margonem.pl/addon/tytan-jackpot
// @version      3.0.0
// @description  Zasyp zdjęciami przy tytanie. Lista nicków osób z dodatkiem.
// @author       TytanJackpot
// @match        https://*.margonem.pl/
// @match        http://*.margonem.pl/
// @match        https://*.margonem.com/
// @exclude      https://www.margonem.pl/*
// @exclude      https://forum.margonem.pl/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  if (window.__TJ_BOOTED) return;
  window.__TJ_BOOTED = true;

  const CONFIG = {
    minTitanWt: 99,
    stormMs: 9000,
    stormBurst: 70,
    stormSpawnEveryMs: 70,
    presenceEveryMs: 7000,
    peerTtlMs: 20000,
    catalogUrl: "https://raw.githubusercontent.com/minihnacik/tytan-zasyp/refs/heads/main/dane/catalog.json",
    presenceTopic: "tytan-zasyp-minihnacik"
  };

  const CATALOG_FALLBACK = [
    "1.png","2.png","3.jpg","4.jpg","5.jpg","6.png","7.png","8.png","9.jpg","10.png",
    "11.png","12.png","13.png","14.jpg","15.png","16.png","17.png","18.png","19.png","20.jpg",
    "21.jpg","22.jpg","23.png","24.png","25.png","26.png","27.png","28.png","29.webp","30.webp",
    "31.jpg","32.jpg","33.png","34.png","35.png","36.jpg","37.jpg","38.jpg","39.jpg","40.png",
    "41.jpg","42.jpg"
  ];

  const state = {
    images: [],
    peers: {},
    lastTitanId: "",
    spinning: false,
    stormTimer: null,
    stormStop: null
  };

  function isNI() {
    return typeof window.Engine === "object" && window.Engine && window.Engine.hero;
  }
  function npcData(npc) { return npc && (npc.d || npc); }
  function getHero() {
    if (isNI()) return window.Engine.hero.d || window.Engine.hero;
    return window.hero || null;
  }
  function heroId() {
    const h = getHero();
    return h ? String(h.id) : "";
  }
  function heroNick() {
    const h = getHero();
    return (h && (h.nick || h.name)) || "";
  }
  function worldName() {
    try { return location.hostname.split(".")[0] || "world"; }
    catch (e) { return "world"; }
  }
  function mapName() {
    try {
      if (isNI() && window.Engine.map && window.Engine.map.d) return window.Engine.map.d.name || "";
      if (window.map && window.map.name) return window.map.name;
    } catch (e) {}
    return "";
  }
  function isTitan(npc) {
    if (npc && typeof npc.getKind === "function") {
      const kind = String(npc.getKind() || "").toLowerCase();
      if (kind === "titan" || kind === "colossus" || kind === "kolos") return true;
    }
    const d = npcData(npc);
    if (!d) return false;
    return Number(d.wt || 0) >= CONFIG.minTitanWt;
  }
  function listTitansOnMap() {
    const out = [];
    try {
      if (isNI() && window.Engine.npcs && typeof window.Engine.npcs.check === "function") {
        const all = window.Engine.npcs.check();
        Object.keys(all).forEach(function (id) {
          if (isTitan(all[id])) out.push(npcData(all[id]));
        });
      }
    } catch (e) {}
    return out;
  }

  function resolveCatalogEntry(entry, catalogUrl) {
    if (!entry) return "";
    if (/^https?:\/\//i.test(entry) || /^data:/i.test(entry)) return entry;
    if (catalogUrl) return catalogUrl.replace(/[^/]+$/, "") + entry;
    return entry;
  }
  function applyFileList(list, catalogUrl) {
    state.images = (list || []).map(function (item) {
      const name = typeof item === "string" ? item : (item && (item.url || item.file || item.src)) || "";
      return resolveCatalogEntry(name, catalogUrl);
    }).filter(Boolean);
  }
  function defaultPlaceholders() {
    return ["PECH", "xD"].map(function (label) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#111"/><text x="200" y="220" text-anchor="middle" font-family="Impact,sans-serif" font-size="72" fill="#fff">' + label + "</text></svg>";
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
    });
  }
  function loadCatalog() {
    const url = CONFIG.catalogUrl;
    return fetch(url + (url.indexOf("?") === -1 ? "?t=" : "&t=") + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        applyFileList(data.images || data.files || [], url);
        if (!state.images.length) applyFileList(CATALOG_FALLBACK, url);
        setStatus("zdjęć: " + state.images.length);
      })
      .catch(function () {
        applyFileList(CATALOG_FALLBACK, url);
        if (!state.images.length) state.images = defaultPlaceholders();
        setStatus("katalog offline • zdjęć: " + state.images.length);
      });
  }
  function randomImage() {
    if (!state.images.length) state.images = defaultPlaceholders();
    return state.images[Math.floor(Math.random() * state.images.length)];
  }

  function presenceTopic() {
    return CONFIG.presenceTopic + "-" + worldName();
  }
  function rememberPeer(id, nick) {
    if (!id || id === heroId()) return;
    state.peers[id] = { id: String(id), nick: nick || ("id " + id), at: Date.now() };
    renderPeers();
  }
  function livePeers() {
    const now = Date.now();
    return Object.keys(state.peers).map(function (id) { return state.peers[id]; })
      .filter(function (p) { return now - p.at < CONFIG.peerTtlMs; });
  }
  function publishPresence() {
    const nick = heroNick();
    const id = heroId();
    if (!nick || !id) return;
    const body = JSON.stringify({ id: id, nick: nick, map: mapName(), w: worldName() });
    fetch("https://ntfy.sh/" + presenceTopic(), {
      method: "POST",
      headers: { "Content-Type": "text/plain", Title: "tj", Priority: "min" },
      body: body
    }).catch(function () {});
  }
  function listenPresence() {
    if (state._sse) return;
    try {
      const src = new EventSource("https://ntfy.sh/" + presenceTopic() + "/sse");
      state._sse = src;
      src.onmessage = function (ev) {
        try {
          const wrap = JSON.parse(ev.data);
          const raw = wrap.message || wrap.msg || "";
          const data = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (data && data.id) rememberPeer(data.id, data.nick);
        } catch (e) {}
      };
    } catch (e) {}
  }

  function setStatus(msg, color) {
    const el = document.getElementById("tj-status");
    if (!el) return;
    el.style.color = color || "#9ee493";
    el.textContent = msg;
  }
  function renderPeers() {
    const box = document.getElementById("tj-peers");
    if (!box) return;
    const me = heroNick() || "ja";
    const rows = ["<span style='color:#9ee493'>• " + me + " (ty)</span>"];
    livePeers().forEach(function (p) {
      rows.push("• " + (p.nick || p.id));
    });
    box.innerHTML = rows.join("<br>");
  }

  function injectCss() {
    if (document.getElementById("tj-style")) return;
    const css = document.createElement("style");
    css.id = "tj-style";
    css.textContent =
      '#tj-root{position:fixed;z-index:999999;font-family:"Trebuchet MS",Arial,sans-serif;color:#f4e6c3;pointer-events:none}' +
      "#tj-root *{box-sizing:border-box}" +
      "#tj-panel{pointer-events:auto;position:fixed;top:72px;right:16px;width:190px;background:linear-gradient(180deg,#1b140c,#0d0a07);border:1px solid #c9a428;border-radius:6px;box-shadow:0 8px 20px rgba(0,0,0,.5);overflow:hidden}" +
      "#tj-panel header{background:linear-gradient(90deg,#5c430f,#c9a428 50%,#5c430f);color:#1a1208;font-weight:800;padding:4px 6px;display:flex;justify-content:space-between;align-items:center;cursor:move;font-size:11px}" +
      "#tj-panel header button{background:#1a1208;color:#c9a428;border:0;width:18px;height:18px;cursor:pointer;font-size:11px}" +
      "#tj-panel .body{padding:6px;display:grid;gap:6px}" +
      "#tj-status{font-size:10px;min-height:14px;color:#9ee493}" +
      "#tj-peers-title{font-size:10px;color:#c9a428;font-weight:700}" +
      "#tj-peers{font-size:11px;background:#140f0a;border:1px solid #5a4314;padding:5px;border-radius:4px;max-height:140px;overflow:auto;color:#e6d3a3;line-height:1.35}" +
      "#tj-overlay{pointer-events:none;position:fixed;inset:0;display:none;overflow:hidden}" +
      "#tj-overlay.on{display:block}" +
      "#tj-storm{position:absolute;inset:0;overflow:hidden;pointer-events:none}" +
      ".tj-flake{position:absolute;top:-20vh;object-fit:cover;border-radius:8px;box-shadow:0 8px 18px rgba(0,0,0,.45);pointer-events:none;will-change:transform,opacity}" +
      "#tj-banner{pointer-events:none;position:absolute;top:18px;left:50%;transform:translateX(-50%);background:rgba(12,8,4,.82);color:#ffe18a;border:2px solid #c9a428;padding:8px 16px;border-radius:8px;font-weight:800;letter-spacing:1px;text-shadow:0 0 10px #000;z-index:2;max-width:90vw;text-align:center}" +
      "#tj-close{pointer-events:auto;position:absolute;bottom:22px;left:50%;transform:translateX(-50%);background:#2a1a08;color:#ffd86b;border:1px solid #c9a428;padding:8px 18px;cursor:pointer;font-weight:700;z-index:3}";
    document.head.appendChild(css);
  }

  function hideStorm() {
    const ov = document.getElementById("tj-overlay");
    if (ov) ov.classList.remove("on");
    const storm = document.getElementById("tj-storm");
    if (storm) storm.innerHTML = "";
    clearInterval(state.stormTimer);
    clearTimeout(state.stormStop);
    state.stormTimer = null;
    state.stormStop = null;
    state.spinning = false;
  }
  function spawnFlake(storm) {
    const img = document.createElement("img");
    img.className = "tj-flake";
    img.src = randomImage();
    const size = 70 + Math.random() * 110;
    img.style.width = size + "px";
    img.style.height = size + "px";
    img.style.left = Math.random() * 100 + "vw";
    img.style.transform = "rotate(" + (Math.random() * 80 - 40) + "deg)";
    const dur = 3.2 + Math.random() * 3.5;
    img.animate(
      [
        { transform: img.style.transform + " translateY(0)", opacity: 1 },
        { transform: "rotate(" + (Math.random() * 180 - 90) + "deg) translateY(120vh)", opacity: 0.15 }
      ],
      { duration: dur * 1000, easing: "linear", fill: "forwards" }
    );
    storm.appendChild(img);
    setTimeout(function () { if (img.parentNode) img.parentNode.removeChild(img); }, dur * 1000 + 200);
  }
  function startStorm(label) {
    if (state.spinning) return;
    state.spinning = true;
    const ov = document.getElementById("tj-overlay");
    const storm = document.getElementById("tj-storm");
    const banner = document.getElementById("tj-banner");
    if (!ov || !storm) return;
    storm.innerHTML = "";
    if (banner) banner.textContent = label || "TYTAN";
    ov.classList.add("on");
    let n = 0;
    const burst = CONFIG.stormBurst || 70;
    for (let i = 0; i < 18; i++) spawnFlake(storm);
    state.stormTimer = setInterval(function () {
      n += 1;
      spawnFlake(storm);
      if (n >= burst) {
        clearInterval(state.stormTimer);
        state.stormTimer = null;
      }
    }, CONFIG.stormSpawnEveryMs || 70);
    state.stormStop = setTimeout(hideStorm, CONFIG.stormMs || 9000);
  }

  function onTitan(npc) {
    const d = npcData(npc);
    if (!d || d.id == null) return;
    const id = String(d.id);
    if (state.lastTitanId === id) return;
    state.lastTitanId = id;
    startStorm(d.nick || "TYTAN");
  }

  function buildUi() {
    if (document.getElementById("tj-root")) return;
    injectCss();
    const root = document.createElement("div");
    root.id = "tj-root";
    root.innerHTML =
      '<div id="tj-panel">' +
      '  <header><span>TYTAN ZASYP 3.0.0</span><button type="button" id="tj-min">+</button></header>' +
      '  <div class="body" id="tj-body" style="display:none">' +
      '    <div id="tj-status">nasłuch…</div>' +
      '    <div id="tj-peers-title">Z dodatkiem</div>' +
      '    <div id="tj-peers"></div>' +
      "  </div></div>" +
      '<div id="tj-overlay"><div id="tj-storm"></div><div id="tj-banner">TYTAN</div>' +
      '<button type="button" id="tj-close">ZAMKNIJ</button></div>';
    document.body.appendChild(root);
    document.getElementById("tj-close").addEventListener("click", hideStorm);
    document.getElementById("tj-min").addEventListener("click", function () {
      const body = document.getElementById("tj-body");
      const btn = document.getElementById("tj-min");
      const open = body.style.display === "none";
      body.style.display = open ? "grid" : "none";
      btn.textContent = open ? "–" : "+";
      if (open) renderPeers();
    });
    makeDraggable(document.getElementById("tj-panel"));
    renderPeers();
  }
  function makeDraggable(panel) {
    const handle = panel.querySelector("header");
    let sx = 0, sy = 0, px = 0, py = 0, down = false;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      down = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = panel.getBoundingClientRect();
      px = r.left;
      py = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!down) return;
      panel.style.left = px + e.clientX - sx + "px";
      panel.style.top = py + e.clientY - sy + "px";
      panel.style.right = "auto";
    });
    window.addEventListener("mouseup", function () { down = false; });
  }

  function bindGame() {
    const hook = function () {
      if (!window.API || typeof window.API.addCallbackToEvent !== "function") return false;
      window.API.addCallbackToEvent("newNpc", function (npc) {
        if (isTitan(npc)) onTitan(npc);
      });
      return true;
    };
    if (hook()) return;
    let n = 0;
    const iv = setInterval(function () {
      n += 1;
      if (hook() || n > 40) clearInterval(iv);
    }, 400);
  }

  function loop() {
    setInterval(function () {
      const titans = listTitansOnMap();
      if (titans[0]) onTitan(titans[0]);
      publishPresence();
      renderPeers();
    }, CONFIG.presenceEveryMs);
  }

  function boot() {
    if (!document.body) return setTimeout(boot, 250);
    buildUi();
    bindGame();
    listenPresence();
    loop();
    loadCatalog();
    setTimeout(publishPresence, 800);
  }
  boot();
})();
