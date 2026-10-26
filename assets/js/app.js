'use strict';
const Qs = window.ANA_W_ANTA_QUESTIONS;

const SB = {
  URL: 'https://rrbzbxjavdoqnhuytgbi.supabase.co',
  KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJyYnpieGphdmRvcW5odXl0Z2JpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MzQyODksImV4cCI6MjA5NTAxMDI4OX0.NAaHrAAYIMe8heVBbH8Jd1BwMU_UmMJm65z6nSeSAaM'
};

const MAX_ANSWER_LEN = 500;

/* ═══════════════════════════════════════
   DB — Supabase REST
═══════════════════════════════════════ */
function genToken() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 't' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function genRoomCode() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

const Room = {
  async leave() {
    if (!GS.roomId || !GS.roomToken) return;
    const id = GS.roomId;
    const token = GS.roomToken;
    const isHost = GS.isHost;
    DB.setToken(token);
    if (isHost) await DB.del(id, { silent: true });
    else await DB.upd(id, { guest_heartbeat: 0 }, { silent: true });
  },
  async finish() {
    if (!GS.roomId || !GS.roomToken) return;
    const id = GS.roomId;
    const token = GS.roomToken;
    const isHost = GS.isHost;
    const updated = await DB.upd(id, { status: 'finished' }, { silent: true, roomToken: token });
    // Keep the finished room readable long enough for the other player's poller to show results.
    if (isHost && Array.isArray(updated) && updated.length > 0) {
      setTimeout(() => DB.del(id, { silent: true, roomToken: token }), 15000);
    }
  }
};

function nextQIndex(q) {
  return q < Qs.length - 1 ? q + 1 : 0;
}

const ROOM_READ_COLUMNS = [
  'id', 'code', 'host_name', 'guest_name', 'current_q', 'host_answer', 'guest_answer',
  'status', 'chat_log', 'post_chat_log', 'end_request', 'pause_state', 'punishment',
  'post_chat_open', 'timer_started_at', 'timer_elapsed_pause', 'pun_chat_log',
  'host_heartbeat', 'guest_heartbeat', 'enabled_cats'
];
const ROOM_SELECT = ROOM_READ_COLUMNS.join(',');

const DB = (() => {
  const URL  = SB.URL + '/rest/v1/game_rooms';
  const KEY  = SB.KEY;
  const BASE = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  let roomToken = null;

  function headers(tokenOverride) {
    const h = { ...BASE };
    const token = arguments.length ? tokenOverride : roomToken;
    if (token) h['x-room-token'] = token;
    return h;
  }

  async function req(method, filter = '', body = null, opts = {}) {
    let controller = null;
    let timeout = null;
    try {
      const requestHeaders = Object.prototype.hasOwnProperty.call(opts, 'roomToken') ? headers(opts.roomToken) : headers();
      if (method === 'DELETE') requestHeaders['Prefer'] = 'return=minimal';
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 12000);
      }
      const r = await fetch(URL + (filter ? '?' + filter : ''), {
        method, headers: requestHeaders,
        body: body ? JSON.stringify(body) : null,
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!r.ok) {
        if (opts.onStatus) opts.onStatus(false);
        if (!opts.silent) {
          const errTxt = await r.text().catch(() => '');
          console.warn('DB', method, r.status, errTxt);
          if (opts.toast) Toast.show(opts.toast, 'error');
        }
        return [];
      }
      const txt = await r.text();
      const data = txt ? JSON.parse(txt) : [];
      if (opts.onStatus) opts.onStatus(true);
      return data;
    } catch (e) {
      if (opts.onStatus) opts.onStatus(false);
      if (!opts.silent) console.warn('DB', method, e);
      return [];
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function patchKeepalive(id, data) {
    fetch(URL + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { ...headers(), 'Prefer': 'return=minimal' },
      body: JSON.stringify(data),
      keepalive: true
    }).catch(() => {});
  }

  async function rpc(fn, params, opts = {}) {
    let controller = null;
    let timeout = null;
    try {
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 12000);
      }
      const r = await fetch(SB.URL + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: Object.prototype.hasOwnProperty.call(opts, 'roomToken') ? headers(opts.roomToken) : headers(),
        body: JSON.stringify(params),
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!r.ok) {
        if (!opts.silent) {
          const errTxt = await r.text().catch(() => '');
          console.warn('DB.rpc', fn, r.status, errTxt);
          if (opts.toast) Toast.show(opts.toast, 'error');
        }
        return null;
      }
      const txt = await r.text();
      if (!txt || txt === 'null') return null;
      return JSON.parse(txt);
    } catch (e) {
      if (!opts.silent) console.warn('DB.rpc', fn, e);
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return {
    setToken(t) { roomToken = t || null; },
    clearToken() { roomToken = null; },
    get:  (col, val, opts)      => req('GET', `${col}=eq.${encodeURIComponent(val)}&select=${ROOM_SELECT}`, null, opts),
    getStatus: async (col, val, token) => {
      let ok = false;
      const opts = { silent: true, onStatus: value => { ok = value; } };
      if (token) opts.roomToken = token;
      const rows = await req('GET', `${col}=eq.${encodeURIComponent(val)}&select=${ROOM_SELECT}`, null, opts);
      return { ok, rows };
    },
    ins:  (data, opts)          => req('POST', 'select=id', data, opts),
    upd:  (id, data, opts)      => req('PATCH', `id=eq.${encodeURIComponent(id)}&select=id`, data, opts),
    cas: (id, conditions, data, opts) => {
      const filters = [`id=eq.${encodeURIComponent(id)}`];
      for (const [column, value] of Object.entries(conditions || {})) {
        if (!/^[a-z_]+$/.test(column)) throw new Error('Invalid compare-and-set column');
        filters.push(value === null
          ? `${column}=is.null`
          : `${column}=eq.${encodeURIComponent(String(value))}`);
      }
      return req('PATCH', `${filters.join('&')}&select=id`, data, opts);
    },
    del:  (id, opts)            => req('DELETE', `id=eq.${encodeURIComponent(id)}`, null, opts),
    rpc,
    patchKeepalive
  };
})();

