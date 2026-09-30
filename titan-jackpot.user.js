// ==UserScript==
// @name         Margonem — Tytan Jackpot
// @namespace    https://margonem.pl/addon/tytan-jackpot
// @version      2.2.5
// @description  Wspólne losowanie tytana. Przegrana = zasypanie ekranu zdjęciami z /dane.
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
    myTeamName: "",
    minTitanWt: 99,
    titanNames: [
      "Dziewicza Orlica", "Zabójczy Królik", "Renegat Baulus",
      "Piekielny Arcymag", "Versus Zoons", "Łowczyni Wspomnień",
      "Przyzywacz Demonów", "Maddok Magua", "Tezcatlipoca",
      "Barbatos Smoczy Strażnik", "Tanroth"
    ],
    stormMs: 9000,
    stormBurst: 70,
    stormSpawnEveryMs: 70,
    gatherMs: 4500,
    handshakeEveryMs: 8000,

    // WSPÓLNA BAZA DLA WSZYSTKICH GRACZY
    // 1) Wrzuć folder dane + catalog.json na GitHub (publiczne repo)
    // 2) Wklej tu RAW URL katalogu, np.:
    //    https://raw.githubusercontent.com/TWOJ_NICK/tytan-zasyp/main/dane/catalog.json
    catalogUrl: "https://raw.githubusercontent.com/minihnacik/tytan-zasyp/refs/heads/main/dane/catalog.json",

    images: []
  };

  const CATALOG_FALLBACK = [
    "1.png","2.png","3.jpg","4.jpg","5.jpg","6.png","7.png","8.png","9.jpg","10.png",
    "11.png","12.png","13.png","14.jpg","15.png","16.png","17.png","18.png","19.png","20.jpg",
    "21.jpg","22.jpg","23.png","24.png","25.png","26.png","27.png","28.png","29.webp","30.webp",
    "31.jpg","32.jpg","33.png","34.png","35.png","36.jpg","37.jpg","38.jpg","39.jpg","40.png",
    "41.jpg","42.jpg"
  ];

  const PREFIX = "~TJ";
  const STORAGE_KEY = "tytanJackpot_v2";
  const PEER_TTL = 20000;

  const state = {
    images: [],
    remoteImages: [],
    peers: {},
    lastTitan: null,
    session: null,
    spinning: false,
    stormTimer: null,
    stormStop: null,
    lastHelloAt: 0,
    lastRollKey: ""
  };

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch (e) { return {}; }
  }
  function saveStore(partial) {
    const cur = loadStore();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign(cur, partial)));
  }

  /* ===================== GRA ===================== */
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
  function heroClan() {
    const h = getHero();
    if (!h) return "";
    const c = h.clan;
    if (!c) return "";
    if (typeof c === "string") return c;
    return c.name || c.n || "";
  }
  function heroPartyId() {
    const h = getHero();
    if (!h) return "";
    if (h.party) return String(h.party);
    try {
      if (isNI() && window.Engine.party) {
        const p = window.Engine.party;
        if (p.id) return String(p.id);
        if (typeof p.getId === "function") return String(p.getId());
      }
    } catch (e) {}
    return "";
  }
  function myTeamKey() {
    const clan = heroClan();
    if (clan) return "klan:" + norm(clan);
    const party = heroPartyId();
    if (party) return "grp:" + party;
    return "solo:" + heroId();
  }
  function myTeamLabel() {
    const clan = heroClan();
    if (clan) return clan;
    if (heroPartyId()) return "grupa " + heroNick();
    return heroNick() || "ja";
  }
  function norm(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  }
  function getMapName() {
    try {
      if (isNI() && window.Engine.map && window.Engine.map.d) return window.Engine.map.d.name || "";
      if (window.map && window.map.name) return window.map.name;
    } catch (e) {}
    return "";
  }
  function heroInBattle() {
    try {
      if (isNI()) {
        if (window.Engine.battle && window.Engine.battle.show) return true;
        if (window.Engine.lock && window.Engine.lock.check && window.Engine.lock.check("battle")) return true;
      }
      if (window.g && window.g.battle) return true;
    } catch (e) {}
    return false;
  }
  function isTitan(npc) {
    if (npc && typeof npc.getKind === "function") {
      const kind = String(npc.getKind() || "").toLowerCase();
      if (kind === "titan" || kind === "colossus" || kind === "kolos") return true;
    }
    const d = npcData(npc);
    if (!d) return false;
    const wt = Number(d.wt || 0);
    if (wt >= CONFIG.minTitanWt) return true;
    const nick = String(d.nick || "");
    return CONFIG.titanNames.some(function (n) { return nick.toLowerCase() === n.toLowerCase(); });
  }
  function inspectPacket(data) {
    if (!data || typeof data !== "object") return;
    const bag = data.npc || data.npcs || null;
    if (!bag || typeof bag !== "object") return;
    Object.keys(bag).forEach(function (id) {
      const npc = bag[id];
      const d = npcData(npc);
      if (!d) return;
      if (d.id == null) d.id = id;
      if (d.del == 1) return;
      if (isTitan(d) || Number(d.wt || 0) >= CONFIG.minTitanWt) onTitanSpawn(d);
    });
  }
  function wrapSocket() {
    return false;
  }
  function listTitansOnMap() {
    const out = [];
    try {
      if (isNI() && window.Engine.npcs && typeof window.Engine.npcs.check === "function") {
        const all = window.Engine.npcs.check();
        Object.keys(all).forEach(function (id) {
          if (isTitan(all[id])) out.push(npcData(all[id]));
        });
      } else if (window.g && window.g.npc) {
        Object.keys(window.g.npc).forEach(function (id) {
          if (isTitan(window.g.npc[id])) out.push(window.g.npc[id]);
        });
      }
    } catch (e) {}
    return out;
  }
  function othersOnMap() {
    const list = [];
    try {
      if (isNI() && window.Engine.others) {
        const src = typeof window.Engine.others.check === "function"
          ? window.Engine.others.check()
          : window.Engine.others;
        Object.keys(src || {}).forEach(function (id) {
          const raw = src[id];
          const d = raw && (raw.d || raw);
          if (!d) return;
          list.push({
            id: String(d.id || id),
            nick: d.nick || "",
            clan: (d.clan && (d.clan.name || d.clan.n || d.clan)) || "",
            x: d.x, y: d.y
          });
        });
      } else if (window.g && window.g.other) {
        Object.keys(window.g.other).forEach(function (id) {
          const d = window.g.other[id];
          list.push({
            id: String(d.id || id),
            nick: d.nick || "",
            clan: (d.clan && d.clan.name) || d.clan || "",
            x: d.x, y: d.y
          });
        });
      }
    } catch (e) {}
    return list;
  }

  function sendLocalChat() {
    return false;
  }

  /* ===================== PROTOKOŁ ===================== */
  function pack(obj) {
    return PREFIX + " " + btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  }
  function unpack(text) {
    if (!text || text.indexOf(PREFIX) === -1) return null;
    const raw = text.slice(text.indexOf(PREFIX) + PREFIX.length).trim();
    try { return JSON.parse(decodeURIComponent(escape(atob(raw)))); }
    catch (e) {
      try { return JSON.parse(raw); } catch (e2) { return null; }
    }
  }

  function rememberPeer(msg, nickFromChat) {
    if (!msg || !msg.id) return;
    if (String(msg.id) === heroId()) return;
    state.peers[msg.id] = {
      id: String(msg.id),
      nick: msg.nick || nickFromChat || "",
      team: msg.team || "",
      label: msg.label || msg.team || msg.nick || "",
      titan: msg.titan || "",
      map: msg.map || "",
      at: Date.now()
    };
    renderPeers();
  }
  function livePeers() {
    const now = Date.now();
    return Object.keys(state.peers).map(function (id) {
      return state.peers[id];
    }).filter(function (p) {
      return now - p.at < PEER_TTL;
    });
  }
  function teamsFromPeers(peers) {
    const map = {};
    peers.forEach(function (p) {
      const k = p.team || ("solo:" + p.id);
      if (!map[k]) map[k] = { key: k, label: p.label || k, members: [] };
      map[k].members.push(p);
    });
    const mine = myTeamKey();
    if (!map[mine]) map[mine] = { key: mine, label: myTeamLabel(), members: [] };
    map[mine].members.push({
      id: heroId(),
      nick: heroNick(),
      team: mine,
      label: myTeamLabel()
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function broadcastHello(titan) {
    const now = Date.now();
    if (now - state.lastHelloAt < 1500) return;
    state.lastHelloAt = now;
    sendLocalChat(pack({
      v: 2,
      t: "hello",
      id: heroId(),
      nick: heroNick(),
      team: myTeamKey(),
      label: myTeamLabel(),
      titan: titan ? String(titan.id) : "",
      map: getMapName()
    }));
  }

  function iAmHost(peers) {
    const ids = peers.map(function (p) { return String(p.id); }).concat([heroId()]);
    ids.sort(function (a, b) {
      const na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a < b ? -1 : 1;
    });
    return ids[0] === heroId();
  }

  function pickWinner(teams, seed) {
    const sorted = teams.slice().sort(function (a, b) {
      return a.key < b.key ? -1 : 1;
    });
    const idx = Math.abs(hash32(seed)) % sorted.length;
    return sorted[idx];
  }
  function hash32(s) {
    let h = 2166136261;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function startSession(titan) {
    const key = String(titan.id) + "@" + getMapName();
    if (state.session && state.session.key === key && !state.session.done) return;
    state.session = {
      key: key,
      titanId: String(titan.id),
      titanNick: titan.nick || "Tytan",
      startedAt: Date.now(),
      done: false
    };
    setStatus("Tytan: " + state.session.titanNick + " — zbieram graczy z dodatkiem…", "#ffd86b");
    toast("Respi " + state.session.titanNick + " — start losowania");
    broadcastHello(titan);
    setTimeout(function () { tryCloseLottery(); }, CONFIG.gatherMs);
  }

  function tryCloseLottery() {
    const s = state.session;
    if (!s || s.done) return;
    const titanStill = listTitansOnMap().some(function (t) { return String(t.id) === s.titanId; });
    if (!titanStill && Date.now() - s.startedAt < 1200) return;

    const peers = livePeers().filter(function (p) {
      return !p.titan || p.titan === s.titanId || p.map === getMapName();
    });
    const teams = teamsFromPeers(peers);
    if (teams.length < 2) {
      setStatus("Za mało drużyn z dodatkiem (" + teams.length + "). Czekam…", "#ffb703");
      setTimeout(function () { tryCloseLottery(); }, 2500);
      return;
    }
    if (!iAmHost(peers)) {
      setStatus("Czekam na hosta losowania…", "#9ecbff");
      setTimeout(function () {
        if (state.session && !state.session.done) tryCloseLottery();
      }, 3000);
      return;
    }
    const seed = s.titanId + "|" + teams.map(function (t) { return t.key; }).sort().join(",") + "|" + Math.floor(Date.now() / 8000);
    applyRoll(s, teams, seed, true);
  }

  function applyRoll(session, teams, seed, doBroadcast) {
    if (!session || session.done) return;
    const rollKey = session.key + "|" + seed;
    if (state.lastRollKey === rollKey) return;
    state.lastRollKey = rollKey;
    session.done = true;

    const winner = pickWinner(teams, seed);
    const mine = myTeamKey();
    const weWon = norm(winner.key) === norm(mine);

    if (doBroadcast) {
      sendLocalChat(pack({
        v: 2,
        t: "roll",
        id: heroId(),
        nick: heroNick(),
        titan: session.titanId,
        seed: seed,
        winner: winner.key,
        winnerLabel: winner.label,
        teams: teams.map(function (t) { return t.key; })
      }));
    }

    setStatus(
      weWon
        ? "WYGRANA — tytan dla " + winner.label
        : "PRZEGRANA — tytan dla " + winner.label,
      weWon ? "#9ee493" : "#ff8a8a"
    );
    toast((weWon ? "WASZ TYTAN: " : "NIE WASZ: ") + winner.label);

    if (!weWon) startJackpot(session.titanNick + " → " + winner.label);
  }

  function onProtocol(msg, fromNick) {
    if (!msg || msg.v !== 2) return;
    rememberPeer(msg, fromNick);
    if (msg.t === "hello") {
      if (state.session && !state.session.done && msg.titan === state.session.titanId) {
        /* host może domknąć szybciej gdy zbierze 2 drużyny */
        const teams = teamsFromPeers(livePeers());
        if (teams.length >= 2 && Date.now() - state.session.startedAt > 1800) {
          tryCloseLottery();
        }
      }
    }
    if (msg.t === "roll") {
      let session = state.session;
      if (!session || session.titanId !== String(msg.titan)) {
        session = {
          key: String(msg.titan) + "@" + getMapName(),
          titanId: String(msg.titan),
          titanNick: (state.lastTitan && state.lastTitan.nick) || "Tytan",
          startedAt: Date.now(),
          done: false
        };
        state.session = session;
      }
      const teams = teamsFromPeers(livePeers());
      if (msg.winner && teams.every(function (t) { return t.key !== msg.winner; })) {
        teams.push({ key: msg.winner, label: msg.winnerLabel || msg.winner, members: [] });
      }
      applyRoll(session, teams, msg.seed || msg.winner, false);
    }
  }

  /* ===================== ZDJĘCIA / UI / JACKPOT ===================== */
  function defaultPlaceholders() {
    const colors = ["#c1121f", "#111", "#14213d", "#240046", "#ffb703", "#006d77", "#22223b", "#3d0066"];
    const labels = ["PECH", "F", "NEXT", "RIP", "xD", "LEGA?", "0", "FR"];
    return labels.map(function (label, i) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="' +
        colors[i] + '"/><text x="200" y="220" text-anchor="middle" font-family="Impact,Arial Black,sans-serif" font-size="72" fill="#fff">' +
        label + "</text></svg>";
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
    });
  }
  function resolveCatalogEntry(entry, catalogUrl) {
    if (!entry) return "";
    if (/^https?:\/\//i.test(entry) || /^data:/i.test(entry)) return entry;
    if (catalogUrl) {
      const base = catalogUrl.replace(/[^/]+$/, "");
      return base + entry;
    }
    return entry;
  }
  function applyFileList(list, catalogUrl) {
    state.remoteImages = (list || []).map(function (item) {
      const name = typeof item === "string" ? item : (item.url || item.file || item.src || "");
      return resolveCatalogEntry(name, catalogUrl);
    }).filter(Boolean);
    refreshImagePool();
  }
  function readInjectedCatalog() {
    try {
      const win = window;
      const injected = win.__TJ_REMOTE_IMAGES;
      if (injected && injected.length) {
        state.remoteImages = injected.slice();
        refreshImagePool();
        return true;
      }
    } catch (e) {}
    return false;
  }
  function loadCatalog() {
    if (readInjectedCatalog()) {
      setStatus("katalog zdjęć: " + state.images.length + " szt.", "#9ee493");
      return Promise.resolve();
    }
    const url = CONFIG.catalogUrl;
    if (!url) {
      applyFileList(CATALOG_FALLBACK, "");
      refreshImagePool();
      return Promise.resolve();
    }
    return fetch(url + (url.indexOf("?") === -1 ? "?t=" : "&t=") + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        const list = data.images || data.files || data.dane || [];
        applyFileList(list, url);
        setStatus("katalog zdjęć: " + state.images.length + " szt.", "#9ee493");
      })
      .catch(function () {
        applyFileList(CATALOG_FALLBACK, url);
        setStatus("katalog offline • zdjęć: " + state.images.length, "#ffd86b");
      });
  }
  function refreshImagePool() {
    const store = loadStore();
    const pool = []
      .concat(state.remoteImages || [])
      .concat(CONFIG.images || [])
      .concat(store.uploadedImages || []);
    state.images = pool.length ? pool : defaultPlaceholders();
  }
  function randomImage() {
    return state.images[Math.floor(Math.random() * state.images.length)];
  }
  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  async function ingestFiles(fileList) {
    const files = Array.from(fileList || []).filter(function (f) {
      return /^image\//.test(f.type) || /\.(svg|png|jpe?g|gif|webp)$/i.test(f.name);
    });
    const urls = [];
    for (let i = 0; i < files.length; i++) urls.push(await fileToDataUrl(files[i]));
    const store = loadStore();
    saveStore({ uploadedImages: (store.uploadedImages || []).concat(urls) });
    refreshImagePool();
    toast("Wgrano " + urls.length + " zdjęć (" + state.images.length + " w puli)");
  }

  function injectCss() {
    if (document.getElementById("tj-style")) return;
    const css = document.createElement("style");
    css.id = "tj-style";
    css.textContent = `
      #tj-root { position:fixed; z-index:999999; font-family:"Trebuchet MS",Arial,sans-serif; color:#f4e6c3; pointer-events:none; }
      #tj-root * { box-sizing:border-box; }
      #tj-panel { pointer-events:auto; position:fixed; top:72px; right:16px; width:190px;
        background:linear-gradient(180deg,#1b140c,#0d0a07); border:1px solid #c9a428; border-radius:6px;
        box-shadow:0 8px 20px rgba(0,0,0,.5); overflow:hidden; }
      #tj-panel header { background:linear-gradient(90deg,#5c430f,#c9a428 50%,#5c430f); color:#1a1208;
        font-weight:800; padding:4px 6px; display:flex; justify-content:space-between; align-items:center; cursor:move; font-size:11px; }
      #tj-panel header button { background:#1a1208; color:#c9a428; border:0; width:18px; height:18px; cursor:pointer; font-size:11px; }
      #tj-panel .body { padding:6px; display:grid; gap:6px; }
      #tj-panel label { font-size:11px; color:#d7c59a; display:block; }
      #tj-panel input[type=text] { width:100%; background:#0b0906; color:#f4e6c3; border:1px solid #7a5c16; padding:5px 7px; border-radius:4px; }
      #tj-panel .row { display:flex; gap:6px; }
      #tj-panel button.act { flex:1; background:#3a2a0c; color:#ffd86b; border:1px solid #c9a428; padding:5px 4px; cursor:pointer; font-weight:700; border-radius:4px; font-size:11px; }
      #tj-panel button.act:hover { background:#5a4012; }
      #tj-panel button.danger { background:#4a1010; border-color:#c1121f; color:#ffb4b4; }
      #tj-status { font-size:10px; min-height:14px; color:#9ee493; }
      #tj-peers-title { font-size:10px; color:#c9a428; font-weight:700; }
      #tj-peers { font-size:11px; background:#140f0a; border:1px solid #5a4314; padding:5px; border-radius:4px; max-height:140px; overflow:auto; color:#e6d3a3; line-height:1.35; }
      #tj-overlay { pointer-events:none; position:fixed; inset:0; display:none; overflow:hidden; }
      #tj-overlay.on { display:block; }
      #tj-storm { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
      .tj-flake {
        position:absolute; top:-20vh; object-fit:cover; border-radius:8px;
        box-shadow:0 8px 18px rgba(0,0,0,.45); pointer-events:none;
        will-change:transform, opacity;
      }
      #tj-banner {
        pointer-events:none; position:absolute; top:18px; left:50%; transform:translateX(-50%);
        background:rgba(12,8,4,.82); color:#ffe18a; border:2px solid #c9a428;
        padding:8px 16px; border-radius:8px; font-weight:800; letter-spacing:1px;
        text-shadow:0 0 10px #000; z-index:2; max-width:90vw; text-align:center;
      }
      #tj-close {
        pointer-events:auto; position:absolute; bottom:22px; left:50%; transform:translateX(-50%);
        background:#2a1a08; color:#ffd86b; border:1px solid #c9a428; padding:8px 18px;
        cursor:pointer; font-weight:700; z-index:3;
      }
      #tj-toast { pointer-events:none; position:fixed; bottom:28px; left:50%; transform:translateX(-50%);
        background:rgba(12,8,4,.92); color:#ffe18a; border:1px solid #c9a428; padding:8px 14px; border-radius:6px; opacity:0; transition:opacity .2s; font-size:13px; }
      #tj-toast.show { opacity:1; }
    `;
    document.head.appendChild(css);
  }
  function toast(msg) {
    const el = document.getElementById("tj-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove("show"); }, 2800);
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
    const me = heroNick() || heroId() || "ja";
    const peers = livePeers();
    const rows = ["<span style='color:#9ee493'>• " + me + " (ty)</span>"];
    peers.forEach(function (p) {
      rows.push("• " + (p.nick || ("id " + p.id)));
    });
    box.innerHTML = rows.join("<br>");
  }

  function buildUi() {
    if (document.getElementById("tj-root")) return;
    injectCss();
    const root = document.createElement("div");
    root.id = "tj-root";
    root.innerHTML =
      '<div id="tj-panel">' +
      "  <header><span>TYTAN ZASYP 2.2.5</span><button type=\"button\" id=\"tj-min\">+</button></header>" +
      '  <div class="body" id="tj-body" style="display:none">' +
      '    <div id="tj-status">nasłuch…</div>' +
      '    <div id="tj-peers-title">Z dodatkiem na mapie</div>' +
      '    <div id="tj-peers"></div>' +
      "  </div></div>" +
      '<div id="tj-overlay">' +
      '  <div id="tj-storm"></div>' +
      '  <div id="tj-banner">PRZEGRANA</div>' +
      '  <button type="button" id="tj-close">ZAMKNIJ</button>' +
      "</div><div id=\"tj-toast\"></div>";
    document.body.appendChild(root);

    document.getElementById("tj-close").addEventListener("click", hideJackpot);
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
      down = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); px = r.left; py = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!down) return;
      panel.style.left = px + (e.clientX - sx) + "px";
      panel.style.top = py + (e.clientY - sy) + "px";
      panel.style.right = "auto";
    });
    window.addEventListener("mouseup", function () { down = false; });
  }

  function hideJackpot() {
    const overlay = document.getElementById("tj-overlay");
    if (overlay) overlay.classList.remove("on");
    const storm = document.getElementById("tj-storm");
    if (storm) storm.innerHTML = "";
    if (state.stormTimer) clearInterval(state.stormTimer);
    if (state.stormStop) clearTimeout(state.stormStop);
    state.stormTimer = null;
    state.stormStop = null;
    state.spinning = false;
  }
  function spawnFlake(layer, stuck) {
    const img = document.createElement("img");
    img.className = "tj-flake";
    img.src = randomImage();
    const size = 70 + Math.random() * 160;
    const left = Math.random() * 100;
    const rot = (Math.random() * 720 - 360).toFixed(0);
    const drift = (Math.random() * 40 - 20).toFixed(0);
    const dur = (2.4 + Math.random() * 3.2).toFixed(2);
    img.style.width = size + "px";
    img.style.height = size + "px";
    img.style.left = left + "vw";
    img.style.zIndex = String(1 + Math.floor(Math.random() * 5));
    img.style.opacity = String(0.75 + Math.random() * 0.25);
    img.style.animation = "none";
    layer.appendChild(img);
    const start = performance.now();
    const fromY = -size - 20;
    const toY = window.innerHeight + size + 40;
    const fromX = (left / 100) * window.innerWidth;
    function fall(now) {
      if (!img.parentNode) return;
      const t = Math.min(1, (now - start) / (dur * 1000));
      const y = fromY + (toY - fromY) * t;
      const x = fromX + Number(drift) * 8 * t;
      const r = Number(rot) * t;
      img.style.transform = "translate(" + x + "px," + y + "px) rotate(" + r + "deg)";
      if (t < 1) requestAnimationFrame(fall);
      else if (!stuck) img.remove();
      else {
        img.style.transform = "translate(" + x + "px," + (window.innerHeight - size * 0.35) + "px) rotate(" + rot + "deg)";
      }
    }
    img.style.position = "fixed";
    img.style.top = "0";
    img.style.left = "0";
    requestAnimationFrame(fall);
  }
  function startJackpot(reason) {
    if (state.spinning) return;
    refreshImagePool();
    state.spinning = true;
    const overlay = document.getElementById("tj-overlay");
    const storm = document.getElementById("tj-storm");
    const banner = document.getElementById("tj-banner");
    storm.innerHTML = "";
    banner.textContent = "PRZEGRANA • " + String(reason || "tytan nie wasz").toUpperCase();
    overlay.classList.add("on");

    let n = 0;
    const burst = CONFIG.stormBurst || 70;
    for (let i = 0; i < 18; i++) spawnFlake(storm, false);
    state.stormTimer = setInterval(function () {
      n += 1;
      spawnFlake(storm, n > burst - 12);
      spawnFlake(storm, false);
      if (n >= burst) {
        clearInterval(state.stormTimer);
        state.stormTimer = null;
      }
    }, CONFIG.stormSpawnEveryMs || 70);
    state.stormStop = setTimeout(function () {
      state.spinning = false;
    }, CONFIG.stormMs || 9000);
  }

  /* ===================== HOOKI GRY ===================== */
  function extractChatText(payload) {
    if (!payload) return { text: "", nick: "" };
    if (typeof payload === "string") return { text: payload, nick: "" };
    const text = payload.text || payload.t || payload.msg || payload.message || "";
    const nick = payload.nick || payload.n || payload.author || "";
    if (payload.msg && typeof payload.msg === "object") {
      return {
        text: payload.msg.text || payload.msg.t || text,
        nick: payload.msg.nick || payload.msg.n || nick
      };
    }
    return { text: String(text), nick: String(nick) };
  }
  function maybeHideProtocolMessage(text) {
    if (!text || text.indexOf(PREFIX) === -1) return;
    try {
      document.querySelectorAll(".chat-message, .one-message, [class*='message']").forEach(function (el) {
        if (el.textContent && el.textContent.indexOf(PREFIX) !== -1) el.style.display = "none";
      });
    } catch (e) {}
  }

  function onTitanSpawn(npc) {
    const d = npcData(npc);
    state.lastTitan = { id: d.id, nick: d.nick, wt: d.wt, x: d.x, y: d.y, at: Date.now() };
    startSession(d);
  }

  function bindGameEvents() {
    const hook = function () {
      wrapSocket();
      if (!window.API || typeof window.API.addCallbackToEvent !== "function") return false;
      const ev = (window.Engine && window.Engine.apiData) || {};
      window.API.addCallbackToEvent(ev.NEW_NPC || "newNpc", function (npc) {
        if (isTitan(npc)) onTitanSpawn(npc);
      });
      window.API.addCallbackToEvent(ev.REMOVE_NPC || "removeNpc", function (npc) {
        const d = npcData(npc);
        if (state.session && d && String(d.id) === state.session.titanId && !state.session.done) {
          /* tytan zniknął zanim dociągnęliśmy 2 drużyny — spróbuj domknąć to co jest */
          setTimeout(tryCloseLottery, 200);
        }
      });
      window.API.addCallbackToEvent("newMsg", function (payload) {
        const chat = extractChatText(payload);
        const msg = unpack(chat.text);
        if (msg) {
          maybeHideProtocolMessage(chat.text);
          onProtocol(msg, chat.nick);
        }
      });
      window.API.addCallbackToEvent("newOther", function () { /* mapa się zapełnia */ });
      window.API.addCallbackToEvent("open_battle_window", function () {
        if (state.session && !state.session.done && !heroInBattle()) {
          setTimeout(tryCloseLottery, 150);
        }
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

  function watchLoop() {
    setInterval(function () {
      wrapSocket();
      const titans = listTitansOnMap();
      if (titans[0] && (!state.lastTitan || String(state.lastTitan.id) !== String(titans[0].id))) {
        onTitanSpawn(titans[0]);
      }
      if (state.session && !state.session.done) {
        broadcastHello(state.lastTitan || titans[0] || null);
      }
      renderPeers();
    }, CONFIG.handshakeEveryMs);
  }

  function boot() {
    if (!document.body) return setTimeout(boot, 250);
    buildUi();
    bindGameEvents();
    watchLoop();
    const store = loadStore();
    if (store.myTeamName) CONFIG.myTeamName = store.myTeamName;
    loadCatalog().then(function () {
      setStatus("nasłuch gry • drużyna: " + myTeamLabel() + " • zdjęć: " + state.images.length);
    });
  }
  boot();
})();