const Session = (() => {
  const KEY = 'ana_w_anta_room';
  let storageWarned = false;

  return {
    save(code) {
      if (!GS.roomId || !GS.roomToken) return;
      try {
        sessionStorage.setItem(KEY, JSON.stringify({
          roomId: GS.roomId,
          isHost: GS.isHost,
          myName: GS.myName,
          code: code || '',
          roomToken: GS.roomToken,
          totalAnswered: GS.totalAnswered,
          usedQs: GS.usedQs.slice(0, Qs.length),
          boldUnlocked: GS.boldUnlocked,
          boldQsThisRound: GS.boldQsThisRound,
          history: GS.history.slice(-100)
        }));
      } catch (e) {
        if (!storageWarned) {
          storageWarned = true;
          Toast.show('تعذر حفظ الجلسة على هذا الجهاز؛ احتفظ بكود الغرفة.', 'warning', 5000);
        }
      }
    },
    clear() {
      try { sessionStorage.removeItem(KEY); } catch (e) {}
      DB.clearToken();
      GS.roomToken = null;
    },
    clearExpired() {
      this.clear();
      GS.roomId = null; GS.roomToken = null; GS.isHost = false;
      GS.myName = ''; GS.partnerName = '';
      GS.reset();
      Chat.clearPending();
      Poller.stop(); Timer.stop(); Heartbeat.stop();
      Modal.hideAll();
      showScreen('homeScreen');
    },
    load() {
      try {
        const raw = sessionStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    async tryRestore() {
      const data = this.load();
      if (!data || !data.roomId || !data.roomToken) return;
      GS.roomId = data.roomId;
      GS.isHost = !!data.isHost;
      GS.myName = cleanName(data.myName || '');
      GS.roomToken = data.roomToken;
      GS.totalAnswered = Number.isFinite(data.totalAnswered) ? Math.max(0, data.totalAnswered) : 0;
      GS.usedQs = Array.isArray(data.usedQs) ? data.usedQs.filter(i => Number.isInteger(i) && !!Qs[i]) : [];
      GS.boldUnlocked = data.boldUnlocked === true || GS.totalAnswered >= 10;
      GS.boldQsThisRound = Number.isInteger(data.boldQsThisRound) ? Math.max(0, data.boldQsThisRound) : 0;
      GS.history = Array.isArray(data.history) ? data.history.slice(-100) : [];
      GS.myAnsweredCount = GS.history.filter(item => item && item.myAns).length;
      GS.partnerAnsweredCount = GS.history.filter(item => item && item.partnerAns).length;
      DB.setToken(data.roomToken);

      // The room token is validated by the row-level policy on this read; do not
      // depend on an optional role RPC that is absent from the current project DB.
      const { ok, rows } = await DB.getStatus('id', data.roomId);
      if (!ok) {
        GS.roomId = null;
        GS.roomToken = null;
        DB.clearToken();
        Toast.show('تعذر الاتصال لاستعادة جلستك. احتفظ بالكود وحاول مجددًا.', 'warning', 5000);
        return;
      }
      if (!rows || !rows[0]) {
        this.clearExpired();
        Toast.show('انتهت الجلسة أو لم تعد الغرفة موجودة', 'warning');
        return;
      }
      const room = rows[0];
      Cats.applyFromRoom(room);
      this.save(data.code || room.code || '');
      if (data.isHost) {
        GS.partnerName = cleanName(room.guest_name || '');
        document.getElementById('createName').value = GS.myName;
        document.getElementById('roomCode').textContent = data.code || room.code || '------';
        document.getElementById('createResult').style.display = 'block';
        showScreen('createScreen');
        if (room.status === 'playing' && room.guest_name) {
          Game.resume(room);
        } else if (room.status === 'waiting' && !room.guest_name) {
          Poller.startJoin();
        } else {
          this.clearExpired();
          Toast.show('الغرفة انتهت أو لم تعد قابلة للاستعادة؛ ابدأ من جديد أو اطلب من المضيف كودًا صالحًا.', 'warning');
        }
      } else if (room.status === 'playing') {
        GS.partnerName = cleanName(room.host_name || '');
        Game.resume(room);
      } else {
        this.clearExpired();
        Toast.show('الغرفة لم تبدأ أو انتهت؛ اطلب من المضيف كودًا صالحًا أو أنشئ غرفة جديدة.', 'warning');
      }
    }
  };
})();

/* ═══════════════════════════════════════
   SANITIZE
═══════════════════════════════════════ */
function san(s) {
  if (!s) return '';
  return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

function cleanName(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function normalizeRoomCode(value) {
  return String(value ?? '')
    .replace(/[٠-٩۰-۹]/g, digit => {
      const code = digit.charCodeAt(0);
      return String.fromCharCode(code >= 0x06f0 ? 48 + code - 0x06f0 : 48 + code - 0x0660);
    })
    .replace(/\D/g, '')
    .slice(0, 6);
}

/* ═══════════════════════════════════════
   TOAST
═══════════════════════════════════════ */
const Toast = (() => {
  let tm = null;
  return {
    show(msg, type = '', dur = 3000) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast ' + (type || '') + ' show';
      if (tm) clearTimeout(tm);
      tm = setTimeout(() => el.classList.remove('show'), dur);
    }
  };
})();

/* ═══════════════════════════════════════
   MODAL MANAGER
═══════════════════════════════════════ */
const Intro = {
  KEY: 'ana_w_anta_intro_seen',
  dismiss() {
    try { localStorage.setItem(this.KEY, '1'); } catch (e) {}
    Modal.hide('introModal');
    Session.tryRestore();
  },
  show() {
    Modal.show('introModal');
  },
  maybeShow() {
    try {
      if (!localStorage.getItem(this.KEY)) Modal.show('introModal');
      else Session.tryRestore();
    } catch (e) {
      Modal.show('introModal');
    }
  }
};

const Cats = {
  enabled: { r: true, d: true, b: false, n: true },
  toggle(cat) {
    this.enabled[cat] = !this.enabled[cat];
    if (!this.list().length) {
      this.enabled[cat] = true;
      Toast.show('يجب اختيار فئة واحدة على الأقل', 'warning');
    }
    this.syncUI();
  },
  list() {
    return Object.keys(this.enabled).filter(k => this.enabled[k]);
  },
  isQEnabled(idx) {
    return this.enabled[Qs[idx].c];
  },
  toJSON() {
    const categories = this.list();
    if (GS.boldUnlocked) categories.push('u');
    return JSON.stringify(categories);
  },
  applyFromRoom(room) {
    if (!room || !room.enabled_cats) return;
    try {
      const arr = JSON.parse(room.enabled_cats);
      if (!Array.isArray(arr)) return;
      if (arr.includes('u')) GS.boldUnlocked = true;
      Object.keys(this.enabled).forEach(k => { this.enabled[k] = arr.includes(k); });
      if (!this.list().length) this.enabled.r = true;
      this.syncUI();
    } catch (e) {}
  },
  syncUI() {
    document.querySelectorAll('.cat-chip').forEach(el => {
      const c = el.dataset.cat;
      if (c) el.classList.toggle('active', !!this.enabled[c]);
    });
  }
};

const History = {
  KEY: 'ana_w_anta_sessions',
  save(data) {
    try {
      const all = this.list();
      all.unshift({ ...data, savedAt: Date.now() });
      if (all.length > 15) all.length = 15;
      localStorage.setItem(this.KEY, JSON.stringify(all));
    } catch (e) {}
  },
  list() {
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },
  show() {
    const box = document.getElementById('historyList');
    const sessions = this.list();
    if (!sessions.length) {
      box.innerHTML = '<div class="hist-empty">لا توجد جلسات محفوظة بعد</div>';
    } else {
      box.innerHTML = '';
      sessions.forEach(s => {
        const d = document.createElement('div');
        d.className = 'hist-session';
        const dt = new Date(s.savedAt || Date.now());
        d.innerHTML = `<div class="hist-session-date">${dt.toLocaleDateString('ar')} — ${dt.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}</div><div class="hist-session-meta">${san(s.myName)} و ${san(s.partnerName)} · ${s.questions || 0} سؤال · أنت ${s.myScore || 0} / شريكك ${s.partnerScore || 0}</div>`;
        box.appendChild(d);
      });
    }
    Modal.show('historyModal');
  }
};

const JoinGuard = {
  times: [],
  ok() {
    const now = Date.now();
    this.times = this.times.filter(t => now - t < 60000);
    if (this.times.length >= 6) return false;
    this.times.push(now);
    return true;
  }
};

function canNavigateToQ(i) {
  if (!Number.isInteger(i) || !Qs[i] || !Cats.isQEnabled(i)) return false;
  if (Qs[i].c === 'b' && (!GS.boldUnlocked || GS.boldQsThisRound >= 2)) return false;
  return true;
}

function firstEligibleQuestion() {
  for (let i = 0; i < Qs.length; i++) {
    if (canNavigateToQ(i)) return i;
  }
  return -1;
}

function qAllowed(i) {
  return i !== GS.currentQ && !GS.usedQs.includes(i) && canNavigateToQ(i);
}

function nextAllowedQ(from, dir) {
  for (let step = 1; step < Qs.length; step++) {
    const i = (from + step * dir + Qs.length * 10) % Qs.length;
    if (i !== from && canNavigateToQ(i)) return i;
  }
  return from;
}

const Modal = (() => {
  let stack = [];
  return {
    show(id) {
      const el = document.getElementById(id);
      if (!el || el.classList.contains('show')) return;
      el.classList.add('show');
      if (!stack.includes(id)) stack.push(id);
    },
    hide(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('show');
      stack = stack.filter(s => s !== id);
    },
    hideAll() {
      stack.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('show');
      });
      stack = [];
    },
    isShown(id) {
      const el = document.getElementById(id);
      return el && el.classList.contains('show');
    }
  };
})();

/* ═══════════════════════════════════════
   GAME STATE
═══════════════════════════════════════ */
const GS = {
  roomId: null,
  roomToken: null,
  isHost: false,
  myName: '',
  partnerName: '',
  currentQ: 0,
  usedQs: [],
  boldUnlocked: false,
  // Timer — server-based
  timerDuration: 60,
  timerStartedAt: 0,  // DB timestamp (ms)
  timerPaused: false,
  timerPausedAt: 0,
  timerElapsedAtPause: 0,
  // Answers
  answered: false,
  revealShown: false,
  punPending: false,
  punSent: false,
  lastPun: '',
  lastEndReq: '',
  lastPauseState: -1,
  lastPostOpen: 0,
  // Stats
  myAnsweredCount: 0,
  partnerAnsweredCount: 0,
  partnerAnsweredThisQ: false,
  totalAnswered: 0,
  history: [],
  // Chat
  mainChats: [],
  lastMainLen: 0,
  postChats: [],
  lastPostLen: 0,
  // Heartbeat
  lastPartnerHb: 0,
  boldQsThisRound: 0,
  partnerOffline: false,
  punChatMsgs: [], lastPunChatLen: 0,
  reset() {
    Object.assign(this, {
      currentQ: 0, usedQs: [], boldUnlocked: false,
      timerDuration: 60, timerStartedAt: 0,
      timerPaused: false, timerPausedAt: 0, timerElapsedAtPause: 0,
      answered: false, revealShown: false, punPending: false, punSent: false,
      lastPun: '', lastEndReq: '', lastPauseState: -1, lastPostOpen: 0,
      myAnsweredCount: 0, partnerAnsweredCount: 0, partnerAnsweredThisQ: false,
      totalAnswered: 0, history: [],
      mainChats: [], lastMainLen: 0, postChats: [], lastPostLen: 0,
      lastPartnerHb: 0, boldQsThisRound: 0, partnerOffline: false
    });
  }
};

/* ═══════════════════════════════════════
   QUESTIONS
═══════════════════════════════════════ */


const catLbl = { r:'رومانسي ♥', d:'عميق ✦', b:'جريء 🔥', n:'ليلي 🌙' };
const catCls  = { r:'cat-r', d:'cat-d', b:'cat-b', n:'cat-n' };

/* ═══════════════════════════════════════
   PUNISHMENTS
═══════════════════════════════════════ */
const PUNS = {
  romantic: [
    "بوسة على الجبهة 💋","عناق لمدة دقيقة كاملة 🤗","قول جملة حب من القلب ❤️",
    "إرسال رسالة صوتية رومانسية 🎙️","تذكير بأجمل لحظة مع بعض ✨",
    "كتابة ٥ أشياء تحبها بالطرف الثاني 📝","إرسال قلب مع رسالة رومانسية 💌",
    "وعد بمفاجأة رومانسية قريباً 🎁","بوسة على الخد 😘","مسك إيد لدقيقتين 🤝",
    "تذكير بأول يوم التقيتم فيه 📅","همسة في أذنه بأجمل كلمة 🌙",
    "إرسال صورة معاً مع كلمة حلوة 📸","رسالة صباحية رومانسية غداً ☀️",
    "وصف سبب محبتك له بكل التفاصيل 💭"
  ],
  fun: [
    "تقليد صوت حيوان لمدة ١٠ ثواني 🐸","قفز على قدم وحدة ١٠ مرات 🦘",
    "قول نكتة مضحكة الآن 😂","تقليد شخصية مشهورة لـ ٣٠ ثانية 🎭",
    "رقص لمدة ٣٠ ثانية 💃","غناء مقطع من أغنية 🎤",
    "تصوير سيلفي بوجه كوميدي وإرساله 🤳","قول اسمك ١٠ مرات بسرعة 🗣️",
    "المشي على أصابع القدمين دقيقة كاملة 🦶","تقليد معلم أو أستاذ معروف 📚",
    "عد من ١٠٠ للـ ١ بثلاثينات ⏱️","الابتسام دقيقة كاملة بدون ضحك 😁",
    "تقليد صوت الريح 💨","قول ٥ كلمات بلغة ثانية 🌍",
    "عمل حركة رياضية لمدة ٢٠ ثانية 🏋️"
  ],
  hard: [
    "حظر التلفون لساعة كاملة 📵","الطرف الثاني يختار الفيلم الليلة 🎬",
    "تنفيذ طلب واحد بدون نقاش 🫡","إرسال رسالة محرجة لصديق مشترك 😅",
    "ارتداء شي محدد يختاره الطرف الثاني طوال اليوم 👔",
    "الامتناع عن الحلويات يوم كامل 🚫🍫",
    "الاستيقاظ مبكر غداً وإرسال رسالة صباحية ☀️",
    "تغيير صورة البروفايل لصورة مضحكة يوم كامل 🤪",
    "الطرف الثاني يختار اسمك ليوم 🏷️",
    "تنفيذ أي طلب للطرف الثاني لمدة ساعة ⏰",
    "إرسال رسالة اعتذار لشخص 📨","الصيام عن السوشيال ميديا يوم كامل 🔇",
    "عمل شي مفيد للطرف الثاني دون طلب 🤝",
    "الطرف الثاني يختار أكلتك الليلة 🍽️",
    "كتابة ١٠ أشياء تحبها ونشرها علناً 📣"
  ]
};

/* ═══════════════════════════════════════
   AUDIO ENGINE
═══════════════════════════════════════ */
const Audio = (() => {
  let ctx = null, musicOn = false;
  let masterGain = null;
  let musicVol = 0.35;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function getMaster(c) {
    if (!masterGain) {
      masterGain = c.createGain();
      masterGain.gain.value = musicVol;
      masterGain.connect(c.destination);
    }
    return masterGain;
  }

  function beep(freq, dur, vol = 0.3, type = 'sine') {
    try {
      const c = getCtx();
      const o = c.createOscillator();
      const g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol, c.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      o.start(c.currentTime); o.stop(c.currentTime + dur + 0.05);
    } catch (e) {}
  }

  return {
    click()   { beep(800, 0.08, 0.15); },
    reveal()  { beep(523, 0.1, 0.2); setTimeout(() => beep(659, 0.15, 0.2), 120); setTimeout(() => beep(784, 0.2, 0.2), 260); },
    tick()    { beep(1000, 0.06, 0.12); },
    punish()  { beep(200, 0.4, 0.2, 'sawtooth'); setTimeout(() => beep(150, 0.5, 0.15, 'sawtooth'), 200); },
    success() { beep(659, 0.15, 0.2); setTimeout(() => beep(784, 0.2, 0.2), 180); },
    toggle() {
      if (musicOn) {
        this._genPlaying = false;
        musicOn = false;
        if (this._genCtx) { try { this._genCtx.suspend(); } catch(e) {} }
        document.getElementById('musicFb').textContent = '🎵';
      } else {
        musicOn = true;
        this._startGenerated();
        document.getElementById('musicFb').textContent = '🔇';
      }
    },
    startAuto() {
      musicOn = true;
      this._startGenerated();
      document.getElementById('musicFb').textContent = '🔇';
    },
    _genPlaying: false,
    _genCtx: null,
    _startGenerated() {
      if (this._genPlaying) return;
      this._genPlaying = true;
      this._playGen();
    },
    _playGen() {
      if (!this._genPlaying) return;
      try {
        if (!this._genCtx) this._genCtx = new (window.AudioContext || window.webkitAudioContext)();
        const c = this._genCtx;
        if (c.state === 'suspended') c.resume();
        const master = getMaster(c);
        const melody = [
          {f:392,d:0.9},{f:440,d:0.45},{f:494,d:0.45},{f:523,d:1.2},
          {f:494,d:0.45},{f:440,d:0.45},{f:392,d:0.9},{f:349,d:1.2},
          {f:330,d:0.9},{f:349,d:0.45},{f:392,d:0.45},{f:440,d:1.2},
          {f:392,d:0.9},{f:349,d:0.45},{f:330,d:0.45},{f:294,d:1.8},
        ];
        let t = c.currentTime + 0.05;
        melody.forEach(({f,d}) => {
          const o = c.createOscillator(), g = c.createGain();
          o.connect(g); g.connect(master);
          o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.07, t + 0.06);
          g.gain.exponentialRampToValueAtTime(0.001, t + d - 0.04);
          o.start(t); o.stop(t + d);
          const o2 = c.createOscillator(), g2 = c.createGain();
          o2.connect(g2); g2.connect(master);
          o2.type = 'sine'; o2.frequency.value = f / 2;
          g2.gain.setValueAtTime(0, t);
          g2.gain.linearRampToValueAtTime(0.03, t + 0.08);
          g2.gain.exponentialRampToValueAtTime(0.001, t + d - 0.04);
          o2.start(t); o2.stop(t + d);
          t += d;
        });
        const total = melody.reduce((a,b) => a + b.d, 0);
        setTimeout(() => this._playGen(), total * 1000 - 100);
      } catch(e) {}
    },
    stop() {
      this._genPlaying = false;
      musicOn = false;
      if (this._genCtx) { try { this._genCtx.suspend(); } catch(e) {} }
    },
    setVolume(v) {
      musicVol = v;
      if (masterGain) masterGain.gain.value = v;
    },
    muteGenerated() {
      if (this._genCtx) {
        try { this._genCtx.suspend(); } catch(e) {}
      }
    },
    unmuteGenerated() {
      if (this._genCtx && this._genPlaying) {
        try { this._genCtx.resume(); } catch(e) {}
      }
    }
  };
})();

/* ═══════════════════════════════════════
   TIMER ENGINE — server-based
═══════════════════════════════════════ */
const Timer = (() => {
  let rafId = null;
  let lastSec = -1;

  function getRemaining() {
    if (GS.timerPaused) {
      return GS.timerDuration - GS.timerElapsedAtPause;
    }
    if (!GS.timerStartedAt) return GS.timerDuration;
    const elapsed = (Date.now() - GS.timerStartedAt) / 1000;
    return Math.max(0, GS.timerDuration - elapsed);
  }

  function render() {
    const rem = getRemaining();
    const sec = Math.ceil(rem);

    // Update arc
    const arc = document.getElementById('timerArc');
    const numEl = document.getElementById('timerNum');
    if (!arc || !numEl) return;

    const circumference = 2 * Math.PI * 21; // r=21 → ~132
    const offset = circumference * (1 - rem / GS.timerDuration);
    arc.style.strokeDashoffset = offset;

    // Color
    const color = rem > 20 ? 'var(--c-gold)' : rem > 10 ? 'var(--c-warning)' : 'var(--c-error)';
    arc.style.stroke = color;
    numEl.style.color = color;
    numEl.textContent = sec;

    // Stop music at last 10 seconds, tick at last 5
    if (sec !== lastSec) {
      if (sec === 10 && !GS.timerPaused) {
        Audio.setVolume(0);
        Audio.muteGenerated();
      }
      if (sec <= 5 && sec > 0 && !GS.timerPaused) {
        Audio.tick();
      }
    }
    lastSec = sec;

    // Disable input when time's up
    if (rem <= 0 && !GS.timerPaused) {
      const inp = document.getElementById('ansInp');
      const btn = document.getElementById('sendBtn');
      if (inp) inp.disabled = true;
      if (btn) btn.disabled = true;
      stop();
      return;
    }

    rafId = requestAnimationFrame(render);
  }

  function start() {
    if (rafId) cancelAnimationFrame(rafId);
    lastSec = -1;
    rafId = requestAnimationFrame(render);
  }

  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function reset(startedAt) {
    stop();
    GS.timerStartedAt = startedAt || Date.now();
    GS.timerPaused = false;
    GS.timerElapsedAtPause = 0;
    lastSec = -1;
    start();
  }

  function pause() {
    if (GS.timerPaused) return;
    GS.timerPaused = true;
    GS.timerElapsedAtPause = (Date.now() - GS.timerStartedAt) / 1000;
    stop();
    // Render paused state
    const numEl = document.getElementById('timerNum');
    if (numEl) numEl.textContent = Math.ceil(GS.timerDuration - GS.timerElapsedAtPause);
  }

  function resume(startedAt, elapsedAtPause) {
    if (!GS.timerPaused) return;
    GS.timerPaused = false;
    // Recalculate start time from elapsed
    GS.timerElapsedAtPause = elapsedAtPause || GS.timerElapsedAtPause;
    GS.timerStartedAt = Date.now() - GS.timerElapsedAtPause * 1000;
    start();
  }

  return { start, stop, reset, pause, resume, getRemaining };
})();

/* ═══════════════════════════════════════
   CHAT RENDERER
═══════════════════════════════════════ */
const Chat = (() => {
  // ── Per-channel queues; all persistent appends use the atomic server RPC. ──
  const inflight = { main: false, post: false, pun: false };
  const queues   = { main: [],    post: [],    pun: [] };
  const retryTimers = { main: null, post: null, pun: null };
  const generation = { main: 0, post: 0, pun: 0 };

  function renderTo(containerId, msgs) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    msgs.forEach(m => {
      const d = document.createElement('div');
      d.className = 'chat-msg ' + (m.sender === GS.myName ? 'mine' : 'theirs');
      d.innerHTML = `<div class="msg-name">${san(m.sender)}</div>${san(m.message)}`;
      c.appendChild(d);
    });
    c.scrollTop = c.scrollHeight;
  }

  // Merge DB array with local pending messages; use stable IDs when available.
  function mergeByTime(dbArr, localPending) {
    const key = m => m.id ? 'id|' + m.id : 'time|' + m.time + '|' + m.sender;
    const times = new Set(dbArr.map(key));
    const extra = localPending.filter(m => !times.has(key(m)));
    return [...dbArr, ...extra];
  }

  function scheduleRetry(key, dbField, getLocal, setLocal, renderId) {
    if (retryTimers[key]) return;
    retryTimers[key] = setTimeout(() => {
      retryTimers[key] = null;
      flushChannel(key, dbField, getLocal, setLocal, renderId);
    }, 3000);
  }

  // Atomic RPC is the only persistence path. Unknown failures are retried; they never
  // downgrade to a read/merge/write sequence that can overwrite the other player's chat.
  async function flushChannel(key, dbField, getLocal, setLocal, renderId) {
    if (inflight[key]) return;
    inflight[key] = true;
    const runGeneration = generation[key];
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    const isCurrentSession = () => generation[key] === runGeneration &&
      String(GS.roomId || '') === String(roomId || '') && GS.roomToken === roomToken;
    let shouldRetry = false;
    try {
      while (queues[key].length > 0) {
        if (!isCurrentSession()) break;
        const batch = queues[key].splice(0);
        if (!roomId || !roomToken) {
          if (isCurrentSession()) {
            queues[key].unshift(...batch);
            shouldRetry = true;
          }
          break;
        }

        let latestMessages = [];
        let rejected = false;
        for (const message of batch) {
          const result = await DB.rpc('append_room_message', {
            p_room_id: String(roomId),
            p_room_token: roomToken,
            p_channel: dbField,
            p_message: message
          }, { silent: true, roomToken });
          if (!isCurrentSession()) { rejected = true; break; }
          if (!result || result.ok !== true || !Array.isArray(result.messages)) {
            queues[key].unshift(...batch);
            shouldRetry = true;
            rejected = true;
            console.warn('[CHAT] atomic append unavailable or rejected; messages retained for retry');
            break;
          }
          latestMessages = result.messages;
        }
        if (rejected && !isCurrentSession()) break;
        if (rejected) break;
        if (!isCurrentSession()) break;
        const merged = mergeByTime(latestMessages, queues[key]);
        setLocal(merged);
        renderTo(renderId, merged);
      }
    } catch (e) {
      console.warn('[CHAT] flush(' + key + ') error:', e);
      shouldRetry = isCurrentSession();
    }
    inflight[key] = false;
    if (queues[key].length > 0) {
      if (!isCurrentSession()) flushChannel(key, dbField, getLocal, setLocal, renderId);
      else if (shouldRetry) scheduleRetry(key, dbField, getLocal, setLocal, renderId);
      else flushChannel(key, dbField, getLocal, setLocal, renderId);
    }
  }

  function clearChannel(key) {
    if (!Object.prototype.hasOwnProperty.call(queues, key)) return;
    generation[key] += 1;
    queues[key].length = 0;
    if (retryTimers[key]) clearTimeout(retryTimers[key]);
    retryTimers[key] = null;
  }

  function clearPending() {
    Object.keys(queues).forEach(clearChannel);
  }

  function hasPending(key) {
    return Object.prototype.hasOwnProperty.call(queues, key) &&
      (queues[key].length > 0 || inflight[key] || Boolean(retryTimers[key]));
  }

  function enqueue(key, dbField, msgData, getLocal, setLocal, renderId) {
    queues[key].push(msgData);
    // Optimistic local render immediately (shows sender's own message instantly)
    const optimistic = mergeByTime(getLocal(), queues[key]);
    renderTo(renderId, optimistic);
    flushChannel(key, dbField, getLocal, setLocal, renderId);
  }

  return {
    renderTo,
    mergeByTime,
    clearPending,
    clearChannel,
    hasPending,
    sendMain() {
      const inp = document.getElementById('chatInp');
      const msg = inp.value.trim();
      if (!msg || !GS.roomId) return;
      if (msg.length > 300) { Toast.show('الرسالة طويلة جداً (300 حرف كحد أقصى)', 'error'); return; }
      inp.value = '';
      Audio.click();
      const data = { id: genToken(), sender: GS.myName, message: msg, time: Date.now() };
      enqueue('main', 'chat_log', data,
        () => GS.mainChats,
        v  => { GS.mainChats = v; GS.lastMainLen = v.length; },
        'chatMsgs'
      );
      // Update lastMainLen immediately so poll doesn't re-render over optimistic view
      GS.lastMainLen = (GS.mainChats.length || 0) + queues.main.length;
    },
    sendPost() {
      const inp = document.getElementById('postChatInp');
      const msg = inp.value.trim();
      if (!msg || !GS.roomId) return;
      if (Game.isChangingQuestion) { Toast.show('جارٍ تثبيت السؤال الجديد؛ انتظر لحظة قبل الإرسال.', 'warning'); return; }
      if (msg.length > 300) { Toast.show('الرسالة طويلة جداً (300 حرف كحد أقصى)', 'error'); return; }
      inp.value = '';
      Audio.click();
      const data = { id: genToken(), sender: GS.myName, message: msg, time: Date.now() };
      enqueue('post', 'post_chat_log', data,
        () => GS.postChats,
        v  => { GS.postChats = v; GS.lastPostLen = v.length; },
        'postChatMsgs'
      );
      GS.lastPostLen = (GS.postChats.length || 0) + queues.post.length;
    },
    sendPunChat() {
      const inp = document.getElementById('punChatInp');
      const msg = inp.value.trim();
      if (!msg || !GS.roomId) return;
      if (Game.isChangingQuestion) { Toast.show('جارٍ تثبيت السؤال الجديد؛ انتظر لحظة قبل الإرسال.', 'warning'); return; }
      if (msg.length > 300) { Toast.show('الرسالة طويلة جداً (300 حرف كحد أقصى)', 'error'); return; }
      inp.value = '';
      Audio.click();
      const data = { id: genToken(), sender: GS.myName, message: msg, time: Date.now() };
      enqueue('pun', 'pun_chat_log', data,
        () => GS.punChatMsgs,
        v  => { GS.punChatMsgs = v; GS.lastPunChatLen = v.length; },
        'punChatMsgs'
      );
      GS.lastPunChatLen = (GS.punChatMsgs.length || 0) + queues.pun.length;
    }
  };
})();

/* ═══════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════ */
const UI = (() => {
  let nightMode = false;

  return {
    toggleNight() {
      nightMode = !nightMode;
      document.body.classList.toggle('night', nightMode);
      document.getElementById('nightFb').textContent = nightMode ? '☀️' : '🌙';
      Audio.setVolume(nightMode ? 0.2 : 0.35);
      Toast.show(nightMode ? 'وضع ليلي 🌙' : 'وضع نهاري ☀️');
    },
    toggleChat() {
      const panel = document.getElementById('chatPanel');
      const open = panel.classList.toggle('open');
      if (open) document.getElementById('chatFb').classList.remove('unread');
    },
    showCustomPun() {
      document.getElementById('customPunInp').style.display = 'block';
      document.getElementById('customSendBtn').style.display = 'block';
    },
    showPunScreen({ emoji, text, type, title, sub, showDone }) {
      document.getElementById('punBigEmoji').textContent = emoji;
      document.getElementById('punBigText').textContent = text;
      document.getElementById('punBigType').textContent = type;
      document.getElementById('punScreenTitle').textContent = title;
      document.getElementById('punScreenSub').textContent = sub;
      document.getElementById('punChatMsgs').innerHTML = '';
      const footer = document.getElementById('punScreenFooter');
      footer.innerHTML = showDone
        ? `<button class="btn btn-danger" onclick="Game.punDone()" style="width:100%">✓ تم تنفيذ العقاب</button>`
        : `<div style="font-size:0.72rem;color:rgba(245,239,226,0.28);text-align:center;padding:8px">بانتظار الطرف الثاني...</div>`;
      document.getElementById('punScreen').classList.add('show');
    },
    captureCard() {
      document.getElementById('scQ').textContent = Qs[GS.currentQ].t;
      document.getElementById('scN1').textContent = GS.myName;
      document.getElementById('scA1').textContent = document.getElementById('revMyAns').textContent;
      document.getElementById('scN2').textContent = GS.partnerName;
      document.getElementById('scA2').textContent = document.getElementById('revPartAns').textContent;
      Modal.show('scModal');
    },
    async downloadCard() {
      const card = document.querySelector('#scModal .sc-card');
      if (!card || !window.html2canvas) {
        Toast.show('تعذر حفظ الصورة', 'error');
        return;
      }
      try {
        const canvas = await html2canvas(card, { backgroundColor: '#0d0818', scale: 2 });
        const a = document.createElement('a');
        a.download = 'ana-w-anta-' + Date.now() + '.png';
        a.href = canvas.toDataURL('image/png');
        a.click();
        Toast.show('تم حفظ الصورة ✓', 'success');
      } catch (e) {
        Toast.show('تعذر حفظ الصورة', 'error');
      }
    },
    loadQ(animate = true) {
      const q = Qs[GS.currentQ];
      const card = document.getElementById('qCard');
      if (animate) {
        card.classList.remove('changing');
        void card.offsetWidth;
        card.classList.add('changing');
      }
      document.getElementById('qNum').textContent = 'السؤال ' + (GS.currentQ + 1);
      document.getElementById('qText').textContent = q.t;
      const badge = document.getElementById('catBadge');
      badge.textContent = catLbl[q.c];
      badge.className = 'cat-badge ' + catCls[q.c];
      const pct = Math.max(0.5, (GS.currentQ + 1) / Qs.length * 100);
      document.getElementById('progFill').style.width = pct + '%';
      document.getElementById('progTxt').textContent = (GS.currentQ + 1) + ' / ' + Qs.length;
      document.getElementById('myAnsDsp').innerHTML = '<span class="ans-wait">لم تجب بعد</span>';
      document.getElementById('partnerAnsDsp').innerHTML = '<span class="ans-wait">بانتظار ' + san(GS.partnerName || 'الشريك') + '...</span>';
      document.getElementById('myAnsBox').classList.remove('answered');
      document.getElementById('partnerAnsBox').classList.remove('answered');
      const inp = document.getElementById('ansInp');
      const btn = document.getElementById('sendBtn');
      inp.value = ''; inp.disabled = false; btn.disabled = false;
    }
  };
})();

/* ═══════════════════════════════════════
   SCREENS
═══════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ═══════════════════════════════════════
   APP — Navigation & Room Management
═══════════════════════════════════════ */
const App = {
  isCreating: false,
  isJoining: false,
  showCreate() {
    document.getElementById('createResult').style.display = 'none';
    showScreen('createScreen');
  },
  showJoin() {
    document.getElementById('joinError').style.display = 'none';
    showScreen('joinScreen');
  },
  async goHome() {
    if (this.isCreating || this.isJoining) {
      Toast.show('انتظر حتى تكتمل العملية الحالية', 'warning');
      return;
    }
    await Room.leave();
    Chat.clearPending();
    Session.clear();
    Poller.stop();
    Timer.stop();
    Heartbeat.stop();
    Audio.stop();
    Modal.hideAll();
    document.getElementById('chatPanel').classList.remove('open');
    document.getElementById('postChatWrap').classList.remove('show');
    document.getElementById('floatWrap').classList.remove('show');
    GS.roomId = null;
    GS.isHost = false;
    GS.reset();
    const createBtn = document.getElementById('createRoomBtn');
    const joinBtn = document.getElementById('joinRoomBtn');
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'إنشاء الغرفة ✦'; }
    if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'دخول ✦'; }
    showScreen('homeScreen');
  },
  async createRoom() {
    if (this.isCreating || GS.roomId) return;
    const name = cleanName(document.getElementById('createName').value);
    if (!name) {
      Toast.show('اكتب اسمك أولاً', 'warning');
      document.getElementById('createName').focus();
      return;
    }
    const firstQ = firstEligibleQuestion();
    if (firstQ < 0) {
      Toast.show('فئة «جريء» تُفتح بعد الإجابة على 10 أسئلة؛ اختر فئة أخرى للبدء.', 'warning', 5000);
      return;
    }
    this.isCreating = true;
    const button = document.getElementById('createRoomBtn');
    button.disabled = true;
    button.textContent = 'جارٍ إنشاء الغرفة…';
    GS.myName = name;
    GS.isHost = true;
    try {
      const code = genRoomCode();
      const hostToken = genToken();
      GS.roomToken = hostToken;
      DB.setToken(hostToken);
      const now = Date.now();
      const roomBase = {
        code, host_name: name, guest_name: null,
        host_token: hostToken, guest_token: null,
        current_q: firstQ, host_answer: null, guest_answer: null,
        status: 'waiting', chat_log: '[]', post_chat_log: '[]',
        end_request: null, pause_state: 0, punishment: null,
        post_chat_open: 0, timer_started_at: 0,
        timer_elapsed_pause: 0, pun_chat_log: '[]',
        host_heartbeat: now, guest_heartbeat: 0
      };
      let rows = await DB.ins({ ...roomBase, enabled_cats: Cats.toJSON() },
        { toast: 'تعذر إنشاء الغرفة — تحقق من الاتصال أو الصلاحيات' });
      if (!rows || !rows[0]) {
        rows = await DB.ins(roomBase, { silent: true });
      }
      let roomId = rows && rows[0] ? rows[0].id : null;
      if (!roomId) {
        await new Promise(resolve => setTimeout(resolve, 700));
        const existing = await DB.get('code', code);
        roomId = existing && existing[0] ? existing[0].id : null;
      }
      if (!roomId) {
        Toast.show('ما قدرنا ننشئ الغرفة. تأكد من الإنترنت وحاول مرة ثانية.', 'error', 5000);
        return;
      }
      GS.roomId = roomId;
      document.getElementById('roomCode').textContent = code;
      document.getElementById('createResult').style.display = 'block';
      button.textContent = 'تم إنشاء الغرفة ✓';
      Session.save(code);
      Poller.startJoin();
    } catch (error) {
      console.error('createRoom', error);
      Toast.show('حدث خطأ غير متوقع أثناء إنشاء الغرفة', 'error');
    } finally {
      this.isCreating = false;
      if (!GS.roomId) {
        DB.clearToken();
        GS.roomToken = null;
        button.disabled = false;
        button.textContent = 'إنشاء الغرفة ✦';
      }
    }
  },
  async copyCode() {
    const code = document.getElementById('roomCode').textContent.trim();
    if (!/^\d{6}$/.test(code)) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(code);
      } else {
        const field = document.createElement('textarea');
        field.value = code;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('Clipboard is unavailable');
      }
      Toast.show('تم نسخ الكود ✓', 'success');
    } catch (error) {
      Toast.show('تعذّر النسخ — انسخ هذا الكود يدويًا: ' + code, 'warning', 6000);
    }
  },
  async joinRoom() {
    if (this.isJoining || GS.roomId) return;
    const name = cleanName(document.getElementById('joinName').value);
    const codeField = document.getElementById('joinCode');
    const code = normalizeRoomCode(codeField.value);
    codeField.value = code;
    if (!name || !code) {
      Toast.show('اكتب اسمك وكود الغرفة', 'warning');
      if (!name) document.getElementById('joinName').focus();
      else codeField.focus();
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      Toast.show('كود الغرفة يجب أن يتكوّن من ٦ أرقام', 'warning');
      codeField.focus();
      return;
    }
    if (!JoinGuard.ok()) {
      Toast.show('محاولات كثيرة — انتظر دقيقة قبل المحاولة مجددًا', 'warning');
      return;
    }
    this.isJoining = true;
    const button = document.getElementById('joinRoomBtn');
    button.disabled = true;
    button.textContent = 'جارٍ التحقق…';
    document.getElementById('joinLoader').style.display = 'block';
    document.getElementById('joinError').style.display = 'none';
    GS.myName = name;
    GS.isHost = false;
    try {
      const room = await DB.rpc('join_room', { p_code: code, p_guest_name: name },
        { toast: 'تعذر الدخول — تحقق من الاتصال وحاول مرة ثانية' });
      if (!room || !room.id || !room.guest_token) {
        document.getElementById('joinError').style.display = 'block';
        document.getElementById('joinError').textContent = 'الكود غير متاح أو انتهت صلاحيته؛ راجع الكود أو اسأل المضيف.';
        GS.roomId = null;
        Session.clear();
        return;
      }
      GS.roomId = room.id;
      GS.partnerName = cleanName(room.host_name || '');
      GS.roomToken = room.guest_token;
      DB.setToken(room.guest_token);
      Cats.applyFromRoom(room);
      const startedAt = Date.now();
      room.timer_started_at = startedAt;
      room.timer_elapsed_pause = 0;
      room.pause_state = 0;
      await DB.upd(GS.roomId, { timer_started_at: startedAt, timer_elapsed_pause: 0, pause_state: 0 }, { silent: true });
      document.getElementById('joinLoader').style.display = 'none';
      Session.save(code);
      button.textContent = 'تم الاتصال ✓';
      Game.start(room);
    } catch (error) {
      console.error('joinRoom', error);
      document.getElementById('joinError').style.display = 'block';
      document.getElementById('joinError').textContent = 'تعذر الاتصال بالغرفة الآن؛ تحقق من الإنترنت وحاول مرة ثانية.';
      Session.clear();
      GS.roomId = null;
    } finally {
      this.isJoining = false;
      document.getElementById('joinLoader').style.display = 'none';
      if (!GS.roomId) {
        button.disabled = false;
        button.textContent = 'دخول ✦';
      }
    }
  }
};

/* ═══════════════════════════════════════
   GAME LOGIC
═══════════════════════════════════════ */
const Game = {
  isChangingQuestion: false,
  answerPending: false,
  pausePending: false,
  postChatPending: false,
  punishmentPending: false,
  endActionPending: false,
  resultsShowing: false,

  isStateMutationPending() {
    return this.isChangingQuestion || this.answerPending || this.pausePending ||
      this.postChatPending || this.punishmentPending || this.endActionPending || this.resultsShowing;
  },

  endRequestMarker() {
    return GS.isHost ? 'role:host' : 'role:guest';
  },

  isPartnerEndRequest(value) {
    if (!value || value === 'accepted') return false;
    const partnerRole = GS.isHost ? 'role:guest' : 'role:host';
    return value === partnerRole || (value === GS.partnerName && value !== GS.myName);
  },

  resetActionLocks() {
    this.isChangingQuestion = false;
    this.answerPending = false;
    this.pausePending = false;
    this.postChatPending = false;
    this.punishmentPending = false;
    this.endActionPending = false;
    this.resultsShowing = false;
  },

  start(roomData) {
    this.resetActionLocks();
    GS.reset();
    if (roomData) {
      const index = Number(roomData.current_q);
      GS.currentQ = Number.isInteger(index) && Qs[index] ? index : 0;
      GS.usedQs = [GS.currentQ];
      if (Qs[GS.currentQ].c === 'b') GS.boldQsThisRound = 1;
      GS.timerStartedAt = Number(roomData.timer_started_at) || Date.now();
      Cats.applyFromRoom(roomData);
    }
    this._enterGame(roomData, true);
  },

  resume(roomData) {
    this.resetActionLocks();
    if (roomData) {
      const index = Number(roomData.current_q);
      GS.currentQ = Number.isInteger(index) && Qs[index] ? index : 0;
      if (!GS.usedQs.includes(GS.currentQ)) GS.usedQs.push(GS.currentQ);
      if (Qs[GS.currentQ].c === 'b' && GS.boldQsThisRound === 0) GS.boldQsThisRound = 1;
      GS.timerStartedAt = Number(roomData.timer_started_at) || Date.now();
      GS.timerPaused = Number(roomData.pause_state) === 1;
      GS.timerElapsedAtPause = roomData.timer_elapsed_pause || 0;
      GS.lastPauseState = roomData.pause_state ?? -1;
      GS.lastPun = roomData.punishment || '';
      Cats.applyFromRoom(roomData);
      try {
        GS.mainChats = JSON.parse(roomData.chat_log || '[]');
        GS.lastMainLen = GS.mainChats.length;
        Chat.renderTo('chatMsgs', GS.mainChats);
      } catch (e) {}
      // PATCH C7: restore post and pun chat from DB on reconnect
      try {
        const postLog = JSON.parse(roomData.post_chat_log || '[]');
        if (postLog.length > 0) {
          GS.postChats = postLog; GS.lastPostLen = postLog.length;
        }
      } catch(e) {}
      try {
        const punLog = JSON.parse(roomData.pun_chat_log || '[]');
        if (punLog.length > 0) {
          GS.punChatMsgs = punLog; GS.lastPunChatLen = punLog.length;
        }
      } catch(e) {}
    }
    this._enterGame(roomData, false);
  },

  _enterGame(roomData, fresh) {
    document.getElementById('myLbl').textContent = GS.myName;
    document.getElementById('partnerLbl').textContent = GS.partnerName;
    document.getElementById('qCounter').textContent = GS.totalAnswered;
    document.getElementById('revMyName').textContent = GS.myName;
    document.getElementById('revPartName').textContent = GS.partnerName;
    showScreen('gameScreen');
    document.getElementById('floatWrap').classList.add('show');
    UI.loadQ(false);
    if (roomData) {
      const myAns = GS.isHost ? roomData.host_answer : roomData.guest_answer;
      const partnerAns = GS.isHost ? roomData.guest_answer : roomData.host_answer;
      if (myAns) {
        GS.answered = true;
        document.getElementById('myAnsDsp').textContent = myAns;
        document.getElementById('myAnsBox').classList.add('answered');
        document.getElementById('ansInp').disabled = true;
        document.getElementById('sendBtn').disabled = true;
      }
      if (partnerAns) {
        document.getElementById('partnerAnsDsp').textContent = partnerAns;
        document.getElementById('partnerAnsBox').classList.add('answered');
      }
    }
    Timer.reset(GS.timerStartedAt);
    if (GS.timerPaused) {
      Timer.pause();
      const btn = document.getElementById('pauseBtn');
      const badge = document.getElementById('pausedBadge');
      if (btn) btn.textContent = '▶ استئناف';
      if (badge) badge.style.display = 'inline';
      document.getElementById('ansInp').disabled = true;
      document.getElementById('sendBtn').disabled = true;
    }
    Poller.startGame();
    Heartbeat.start();
    Audio.startAuto();
    Session.save(Session.load()?.code || '');
  },

  async changeQ(newQ) {
    if (!Number.isInteger(newQ) || !Qs[newQ] || newQ === GS.currentQ || this.isChangingQuestion) return false;
    if (Chat.hasPending('post') || Chat.hasPending('pun')) {
      Toast.show('جارٍ حفظ رسائل هذه المرحلة؛ انتظر اكتمال الإرسال ثم تابع.', 'warning', 5000);
      return false;
    }
    const expectedQ = GS.currentQ;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    if (!roomId || !roomToken) return false;
    this.isChangingQuestion = true;
    Poller.invalidateState();
    Chat.clearChannel('post');
    Chat.clearChannel('pun');
    GS.postChats = []; GS.lastPostLen = 0;
    GS.punChatMsgs = []; GS.lastPunChatLen = 0;
    document.getElementById('postChatMsgs').innerHTML = '';
    document.getElementById('punChatMsgs').innerHTML = '';
    document.getElementById('postChatWrap').classList.remove('show');
    document.getElementById('punScreen').classList.remove('show');
    try {
      GS.currentQ = newQ;
      if (!GS.usedQs.includes(newQ)) GS.usedQs.push(newQ);
      if (Qs[newQ].c === 'b') {
        GS.boldQsThisRound++;
        if (GS.boldQsThisRound >= 2) {
          setTimeout(() => { GS.boldQsThisRound = 0; Session.save(Session.load()?.code || ''); }, 60000);
        }
      }
      Audio.setVolume(document.body.classList.contains('night') ? 0.2 : 0.35);
      Audio.unmuteGenerated();
      GS.answered = false;
      GS.revealShown = false;
      GS.punPending = false;
      GS.punSent = false;
      GS.lastPun = '';
      GS.lastPostOpen = 0;
      GS.partnerAnsweredThisQ = false;
      const now = Date.now();
      GS.timerStartedAt = now;
      GS.timerPaused = false;
      GS.timerElapsedAtPause = 0;
      UI.loadQ(true);
      Timer.reset(now);
      Audio.click();
      Modal.hide('punSelectModal');

      const saved = await DB.cas(roomId, { current_q: expectedQ, status: 'playing' }, {
        current_q: newQ,
        host_answer: null, guest_answer: null,
        punishment: null, post_chat_open: 0,
        post_chat_log: '[]', pun_chat_log: '[]',
        pause_state: 0,
        timer_started_at: now, timer_elapsed_pause: 0
      }, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!saved || !saved[0]) {
        if (sameSession) {
          Toast.show('تغيّر السؤال من الطرف الآخر أو تعذّر حفظ الانتقال؛ جارٍ مزامنة اللعبة.', 'warning', 5000);
          await Poller.refresh();
        }
        return false;
      }
      if (sameSession) {
        Session.save(Session.load()?.code || '');
      }
      return true;
    } finally {
      this.isChangingQuestion = false;
      Poller.refresh();
    }
  },
  moveQ(direction) {
    const next = nextAllowedQ(GS.currentQ, direction);
    if (next === GS.currentQ) {
      Toast.show('لا توجد أسئلة أخرى مفعّلة ضمن الفئات المختارة', 'warning');
      return;
    }
    return this.changeQ(next);
  },
  nextQ()   { this.moveQ(1); },
  prevQ()   { this.moveQ(-1); },
  randomQ() {
    const total = Qs.length;
    let pool = [];
    for (let i = 0; i < total; i++) {
      if (qAllowed(i)) pool.push(i);
    }
    if (pool.length === 0) {
      GS.usedQs = [GS.currentQ];
      for (let i = 0; i < total; i++) {
        if (qAllowed(i)) pool.push(i);
      }
      if (pool.length) Toast.show('أسئلة جديدة! 🎉', 'success');
    }
    if (pool.length === 0) {
      Toast.show('لا أسئلة متاحة بهذه الفئات', 'warning');
      return;
    }
    this.changeQ(pool[Math.floor(Math.random() * pool.length)]);
  },

  async sendAnswer() {
    const input = document.getElementById('ansInp');
    const button = document.getElementById('sendBtn');
    let ans = input.value.trim();
    if (!ans || GS.answered || this.answerPending) return false;
    if (ans.length > MAX_ANSWER_LEN) {
      ans = ans.slice(0, MAX_ANSWER_LEN);
      input.value = ans;
      Toast.show('تم اختصار الإجابة إلى ' + MAX_ANSWER_LEN + ' حرف', 'warning');
    }
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    const expectedQ = GS.currentQ;
    if (!roomId || !roomToken) return false;
    this.answerPending = true;
    Poller.invalidateState();
    try {
      GS.answered = true;
      document.getElementById('myAnsDsp').textContent = ans;
      document.getElementById('myAnsBox').classList.add('answered');
      input.disabled = true;
      button.disabled = true;
      GS.myAnsweredCount++;
      Audio.click();

      const result = await DB.rpc('submit_room_answer', {
        p_room_id: String(roomId),
        p_room_token: roomToken,
        p_question: expectedQ,
        p_answer: ans
      }, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!sameSession) return false;
      if (!result || result.ok !== true || Number(result.current_q) !== expectedQ) {
        const definitelyRejected = result && result.ok === false &&
          (result.reason === 'stale' || result.reason === 'paused');
        if (GS.currentQ === expectedQ || definitelyRejected) {
          GS.myAnsweredCount = Math.max(0, GS.myAnsweredCount - 1);
        }
        if (GS.currentQ === expectedQ) {
          GS.answered = false;
          document.getElementById('myAnsDsp').innerHTML = '<span class="ans-wait">لم تجب بعد</span>';
          document.getElementById('myAnsBox').classList.remove('answered');
          input.disabled = false;
          button.disabled = false;
        }
        await Poller.refresh();
        if (GS.currentQ === expectedQ && GS.answered) {
          input.value = '';
          return true;
        }
        if (GS.currentQ === expectedQ) {
          const canRetry = Timer.getRemaining() > 0 && !GS.timerPaused;
          input.disabled = !canRetry;
          button.disabled = !canRetry;
        }
        Toast.show('لم تُحفظ الإجابة أو تغيّر السؤال؛ تحقّق من الاتصال وحاول عند ظهور السؤال الحالي.', 'warning', 6000);
        return false;
      }
      if (GS.currentQ === expectedQ) input.value = '';
      return true;
    } finally {
      this.answerPending = false;
      Poller.refresh();
    }
  },
  async togglePause() {
    if (this.pausePending) return false;
    const btn = document.getElementById('pauseBtn');
    const badge = document.getElementById('pausedBadge');
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    const expectedQ = GS.currentQ;
    const wasPaused = GS.timerPaused;
    const expectedPause = wasPaused ? 1 : 0;
    if (!roomId || !roomToken) return false;
    this.pausePending = true;
    Poller.invalidateState();
    if (btn) btn.disabled = true;
    try {
      let patch;
      let elapsed = 0;
      let newStart = 0;
      if (!wasPaused) {
        elapsed = (Date.now() - GS.timerStartedAt) / 1000;
        patch = { pause_state: 1, timer_elapsed_pause: elapsed };
      } else {
        elapsed = GS.timerElapsedAtPause;
        newStart = Date.now() - elapsed * 1000;
        patch = { pause_state: 0, timer_started_at: newStart, timer_elapsed_pause: elapsed };
      }
      const saved = await DB.cas(roomId, {
        current_q: expectedQ, status: 'playing', pause_state: expectedPause
      }, patch, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!saved || !saved[0]) {
        if (sameSession) {
          await Poller.refresh();
          Toast.show('تغيّرت حالة المؤقت من الطرف الآخر؛ تمت مزامنة اللعبة.', 'warning');
        }
        return false;
      }
      if (!sameSession) return false;
      if (!wasPaused) {
        GS.timerElapsedAtPause = elapsed;
        Timer.pause();
        if (btn) btn.textContent = '▶ استئناف';
        if (badge) badge.style.display = 'inline';
        document.getElementById('ansInp').disabled = true;
        document.getElementById('sendBtn').disabled = true;
      } else {
        GS.timerStartedAt = newStart;
        Timer.resume(newStart, elapsed);
        if (btn) btn.textContent = '⏸ إيقاف';
        if (badge) badge.style.display = 'none';
        if (Timer.getRemaining() > 0 && !GS.answered) {
          document.getElementById('ansInp').disabled = false;
          document.getElementById('sendBtn').disabled = false;
        }
      }
      return true;
    } finally {
      this.pausePending = false;
      if (btn && String(GS.roomId || '') === String(roomId)) btn.disabled = false;
      Poller.refresh();
    }
  },
  async closeReveal() {
    if (this.postChatPending) return false;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    const expectedQ = GS.currentQ;
    if (!roomId || !roomToken) return false;
    this.postChatPending = true;
    Poller.invalidateState();
    try {
      const opened = await DB.cas(roomId, { current_q: expectedQ, status: 'playing' },
        { post_chat_open: 1 }, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!opened || !opened[0]) {
        if (sameSession) await Poller.refresh();
        return false;
      }
      if (!sameSession) return false;
      Modal.hide('revealModal');
      Audio.click();
      GS.lastPostOpen = 1;
      document.getElementById('postChatWrap').classList.add('show');
      // Opening the channel never rewrites its log; concurrent closes cannot erase a message.
      return true;
    } finally {
      this.postChatPending = false;
      Poller.refresh();
    }
  },
  async donePostChat() {
    return this.moveQ(1);
  },

  pickPun(type) {
    const list = PUNS[type];
    const txt = list[Math.floor(Math.random() * list.length)];
    this._sendPun(type, txt);
  },

  sendCustomPun() {
    const txt = document.getElementById('customPunInp').value.trim();
    if (!txt) { Toast.show('اكتب العقاب أولاً', 'warning'); return; }
    this._sendPun('custom', txt);
  },

  async _sendPun(type, txt) {
    if (this.punishmentPending) return false;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    const expectedQ = GS.currentQ;
    if (!roomId || !roomToken) return false;
    this.punishmentPending = true;
    Poller.invalidateState();
    const punJSON = JSON.stringify({ type, text: txt });
    try {
      Chat.clearChannel('pun');
      const saved = await DB.cas(roomId, {
        current_q: expectedQ, status: 'playing', punishment: null
      }, { punishment: punJSON, pun_chat_log: '[]' }, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!saved || !saved[0]) {
        if (sameSession) await Poller.refresh();
        return false;
      }
      if (!sameSession) return false;
      Modal.hide('punSelectModal');
      GS.punSent = true;
      Audio.punish();
      const emojis = { romantic:'💋', fun:'😄', hard:'😈', custom:'✏️' };
      const labels = { romantic:'رومانسي', fun:'حركي', hard:'قاسي', custom:'مخصص' };
      UI.showPunScreen({
        emoji: emojis[type] || '🎯',
        text: txt,
        type: labels[type] || '',
        title: '✓ أرسلت العقاب!',
        sub: 'بانتظار تنفيذ العقاب من الطرف الثاني...',
        showDone: false
      });
      GS.lastPun = punJSON;
      GS.punChatMsgs = []; GS.lastPunChatLen = 0;
      return true;
    } finally {
      this.punishmentPending = false;
      Poller.refresh();
    }
  },
  async punDone() {
    if (this.punishmentPending) return false;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    const expectedQ = GS.currentQ;
    const expectedPunishment = GS.lastPun;
    if (!roomId || !roomToken || !expectedPunishment || expectedPunishment === 'done') return false;
    this.punishmentPending = true;
    Poller.invalidateState();
    try {
      const saved = await DB.cas(roomId, {
        current_q: expectedQ, status: 'playing', punishment: expectedPunishment
      }, { punishment: 'done', pun_chat_log: '[]' }, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!saved || !saved[0]) {
        if (sameSession) await Poller.refresh();
        return false;
      }
      if (!sameSession) return false;
      Chat.clearChannel('pun');
      document.getElementById('punScreen').classList.remove('show');
      GS.lastPun = 'done';
      setTimeout(() => this.moveQ(1), 400);
      return true;
    } finally {
      this.punishmentPending = false;
      Poller.refresh();
    }
  },
  async requestEnd() {
    if (this.endActionPending) return false;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    if (!roomId || !roomToken) return false;
    this.endActionPending = true;
    Poller.invalidateState();
    try {
      const saved = await DB.cas(roomId, { status: 'playing', end_request: null },
        { end_request: this.endRequestMarker() }, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!saved || !saved[0]) {
        if (sameSession) await Poller.refresh();
        return false;
      }
      if (!sameSession) return false;
      Audio.click();
      Toast.show('بانتظار موافقة الطرف الثاني...', 'warning');
      return true;
    } finally {
      this.endActionPending = false;
      Poller.refresh();
    }
  },
  async acceptEnd() {
    if (this.endActionPending) return false;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    if (!roomId || !roomToken) return false;
    this.endActionPending = true;
    Poller.invalidateState();
    try {
      const requestMarker = GS.lastEndReq || (GS.isHost ? 'role:guest' : 'role:host');
      const saved = await DB.cas(roomId, { status: 'playing', end_request: requestMarker },
        { end_request: 'accepted' }, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!saved || !saved[0]) {
        if (sameSession) await Poller.refresh();
        return false;
      }
      if (!sameSession) return false;
      Modal.hide('endReqModal');
      await this.showResults();
      return true;
    } finally {
      this.endActionPending = false;
      Poller.refresh();
    }
  },
  async rejectEnd() {
    if (this.endActionPending) return false;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    if (!roomId || !roomToken) return false;
    this.endActionPending = true;
    Poller.invalidateState();
    try {
      const requestMarker = GS.lastEndReq || (GS.isHost ? 'role:guest' : 'role:host');
      const saved = await DB.cas(roomId, { status: 'playing', end_request: requestMarker },
        { end_request: null }, { silent: true, roomToken });
      const sameSession = String(GS.roomId || '') === String(roomId) && GS.roomToken === roomToken;
      if (!saved || !saved[0]) {
        if (sameSession) await Poller.refresh();
        return false;
      }
      if (!sameSession) return false;
      Modal.hide('endReqModal');
      GS.lastEndReq = '';
      Toast.show('تم الرفض — تكمل اللعبة ✦', 'success');
      return true;
    } finally {
      this.endActionPending = false;
      Poller.refresh();
    }
  },
  async showResults() {
    if (this.resultsShowing) return;
    this.resultsShowing = true;
    History.save({
      myName: GS.myName,
      partnerName: GS.partnerName,
      myScore: GS.myAnsweredCount,
      partnerScore: GS.partnerAnsweredCount,
      questions: GS.history.length
    });
    await Room.finish();
    Chat.clearPending();
    Session.clear();
    Poller.stop(); Timer.stop(); Heartbeat.stop(); Audio.stop();
    Modal.hideAll();
    document.getElementById('chatPanel').classList.remove('open');
    document.getElementById('postChatWrap').classList.remove('show');
    document.getElementById('floatWrap').classList.remove('show');
    document.getElementById('resN1').textContent = GS.myName;
    document.getElementById('resN2').textContent = GS.partnerName;
    document.getElementById('resS1').textContent = GS.myAnsweredCount;
    document.getElementById('resS2').textContent = GS.partnerAnsweredCount;
    const wrap = document.getElementById('historyWrap');
    wrap.innerHTML = '';
    GS.history.forEach(h => {
      const d = document.createElement('div');
      d.className = 'hist-item';
      d.innerHTML = `<div class="hist-q">${san(h.q)}</div><div class="hist-ans-row"><div class="hist-ans"><div class="hist-ans-name">${san(GS.myName)}</div>${san(h.myAns)}</div><div class="hist-ans"><div class="hist-ans-name">${san(GS.partnerName)}</div>${san(h.partnerAns)}</div></div>`;
      wrap.appendChild(d);
    });
    GS.roomId = null;
    showScreen('resultsScreen');
  }
};

/* ═══════════════════════════════════════
   POLLER
═══════════════════════════════════════ */
const Poller = (() => {
  let iv = null, autoSkipTm = null;
  let generation = 0, stateGeneration = 0, pollBusyGeneration = null;
  let pollErrorNotified = false, emptyReads = 0, joinTransition = false;
  let refreshRequested = false;

  function setConnection(online) {
    const dot = document.getElementById('connDot');
    const text = document.getElementById('connTxt');
    if (dot) dot.className = 'dot ' + (online ? 'connected' : 'disconnected');
    if (text) text.textContent = online ? 'متصلان' : 'جارٍ إعادة الاتصال…';
  }

  function handleMissingRoom() {
    if (document.getElementById('createScreen').classList.contains('active')) {
      document.getElementById('waitText').textContent = 'الغرفة غير متاحة؛ أنشئ غرفة جديدة أو تحقق من الاتصال.';
      return;
    }
    if (document.getElementById('gameScreen').classList.contains('active') && !GS.partnerOffline) {
      GS.partnerOffline = true;
      document.getElementById('discSub').textContent = 'لم نتمكن من العثور على الغرفة. يمكنك الانتظار أو مغادرتها.';
      Modal.show('discModal');
    }
  }

  function setAutoSkip() {
    if (autoSkipTm) clearTimeout(autoSkipTm);
    const runGeneration = generation;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    const isCurrentSession = () => generation === runGeneration &&
      String(GS.roomId || '') === String(roomId || '') && GS.roomToken === roomToken;
    autoSkipTm = setTimeout(async () => {
      const rows = await DB.get('id', roomId, { silent: true, roomToken });
      if (!isCurrentSession()) return;
      if (!rows || !rows[0]) return;
      const r = rows[0];
      if (!r.host_answer && !r.guest_answer && r.current_q === GS.currentQ) {
        Toast.show('انتقال تلقائي ⏭️', 'warning');
        Game.moveQ(1);
      }
    }, 90000);
  }

  function applyRoom(room) {
    if (!room) return;
    Cats.applyFromRoom(room);

    // ── Sync question ──
    if (Number(room.current_q) !== GS.currentQ) {
      const index = Number(room.current_q);
      GS.currentQ = Number.isInteger(index) && Qs[index] ? index : 0;
      Chat.clearChannel('post');
      Chat.clearChannel('pun');
      GS.postChats = []; GS.lastPostLen = 0;
      GS.punChatMsgs = []; GS.lastPunChatLen = 0;
      document.getElementById('postChatMsgs').innerHTML = '';
      document.getElementById('punChatMsgs').innerHTML = '';
      if (Qs[GS.currentQ].c === 'b') GS.boldQsThisRound++;
      if (!GS.usedQs.includes(GS.currentQ)) GS.usedQs.push(GS.currentQ);
      Session.save(Session.load()?.code || '');
      GS.answered = false; GS.revealShown = false;
      GS.punPending = false; GS.punSent = false;
      GS.lastPun = ''; GS.lastPostOpen = 0;
      GS.partnerAnsweredThisQ = false;
      if (autoSkipTm) { clearTimeout(autoSkipTm); autoSkipTm = null; }
      // Sync timer from DB
      GS.timerStartedAt = room.timer_started_at || Date.now();
      GS.timerPaused = room.pause_state === 1;
      GS.timerElapsedAtPause = room.timer_elapsed_pause || 0;
      UI.loadQ(true);
      if (!GS.timerPaused) Timer.reset(GS.timerStartedAt);
      Modal.hide('punSelectModal');
      document.getElementById('punScreen').classList.remove('show'); Modal.hide('revealModal');
      document.getElementById('postChatWrap').classList.remove('show');
      setAutoSkip();
      return;
    }

    if (room.timer_started_at && Number(room.timer_started_at) !== Number(GS.timerStartedAt) && room.pause_state !== 1) {
      GS.timerStartedAt = Number(room.timer_started_at);
      Timer.reset(GS.timerStartedAt);
    }

    // ── Sync pause ──
    if (room.pause_state !== GS.lastPauseState) {
      GS.lastPauseState = room.pause_state;
      const btn = document.getElementById('pauseBtn');
      const badge = document.getElementById('pausedBadge');
      if (room.pause_state === 1 && !GS.timerPaused) {
        GS.timerElapsedAtPause = room.timer_elapsed_pause || 0;
        Timer.pause();
        if (btn) btn.textContent = '▶ استئناف';
        if (badge) badge.style.display = 'inline';
        document.getElementById('ansInp').disabled = true;
        document.getElementById('sendBtn').disabled = true;
        Toast.show('تم إيقاف الوقت ⏸', 'warning');
      } else if (room.pause_state === 0 && GS.timerPaused) {
        const newStart = room.timer_started_at || (Date.now() - GS.timerElapsedAtPause * 1000);
        GS.timerStartedAt = newStart;
        Timer.resume(newStart, room.timer_elapsed_pause || 0);
        if (btn) btn.textContent = '⏸ إيقاف';
        if (badge) badge.style.display = 'none';
        if (Timer.getRemaining() > 0 && !GS.answered) {
          document.getElementById('ansInp').disabled = false;
          document.getElementById('sendBtn').disabled = false;
        }
        Toast.show('استُؤنفت اللعبة ▶', 'success');
      }
    }

    // ── Answers ──
    const partnerAns = GS.isHost ? room.guest_answer : room.host_answer;
    const myAns      = GS.isHost ? room.host_answer  : room.guest_answer;

    if (myAns) {
      if (!GS.answered) {
        GS.answered = true;
        GS.myAnsweredCount++;
      }
      const myAnswerDisplay = document.getElementById('myAnsDsp');
      if (myAnswerDisplay) myAnswerDisplay.textContent = myAns;
      document.getElementById('myAnsBox').classList.add('answered');
      document.getElementById('ansInp').disabled = true;
      document.getElementById('sendBtn').disabled = true;
    }

    if (partnerAns) {
      if (!GS.partnerAnsweredThisQ) {
        GS.partnerAnsweredThisQ = true;
        GS.partnerAnsweredCount++;
      }
      if (document.getElementById('partnerAnsDsp').querySelector('.ans-wait')) {
        document.getElementById('partnerAnsDsp').textContent = partnerAns;
        document.getElementById('partnerAnsBox').classList.add('answered');
      }
    }

    // Stop timer when both answered
    if (myAns && partnerAns) Timer.stop();

    // ── Reveal ──
    if (myAns && partnerAns && !GS.revealShown && !Modal.isShown('revealModal') && !document.getElementById('punScreen').classList.contains('show') && !Modal.isShown('punSelectModal')) {
      GS.revealShown = true;
      document.getElementById('revMyAns').textContent = myAns;
      document.getElementById('revPartAns').textContent = partnerAns;
      Modal.show('revealModal');
      Audio.reveal();
      GS.totalAnswered++;
      document.getElementById('qCounter').textContent = GS.totalAnswered;
      GS.history.push({ q: Qs[GS.currentQ].t, myAns, partnerAns });
      if (GS.totalAnswered >= 10) {
        GS.boldUnlocked = true;
        let enabledCats = [];
        try { enabledCats = JSON.parse(room.enabled_cats || '[]'); } catch (e) {}
        if (Array.isArray(enabledCats) && !enabledCats.includes('u')) {
          DB.upd(GS.roomId, { enabled_cats: Cats.toJSON() }, { silent: true });
        }
      }
      if (GS.totalAnswered === 10) Toast.show('🔥 الأسئلة الجريئة انفتحت!', 'success', 4000);
      Session.save(Session.load()?.code || '');
    }

    // ── Punishment trigger ──
    const rem = Timer.getRemaining();
    if (rem <= 0 && myAns && !partnerAns && !GS.punPending && !GS.punSent && !Modal.isShown('punSelectModal')) {
      GS.punPending = true;
      Modal.show('punSelectModal');
      Audio.punish();
    }

    // ── Punishment from DB ──
    if (room.punishment && room.punishment !== GS.lastPun && room.punishment !== 'done') {
      GS.lastPun = room.punishment;
      try {
        const p = JSON.parse(room.punishment);
        const emojis = { romantic:'💋', fun:'😄', hard:'😈', custom:'✏️' };
        const labels = { romantic:'رومانسي', fun:'حركي', hard:'قاسي', custom:'مخصص' };
        const isReceiver = !myAns && partnerAns;
        // Show punScreen to both, but only receiver gets "done" button
        // PATCH C4: only reset pun chat if DB confirms it's empty;
        // don't blindly wipe local messages that haven't synced yet.
        const dbPunChat = (() => { try { return JSON.parse(room.pun_chat_log || '[]'); } catch(e) { return []; } })();
        if (dbPunChat.length === 0) {
          GS.punChatMsgs = []; GS.lastPunChatLen = 0;
        } else {
          GS.punChatMsgs = Chat.mergeByTime(dbPunChat, GS.punChatMsgs);
          GS.lastPunChatLen = GS.punChatMsgs.length;
        }
        UI.showPunScreen({
          emoji: emojis[p.type] || '🎯',
          text: p.text,
          type: labels[p.type] || '',
          title: isReceiver ? '⚔️ عقابك هو!' : '✓ تم الإرسال — بانتظار التنفيذ',
          sub: isReceiver ? 'نفذ العقاب واضغط "تم" عند انتهائك' : 'الطرف الثاني ينفذ العقاب...',
          showDone: isReceiver
        });
        Audio.punish();
      } catch (e) {}
    }
    // Sync pun chat
    if (room.pun_chat_log && document.getElementById('punScreen').classList.contains('show')) {
      try {
        const pc = JSON.parse(room.pun_chat_log);
        // PATCH C5: use length+boundary-times fingerprint, not length alone
        const pcFp = pc.length + '|' + (pc[0]?.time || 0) + '|' + (pc[pc.length-1]?.time || 0);
        const localFp = GS.lastPunChatLen + '|' + (GS.punChatMsgs[0]?.time || 0) + '|' + (GS.punChatMsgs[GS.punChatMsgs.length-1]?.time || 0);
        if (pcFp !== localFp) {
          // Merge DB with any locally queued messages not yet written
          const merged = Chat.mergeByTime(pc, GS.punChatMsgs.filter(m => !pc.find(d => d.time === m.time && d.sender === m.sender)));
          GS.lastPunChatLen = merged.length; GS.punChatMsgs = merged;
          Chat.renderTo('punChatMsgs', merged);
        }
      } catch(e) {}
    }
    if (room.punishment === 'done' && GS.lastPun !== 'done') {
      GS.lastPun = 'done';
      document.getElementById('punScreen').classList.remove('show');
    }

    // ── Post chat sync ──
    if (room.post_chat_open === 1 && GS.lastPostOpen !== 1) {
      GS.lastPostOpen = 1;
      const pcWrap = document.getElementById('postChatWrap');
      const punScreen = document.getElementById('punScreen');
      // Open if reveal is closed AND punishment screen is closed AND not already open
      if (!pcWrap.classList.contains('show') && !Modal.isShown('revealModal') && !punScreen.classList.contains('show')) {
        GS.postChats = []; GS.lastPostLen = 0;
        document.getElementById('postChatMsgs').innerHTML = '';
        pcWrap.classList.add('show');
      }
    } else if (room.post_chat_open === 0 && GS.lastPostOpen === 1) {
      GS.lastPostOpen = 0;
      document.getElementById('postChatWrap').classList.remove('show');
    }
    if (room.post_chat_log && document.getElementById('postChatWrap').classList.contains('show')) {
      try {
        const pc = JSON.parse(room.post_chat_log);
        // PATCH C5: fingerprint instead of length-only
        const pcFp = pc.length + '|' + (pc[0]?.time || 0) + '|' + (pc[pc.length-1]?.time || 0);
        const localFp = GS.lastPostLen + '|' + (GS.postChats[0]?.time || 0) + '|' + (GS.postChats[GS.postChats.length-1]?.time || 0);
        if (pcFp !== localFp) {
          const merged = Chat.mergeByTime(pc, GS.postChats.filter(m => !pc.find(d => d.time === m.time && d.sender === m.sender)));
          GS.lastPostLen = merged.length; GS.postChats = merged;
          Chat.renderTo('postChatMsgs', merged);
        }
      } catch (e) {}
    }

    // ── Main chat ──
    if (room.chat_log) {
      try {
        const chats = JSON.parse(room.chat_log);
        // PATCH C5: fingerprint instead of length-only
        const cFp = chats.length + '|' + (chats[0]?.time || 0) + '|' + (chats[chats.length-1]?.time || 0);
        const localFp = GS.lastMainLen + '|' + (GS.mainChats[0]?.time || 0) + '|' + (GS.mainChats[GS.mainChats.length-1]?.time || 0);
        if (cFp !== localFp) {
          const merged = Chat.mergeByTime(chats, GS.mainChats.filter(m => !chats.find(d => d.time === m.time && d.sender === m.sender)));
          GS.lastMainLen = merged.length; GS.mainChats = merged;
          Chat.renderTo('chatMsgs', merged);
          if (!document.getElementById('chatPanel').classList.contains('open')) {
            document.getElementById('chatFb').classList.add('unread');
          }
        }
      } catch (e) {}
    }

    // ── End request ──
    if (Game.isPartnerEndRequest(room.end_request) && room.end_request !== GS.lastEndReq) {
      GS.lastEndReq = room.end_request;
      document.getElementById('endReqSub').textContent = GS.partnerName + ' يطلب إنهاء اللعبة — هل توافق؟';
      Modal.show('endReqModal');
    }
    if (room.end_request === 'accepted') Game.showResults();

    // ── Heartbeat / disconnect ──
    const partnerHb = Number(GS.isHost ? room.guest_heartbeat : room.host_heartbeat);
    const partnerStale = room.status === 'playing' && (!Number.isFinite(partnerHb) || partnerHb <= 0 || Date.now() - partnerHb > 150000);
    if (partnerStale && !GS.partnerOffline) {
      GS.partnerOffline = true;
      document.getElementById('discSub').textContent = 'ما وصلنا تحديث من ' + (GS.partnerName || 'الشريك') + ' منذ فترة؛ سنواصل محاولة الاتصال.';
      Modal.show('discModal');
    } else if (!partnerStale && GS.partnerOffline) {
      GS.partnerOffline = false;
      Modal.hide('discModal');
      Toast.show('عاد اتصال الشريك ✦', 'success');
    }
  }

  function invalidateState() {
    stateGeneration += 1;
  }

  function refresh() {
    if (!GS.roomId) return Promise.resolve(false);
    if (Game.isStateMutationPending() || pollBusyGeneration === generation) {
      refreshRequested = true;
      return Promise.resolve(false);
    }
    refreshRequested = false;
    return poll();
  }

  async function poll() {
    if (!GS.roomId || Game.isStateMutationPending()) return;
    const runGeneration = generation;
    const runStateGeneration = stateGeneration;
    const roomId = GS.roomId;
    const roomToken = GS.roomToken;
    const isCurrentSession = () => generation === runGeneration &&
      String(GS.roomId || '') === String(roomId || '') && GS.roomToken === roomToken;
    const isCurrentState = () => stateGeneration === runStateGeneration && !Game.isStateMutationPending();
    if (pollBusyGeneration === runGeneration) return;
    pollBusyGeneration = runGeneration;
    try {
      const result = await DB.getStatus('id', roomId, roomToken);
      if (!isCurrentSession() || !isCurrentState()) return;
      if (!result.ok) {
        if (!pollErrorNotified) {
          pollErrorNotified = true;
          setConnection(false);
          Toast.show('انقطع تحديث الغرفة مؤقتًا؛ نحاول إعادة الاتصال تلقائيًا.', 'warning', 5000);
        }
        return;
      }
      if (pollErrorNotified) {
        pollErrorNotified = false;
        setConnection(true);
        Toast.show('عاد اتصال اللعبة ✦', 'success');
      } else {
        setConnection(true);
      }
      const rows = result.rows;
      if (!rows || !rows[0]) {
        emptyReads++;
        if (emptyReads >= 2) handleMissingRoom();
        return;
      }
      emptyReads = 0;
      const room = rows[0];
      if (GS.isHost && document.getElementById('createScreen').classList.contains('active')) {
        await onJoinUpdate(room, isCurrentSession);
        return;
      }
      applyRoom(room);
    } catch (error) {
      if (isCurrentSession() && isCurrentState() && !pollErrorNotified) {
        pollErrorNotified = true;
        setConnection(false);
        Toast.show('تعذر تحديث الغرفة؛ سنحاول مجددًا تلقائيًا.', 'warning', 5000);
      }
    } finally {
      if (pollBusyGeneration === runGeneration) pollBusyGeneration = null;
      if (refreshRequested && GS.roomId && !Game.isStateMutationPending()) {
        refreshRequested = false;
        setTimeout(() => refresh(), 0);
      }
    }
  }

  async function onJoinUpdate(room, isCurrentSession) {
    if (!room || !room.guest_name || joinTransition) return;
    joinTransition = true;
    GS.partnerName = cleanName(room.guest_name);
    document.getElementById('waitText').textContent = GS.partnerName + ' انضم! 🎉';
    document.getElementById('waitDot').className = 'dot connected';
    if (iv) { clearInterval(iv); iv = null; }
    const startedAt = Date.now();
    try {
      await DB.upd(GS.roomId, {
        host_answer: null, guest_answer: null,
        pause_state: 0, timer_started_at: startedAt, timer_elapsed_pause: 0,
        post_chat_open: 0
      }, { silent: true });
      if (!isCurrentSession()) return;
      room.host_answer = null;
      room.guest_answer = null;
      room.pause_state = 0;
      room.timer_started_at = startedAt;
      room.timer_elapsed_pause = 0;
      room.status = 'playing';
    } finally {
      if (isCurrentSession()) setTimeout(() => {
        if (isCurrentSession()) Game.start(room);
      }, 250);
    }
  }

  return {
    startJoin() {
      generation += 1;
      if (iv) clearInterval(iv);
      pollErrorNotified = false; emptyReads = 0; joinTransition = false; refreshRequested = false;
      poll();
      iv = setInterval(poll, 2500);
    },
    startGame() {
      generation += 1;
      if (iv) clearInterval(iv);
      pollErrorNotified = false; emptyReads = 0; refreshRequested = false;
      poll();
      iv = setInterval(poll, 2500);
      setAutoSkip();
    },
    invalidateState,
    refresh,
    stop() {
      generation += 1;
      if (iv) { clearInterval(iv); iv = null; }
      if (autoSkipTm) { clearTimeout(autoSkipTm); autoSkipTm = null; }
      pollErrorNotified = false; emptyReads = 0; joinTransition = false; refreshRequested = false;
    }
  };
})();

/* ═══════════════════════════════════════
   HEARTBEAT
═══════════════════════════════════════ */
const Heartbeat = (() => {
  let iv = null;
  return {
    start() {
      if (iv) clearInterval(iv);
      const send = () => {
        const f = GS.isHost ? { host_heartbeat: Date.now() } : { guest_heartbeat: Date.now() };
        DB.upd(GS.roomId, f);
      };
      send();
      iv = setInterval(send, 8000);
    },
    stop() { if (iv) { clearInterval(iv); iv = null; } }
  };
})();

/* ═══════════════════════════════════════
   PAGE UNLOAD
═══════════════════════════════════════ */
window.addEventListener('beforeunload', () => {
  if (GS.roomId) {
    const f = GS.isHost ? { host_heartbeat: 0 } : { guest_heartbeat: 0 };
    DB.patchKeepalive(GS.roomId, f);
  }
});

/* ═══════════════════════════════════════
   VISIBILITY — موبايل: تبديل التطبيقات
═══════════════════════════════════════ */
document.addEventListener('visibilitychange', () => {
  if (!GS.roomId) return;
  if (document.hidden) {
    Heartbeat.stop();
    const f = GS.isHost ? { host_heartbeat: 0 } : { guest_heartbeat: 0 };
    DB.patchKeepalive(GS.roomId, f);
  } else {
    const isPlaying = document.querySelector('.game-screen.active');
    if (isPlaying) {
      Heartbeat.start();
      Poller.refresh();
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const codeInput = document.getElementById('joinCode');
  if (codeInput) codeInput.addEventListener('input', () => {
    const normalized = normalizeRoomCode(codeInput.value);
    if (codeInput.value !== normalized) codeInput.value = normalized;
  });
  const sub = document.getElementById('homeSub');
  if (sub) sub.textContent = Qs.length + ' سؤال · للمرتبطين';
  Cats.syncUI();
  Intro.maybeShow();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});

/* Keyboard fix for mobile */
window.addEventListener('resize', () => {
  const gb = document.querySelector('.game-body');
  if (gb) gb.scrollTop = gb.scrollHeight;
});
