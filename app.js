/* ==========================================================================
   Life RPG — app.js
   Single-file app logic: storage, state, rendering, handlers, scheduling.
   ========================================================================== */

/* ----------------------------- Utilities --------------------------------- */

const $$ = (sel, root = document) => root.querySelector(sel);
const $$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmtInt = (n) => (n || 0).toString();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const toISO = (d) => new Date(d).toISOString();
const fromISO = (s) => (s ? new Date(s) : null);
const todayStr = (d = new Date()) => {
  const dt = new Date(d);
  dt.setHours(0,0,0,0);
  return `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`;
};
const ymd = (d) => todayStr(d);
const startOfWeek = (date, weekStart='Mon') => {
  const d = new Date(date); d.setHours(0,0,0,0);
  const day = d.getDay(); // 0 Sun - 6 Sat
  const shift = weekStart === 'Mon' ? (day === 0 ? 6 : day - 1) : day; // 0 if Sun-weekstart on Sun
  d.setDate(d.getDate() - shift);
  return todayStr(d);
};
const weekOf = (d, weekStart) => startOfWeek(d, weekStart);
const uid = (prefix='id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;

const isSameDay = (a, b) => todayStr(a) === todayStr(b);
const isAfter = (a, b) => new Date(a).getTime() > new Date(b).getTime();
const inRange = (d, start, end) => {
  const t = new Date(d).getTime();
  return t >= new Date(start).getTime() && t <= new Date(end).getTime();
};

const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ----------------------------- DB Wrapper -------------------------------- */

const DB_NAME = 'lifeRPG';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // Stores
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('habits')) db.createObjectStore('habits', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('habitLogs')) db.createObjectStore('habitLogs', { keyPath: 'id' }); // id = `${habitId}|${date}`
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('questLibrary')) db.createObjectStore('questLibrary', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assignedQuests')) db.createObjectStore('assignedQuests', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('daySummaries')) db.createObjectStore('daySummaries', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('completionLogs')) db.createObjectStore('completionLogs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode='readonly') {
  const db = await openDB();
  const t = db.transaction(store, mode);
  return { store: t.objectStore(store), done: new Promise((res, rej) => {
    t.oncomplete = () => res(true);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Tx aborted'));
  })};
}

const db = {
  async get(store, key) { const {store: s} = await tx(store); return await reqProm(s.get(key)); },
  async set(store, value) { const {store: s, done} = await tx(store, 'readwrite'); s.put(value); return done; },
  async del(store, key) { const {store: s, done} = await tx(store, 'readwrite'); s.delete(key); return done; },
  async add(store, value) { const {store: s, done} = await tx(store, 'readwrite'); s.add(value); return done; },
  async all(store) { const {store: s} = await tx(store); return await reqProm(s.getAll()); },
  async bulkPut(store, values) { const {store: s, done} = await tx(store, 'readwrite'); values.forEach(v => s.put(v)); return done; },
  async bulkDel(store, keys) { const {store: s, done} = await tx(store, 'readwrite'); keys.forEach(k => s.delete(k)); return done; }
};

function reqProm(request) {
  return new Promise((res, rej) => {
    request.onsuccess = () => res(request.result);
    request.onerror = () => rej(request.error);
  });
}

/* ----------------------------- App State --------------------------------- */

const DefaultSettings = {
  id: 'settings',
  dailyGoal: 100,
  dailyQuestCount: 3,
  weekStart: 'Mon',
  weeklyQuestMode: 'fixed', // 'fixed' | 'range'
  weeklyQuestCount: 3,
  weeklyQuestMin: 2,
  weeklyQuestMax: 4,
  weeklyFactor: 1.5
};

const DefaultMeta = {
  id: 'meta',
  streak: 0,
  bestStreak: 0,
  lastAssignmentRun: null, // 'YYYY-MM-DD' last day rolled
  lastWeekStart: null      // 'YYYY-MM-DD' monday/sunday start last assigned
};

const AppState = {
  settings: null,
  meta: null,
  tasks: [],
  habits: [],
  habitLogs: [],
  events: [],
  questLibrary: [],
  assignedQuests: [],
  daySummaries: [],
  completionLogs: [],

  // derived caches (not stored)
  today: todayStr(),
  currentMonth: new Date()
};

/* --------------------------- Boot & Hydration ---------------------------- */

async function boot() {
  await openDB();

  // Settings
  let settings = await db.get('settings', 'settings');
  if (!settings) {
    settings = structuredClone(DefaultSettings);
    await db.set('settings', settings);
  }
  AppState.settings = settings;

  // Meta
  let meta = await db.get('meta', 'meta');
  if (!meta) {
    meta = structuredClone(DefaultMeta);
    await db.set('meta', meta);
  }
  AppState.meta = meta;

  // Collections
  [AppState.tasks, AppState.habits, AppState.habitLogs, AppState.events, AppState.questLibrary,
   AppState.assignedQuests, AppState.daySummaries, AppState.completionLogs] = await Promise.all([
    db.all('tasks'), db.all('habits'), db.all('habitLogs'), db.all('events'),
    db.all('questLibrary'), db.all('assignedQuests'), db.all('daySummaries'), db.all('completionLogs')
  ]);

  // Rollover and assignments if needed
  await ensureRollover();

  // Initial render & listeners
  route();
  bindGlobalHandlers();
  tickMidnightWatcher();
}

/* ------------------------- Points & Summaries ---------------------------- */

// Compute total points for a specific date (YYYY-MM-DD)
function computeDayTotals(dateStr) {
  const settings = AppState.settings;
  const dateStart = new Date(dateStr + 'T00:00:00');
  const dateEnd = new Date(dateStr + 'T23:59:59.999');

  let total = 0;

  // Tasks
  for (const t of AppState.tasks) {
    if (!t.completedAt) continue;
    const comp = new Date(t.completedAt);
    if (comp >= dateStart && comp <= dateEnd) {
      // Overdue logic: if dueDate exists and comp > dueDate => 0 points
      if (t.dueDate) {
        const due = new Date(t.dueDate);
        if (comp.getTime() <= due.getTime()) total += (t.points || 0);
        // else 0 points (closure only)
      } else {
        total += (t.points || 0);
      }
    }
  }

  // Habits (partial allowed)
  const dayIdx = new Date(dateStr).getDay();
  const weekday = weekdays[dayIdx];
  const todaysHabitLogs = AppState.habitLogs.filter(h => h.date === dateStr);
  for (const log of todaysHabitLogs) {
    const habit = AppState.habits.find(h => h.id === log.habitId);
    if (!habit) continue;
    if (!habit.schedule.includes(weekday)) continue;
    const pts = habit.type === 'binary'
      ? (log.count >= 1 ? (habit.points || 0) : 0)
      : Math.floor(clamp((log.count || 0), 0, habit.target || 1) / (habit.target || 1) * (habit.points || 0));
    total += pts;
  }

  // Events (optional points)
  for (const ev of AppState.events) {
    if (!ev.pointsEnabled || !ev.completedAt) continue;
    const comp = new Date(ev.completedAt);
    if (comp >= dateStart && comp <= dateEnd) {
      total += (ev.points || 0);
    }
  }

  // Quests (assigned daily/weekly)
  for (const aq of AppState.assignedQuests) {
    if (!aq.completedAt) continue;
    const comp = new Date(aq.completedAt);
    if (comp >= dateStart && comp <= dateEnd) {
      const lib = AppState.questLibrary.find(q => q.id === aq.libraryId);
      if (!lib) continue;
      const base = lib.basePoints || 0;
      total += Math.floor(base * (aq.multiplier || 1));
    }
  }

  const goalMet = total >= (settings.dailyGoal || 0);

  return { date: dateStr, totalPoints: total, goalMet };
}

// Recompute & persist day summary
async function upsertDaySummary(dateStr) {
  const sum = computeDayTotals(dateStr);
  await db.set('daySummaries', sum);
  const idx = AppState.daySummaries.findIndex(d => d.date === dateStr);
  if (idx >= 0) AppState.daySummaries[idx] = sum; else AppState.daySummaries.push(sum);
  return sum;
}

// Whether all scheduled habits fully complete for streak eligibility
function allScheduledHabitsComplete(dateStr) {
  const d = new Date(dateStr);
  const weekday = weekdays[d.getDay()];
  const todays = AppState.habits.filter(h => h.schedule.includes(weekday));
  if (todays.length === 0) return true; // If none scheduled, treat as true (streak depends only on meeting goal)
  for (const h of todays) {
    const log = AppState.habitLogs.find(l => l.habitId === h.id && l.date === dateStr);
    if (!log) return false;
    if (h.type === 'binary') { if ((log.count || 0) < 1) return false; }
    else { if ((log.count || 0) < (h.target || 1)) return false; }
  }
  return true;
}

/* --------------------------- Assignment Logic ---------------------------- */

function randomSample(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function assignDailyQuests(dateStr) {
  const N = AppState.settings.dailyQuestCount || 0;
  const pool = AppState.questLibrary.filter(q => q.active);
  const chosen = randomSample(pool, Math.min(N, pool.length));
  const created = [];
  for (const q of chosen) {
    created.push({
      id: uid('aq'),
      libraryId: q.id,
      type: 'daily',
      date: dateStr,
      weekOf: null,
      multiplier: 1.0,
      completedAt: null
    });
  }
  if (created.length) {
    await db.bulkPut('assignedQuests', created);
    AppState.assignedQuests.push(...created);
  }
}

async function assignWeeklyQuests(weekStartStr) {
  const s = AppState.settings;
  const pool = AppState.questLibrary.filter(q => q.active);
  const count = s.weeklyQuestMode === 'range'
    ? Math.max(0, Math.floor(Math.random() * (s.weeklyQuestMax - s.weeklyQuestMin + 1)) + s.weeklyQuestMin)
    : (s.weeklyQuestCount || 0);
  const chosen = randomSample(pool, Math.min(count, pool.length));
  const created = chosen.map(q => ({
    id: uid('aq'),
    libraryId: q.id,
    type: 'weekly',
    date: null,
    weekOf: weekStartStr,
    multiplier: s.weeklyFactor || 1,
    completedAt: null
  }));
  if (created.length) {
    await db.bulkPut('assignedQuests', created);
    AppState.assignedQuests.push(...created);
  }
}

/* ----------------------------- Rollover ---------------------------------- */

async function ensureRollover() {
  const today = todayStr();
  const meta = AppState.meta;
  const settings = AppState.settings;

  // If first run ever
  if (!meta.lastAssignmentRun) {
    // Assign today's daily & this week's weekly
    await assignDailyQuests(today);
    const ws = weekOf(new Date(today), settings.weekStart);
    await assignWeeklyQuests(ws);
    meta.lastAssignmentRun = today;
    meta.lastWeekStart = ws;
    await db.set('meta', meta);
    AppState.meta = meta;
    await upsertDaySummary(today);
    return;
  }

  // If day changed since last run
  if (meta.lastAssignmentRun !== today) {
    const prev = meta.lastAssignmentRun;
    // Finalize yesterday: compute summary, update streak
    const sum = await upsertDaySummary(prev);

    // Update streak: only if goal met AND all scheduled habits fully complete
    if (sum.goalMet && allScheduledHabitsComplete(prev)) {
      meta.streak = (meta.streak || 0) + 1;
      if (meta.streak > (meta.bestStreak || 0)) meta.bestStreak = meta.streak;
    } else {
      meta.streak = 0;
    }

    // Assign today
    await assignDailyQuests(today);

    // Recompute today summary baseline (in case there's carry-over state like events)
    await upsertDaySummary(today);

    // Weekly check
    const lastWeek = meta.lastWeekStart || weekOf(new Date(prev), settings.weekStart);
    const currentWeek = weekOf(new Date(today), settings.weekStart);
    if (currentWeek !== lastWeek) {
      await assignWeeklyQuests(currentWeek);
      meta.lastWeekStart = currentWeek;
    }

    meta.lastAssignmentRun = today;
    await db.set('meta', meta);
    AppState.meta = meta;
  } else {
    // Same day; still update today's summary to reflect any existing data
    await upsertDaySummary(today);
  }
}

/* --------------------------- Router & Render ----------------------------- */

function route() {
  const hash = location.hash.replace('#','') || 'home';
  $$$('.tabbar a').forEach(a => a.classList.toggle('active', a.getAttribute('data-tab') === hash));
  switch (hash) {
    case 'home': renderHome(); break;
    case 'calendar': renderCalendar(); break;
    case 'stats': renderStats(); break;
    case 'settings': renderSettings(); break;
    default: location.hash = '#home';
  }
  updateKPI();
}

function updateKPI() {
  const today = todayStr();
  const sum = AppState.daySummaries.find(d => d.date === today) || computeDayTotals(today);
  $('#kpi-today-points').textContent = fmtInt(sum.totalPoints);
  $('#kpi-goal').textContent = fmtInt(AppState.settings.dailyGoal || 0);
  const pct = clamp(Math.round((sum.totalPoints / (AppState.settings.dailyGoal || 1)) * 100), 0, 100);
  $('#progress-fill').style.width = pct + '%';
  const pb = $('.progress-track');
  pb.setAttribute('aria-valuenow', String(pct));
  $('#streak-count').textContent = fmtInt(AppState.meta.streak || 0);
}
function $(sel, root=document){ return root.querySelector(sel); }

/* ----------------------------- Render: Home ------------------------------ */

function renderHome() {
  const root = $('#view');
  const html = `
    ${renderSectionTasks()}
    ${renderSectionHabits()}
    ${renderSectionQuestsDaily()}
    ${renderSectionQuestsWeekly()}
    ${renderCompletedToday()}
  `;
  root.innerHTML = html;
}

function renderSectionTasks() {
  const today = todayStr();
  const now = new Date();
  const tasks = [...AppState.tasks];

  // Categorize
  const overdue = tasks.filter(t => t.dueDate && fromISO(t.dueDate) < now && !t.completedAt);
  const dueToday = tasks.filter(t => t.dueDate && todayStr(t.dueDate) === today && !t.completedAt);
  const noDue = tasks.filter(t => !t.dueDate && !t.completedAt);
  const future = tasks.filter(t => t.dueDate && fromISO(t.dueDate) > now && !t.completedAt);

  const renderItem = (t) => {
    const dueBadge = t.dueDate ? `<span class="badge">${monthNames[new Date(t.dueDate).getMonth()]} ${new Date(t.dueDate).getDate()}</span>` : `<span class="badge">No due</span>`;
    const pts = `<span class="pill">${t.points || 0} pts</span>`;
    const isDone = !!t.completedAt;
    const overdueDone = isDone && t.dueDate && isAfter(t.completedAt, t.dueDate);
    const pillCls = isDone ? 'pill is-green' : (t.dueDate && fromISO(t.dueDate) < new Date() ? 'pill is-red' : 'pill');
    const ptsText = isDone ? (overdueDone ? '0 pts (overdue)' : `${t.points || 0} pts`) : `${t.points || 0} pts`;
    return `
      <div class="item" data-type="task" data-id="${t.id}">
        <div class="item-left">
          <div class="item-title">${escapeHtml(t.title)}</div>
          <div class="item-meta">${dueBadge} ${pts}</div>
        </div>
        <div class="item-right">
          <button class="${pillCls}" data-action="task-toggle" data-id="${t.id}" aria-pressed="${isDone}">
            ${isDone ? 'Completed' : 'Mark done'} • ${ptsText}
          </button>
          <button class="btn btn--ghost" data-action="task-edit" data-id="${t.id}">Edit</button>
          <button class="btn btn--danger" data-action="task-delete" data-id="${t.id}">Delete</button>
        </div>
      </div>
    `;
  };

  const block = (title, arr) => `
    <section class="section tilt-hover">
      <div class="section-header">
        <div>
          <div class="section-title">${title}</div>
          <div class="section-sub">${arr.length} item${arr.length!==1?'s':''}</div>
        </div>
        <div class="section-actions">
          <button class="btn btn--primary" data-action="task-add">+ Task</button>
        </div>
      </div>
      <div class="section-body">
        ${arr.length ? arr.map(renderItem).join('') : `<div class="muted" style="padding:8px 10px;">No items</div>`}
      </div>
    </section>
  `;

  return `
    ${block('Overdue', overdue)}
    ${block('Due Today', dueToday)}
    ${block('No Due Date', noDue)}
    ${block('Upcoming', future)}
    ${renderEventsToday()}
  `;
}

function renderEventsToday() {
  const today = todayStr();
  const events = AppState.events.filter(ev => {
    const start = fromISO(ev.start), end = fromISO(ev.end);
    if (ev.allDay) return todayStr(start) <= today && today <= todayStr(end || start);
    return todayStr(start) === today; // simple MVP rule
  });
  if (!events.length) return '';
  const item = (ev) => `
    <div class="item">
      <div class="item-left">
        <div class="item-title" style="display:flex;align-items:center;gap:8px;">
          <span class="event-dot" style="width:10px;height:10px;border-radius:50%;background:${ev.color || '#4b83ff'};display:inline-block;"></span>
          ${escapeHtml(ev.title)}
        </div>
        <div class="item-meta">
          <span class="badge">${ev.allDay ? 'All-day' : timeRange(ev.start, ev.end)}</span>
          ${ev.pointsEnabled ? `<span class="badge">${ev.points||0} pts</span>` : `<span class="badge">No points</span>`}
        </div>
      </div>
      <div class="item-right">
        ${ev.pointsEnabled ? `<button class="pill ${ev.completedAt ? 'is-green' : ''}" data-action="event-toggle" data-id="${ev.id}">
          ${ev.completedAt ? 'Completed' : 'Mark done'} ${ev.points ? `• ${ev.points} pts` : ''}
        </button>` : ''}
        <button class="btn btn--ghost" data-action="event-edit" data-id="${ev.id}">Edit</button>
        <button class="btn btn--danger" data-action="event-delete" data-id="${ev.id}">Delete</button>
      </div>
    </div>
  `;
  return `
    <section class="section">
      <div class="section-header">
        <div>
          <div class="section-title">Events Today</div>
          <div class="section-sub">${events.length} event${events.length!==1?'s':''}</div>
        </div>
        <div class="section-actions">
          <button class="btn btn--primary" data-action="event-add">+ Event</button>
        </div>
      </div>
      <div class="section-body">${events.map(item).join('')}</div>
    </section>
  `;
}

function timeRange(startISO, endISO) {
  const s = new Date(startISO), e = endISO ? new Date(endISO) : null;
  const f = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${f(s)}${e ? `–${f(e)}` : ''}`;
}

function renderSectionHabits() {
  const d = new Date();
  const weekday = weekdays[d.getDay()];
  const todaysHabits = AppState.habits.filter(h => h.schedule.includes(weekday));

  const logMap = new Map();
  for (const l of AppState.habitLogs.filter(x => x.date === todayStr())) logMap.set(l.habitId, l);

  const item = (h) => {
    const log = logMap.get(h.id) || { habitId: h.id, date: todayStr(), count: 0, completedAt: null, id: `hl_${h.id}|${todayStr()}` };
    const isFull = h.type === 'binary' ? (log.count >= 1) : (log.count >= (h.target || 1));
    const pillCls = `pill ${isFull ? 'is-green' : ''}`;
    const pts = h.type === 'binary' ? (log.count >= 1 ? h.points || 0 : 0) : Math.floor(clamp(log.count, 0, h.target || 1)/(h.target||1) * (h.points||0));
    const meta = `<span class="badge">${h.type === 'binary' ? 'Binary' : `Counter ${log.count}/${h.target}`}</span> <span class="badge">${pts} pts</span>`;
    return `
      <div class="item" data-type="habit" data-id="${h.id}">
        <div class="item-left">
          <div class="item-title">${escapeHtml(h.name)}</div>
          <div class="item-meta">${meta}</div>
        </div>
        <div class="item-right">
          ${h.type === 'binary'
            ? `<button class="${pillCls}" data-action="habit-toggle" data-id="${h.id}" aria-pressed="${isFull}">${isFull ? 'Completed' : 'Mark done'} • ${h.points||0} pts</button>`
            : `<div class="stepper" data-habit="${h.id}">
                 <button data-action="habit-step" data-id="${h.id}" data-delta="-1">−</button>
                 <div class="value">${log.count}/${h.target}</div>
                 <button data-action="habit-step" data-id="${h.id}" data-delta="1">+</button>
               </div>
               <button class="${pillCls}" data-action="habit-complete" data-id="${h.id}" ${isFull?'':'style="opacity:.7"'}>Complete</button>`}
          <button class="btn btn--ghost" data-action="habit-edit" data-id="${h.id}">Edit</button>
          <button class="btn btn--danger" data-action="habit-delete" data-id="${h.id}">Delete</button>
        </div>
      </div>
    `;
  };

  return `
    <section class="section">
      <div class="section-header">
        <div>
          <div class="section-title">Habits for ${weekday}</div>
          <div class="section-sub">${todaysHabits.length} item${todaysHabits.length!==1?'s':''}</div>
        </div>
        <div class="section-actions">
          <button class="btn btn--primary" data-action="habit-add">+ Habit</button>
        </div>
      </div>
      <div class="section-body">${todaysHabits.length ? todaysHabits.map(item).join('') : `<div class="muted" style="padding:8px 10px;">No habits scheduled today</div>`}</div>
    </section>
  `;
}

function renderSectionQuestsDaily() {
  const today = todayStr();
  const list = AppState.assignedQuests.filter(a => a.type === 'daily' && a.date === today);
  const item = (a) => {
    const lib = AppState.questLibrary.find(q => q.id === a.libraryId);
    if (!lib) return '';
    const pts = lib.basePoints || 0;
    return `
      <div class="item">
        <div class="item-left">
          <div class="item-title">${escapeHtml(lib.title)}</div>
          <div class="item-meta"><span class="badge">${pts} pts</span></div>
        </div>
        <div class="item-right">
          <button class="pill ${a.completedAt ? 'is-green':''}" data-action="quest-toggle" data-id="${a.id}">
            ${a.completedAt ? 'Completed' : 'Mark done'} • ${pts} pts
          </button>
        </div>
      </div>
    `;
  };
  return `
    <section class="section">
      <div class="section-header">
        <div>
          <div class="section-title">Daily Quests</div>
          <div class="section-sub">${list.length} quest${list.length!==1?'s':''} today</div>
        </div>
        <div class="section-actions">
          <button class="btn btn--primary" data-action="questlib-add">+ Quest</button>
        </div>
      </div>
      <div class="section-body">${list.length ? list.map(item).join('') : `<div class="muted" style="padding:8px 10px;">No quests assigned</div>`}</div>
    </section>
  `;
}

function renderSectionQuestsWeekly() {
  const ws = weekOf(new Date(), AppState.settings.weekStart);
  const list = AppState.assignedQuests.filter(a => a.type === 'weekly' && a.weekOf === ws);
  const item = (a) => {
    const lib = AppState.questLibrary.find(q => q.id === a.libraryId);
    if (!lib) return '';
    const pts = Math.floor((lib.basePoints || 0) * (a.multiplier || 1));
    return `
      <div class="item">
        <div class="item-left">
          <div class="item-title">${escapeHtml(lib.title)}</div>
          <div class="item-meta">
            <span class="badge">${lib.basePoints || 0} base</span>
            <span class="badge factor">×${(a.multiplier || 1).toFixed(2)}</span>
            <span class="badge">${pts} pts</span>
          </div>
        </div>
        <div class="item-right">
          <button class="pill ${a.completedAt ? 'is-green':''}" data-action="quest-toggle" data-id="${a.id}">
            ${a.completedAt ? 'Completed' : 'Mark done'} • ${pts} pts
          </button>
        </div>
      </div>
    `;
  };
  return `
    <section class="section">
      <div class="section-header">
        <div>
          <div class="section-title">Weekly Quests</div>
          <div class="section-sub">${list.length} assigned</div>
        </div>
        <div class="section-actions">
          <button class="btn btn--primary" data-action="questlib-add">+ Quest</button>
        </div>
      </div>
      <div class="section-body">${list.length ? list.map(item).join('') : `<div class="muted" style="padding:8px 10px;">No weekly quests assigned</div>`}</div>
    </section>
  `;
}

function renderCompletedToday() {
  const today = todayStr();
  const items = [];

  // tasks done today
  for (const t of AppState.tasks) {
    if (t.completedAt && isSameDay(t.completedAt, today)) {
      const overdue = t.dueDate && isAfter(t.completedAt, t.dueDate);
      items.push({ type:'Task', title:t.title, pts: overdue ? 0 : (t.points||0), id:t.id, kind:'task' });
    }
  }
  // habits fully completed today => list them (binary==1, counter==target)
  for (const h of AppState.habits) {
    const log = AppState.habitLogs.find(l => l.habitId === h.id && l.date === today);
    if (!log) continue;
    const ok = h.type === 'binary' ? (log.count >= 1) : (log.count >= (h.target||1));
    if (ok) items.push({ type:'Habit', title:h.name, pts:(h.points||0), id:h.id, kind:'habit' });
  }
  // events completed today
  for (const ev of AppState.events) {
    if (ev.pointsEnabled && ev.completedAt && isSameDay(ev.completedAt, today)) {
      items.push({ type:'Event', title:ev.title, pts:(ev.points||0), id:ev.id, kind:'event' });
    }
  }
  // quests completed today
  for (const aq of AppState.assignedQuests) {
    if (aq.completedAt && isSameDay(aq.completedAt, today)) {
      const lib = AppState.questLibrary.find(q => q.id === aq.libraryId);
      if (!lib) continue;
      const pts = Math.floor((lib.basePoints||0) * (aq.multiplier||1));
      items.push({ type: aq.type==='daily'?'Daily Quest':'Weekly Quest', title: lib.title, pts, id:aq.id, kind:'quest' });
    }
  }

  items.sort((a,b)=> b.pts - a.pts);

  const row = (i) => `
    <div class="log-item">
      <div>
        <div class="item-title">${escapeHtml(i.title)}</div>
        <div class="item-meta"><span class="badge">${i.type}</span></div>
      </div>
      <div class="log-points">${i.pts} pts</div>
    </div>
  `;

  return `
    <section class="completed-log">
      <div class="section-header" style="padding:0 4px 8px;">
        <div class="section-title">Completed Today</div>
        <div class="section-sub">${items.length} item${items.length!==1?'s':''}</div>
      </div>
      <div>${items.length ? items.map(row).join('') : `<div class="muted" style="padding:6px 8px;">Nothing completed yet.</div>`}</div>
    </section>
  `;
}

/* --------------------------- Render: Calendar ---------------------------- */

function renderCalendar() {
  const root = $('#view');
  const ref = AppState.currentMonth; // Date
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  const daysInMonth = last.getDate();

  const weeksRow = weekdays.map(w => `<div class="weekday">${w}</div>`).join('');

  const startDay = new Date(y, m, 1).getDay();
  const blanks = Array(startDay).fill('<div></div>').join('');

  const cells = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = todayStr(new Date(y, m, d));
    const sum = AppState.daySummaries.find(s => s.date === dateStr);
    const cls = sum ? (sum.goalMet ? 'goal-met' : 'missed') : (new Date(dateStr) > new Date() ? 'future' : '');
    const evtChips = AppState.events.filter(ev => isOnDate(ev, dateStr)).slice(0,2).map(ev =>
      `<div class="event-chip"><span class="event-dot" style="width:8px;height:8px;border-radius:50%;background:${ev.color || '#4b83ff'}"></span>${escapeHtml(ev.title)}</div>`
    ).join('');
    cells.push(`
      <button class="day ${cls}" data-action="open-day" data-date="${dateStr}">
        <div class="status"></div>
        <div class="date">${d}</div>
        <div class="day-events">${evtChips}</div>
      </button>
    `);
  }

  root.innerHTML = `
    <section class="calendar">
      <div class="calendar-header">
        <button class="btn btn--ghost" data-action="cal-prev">‹ Prev</button>
        <div class="title">${monthNames[m]} ${y}</div>
        <button class="btn btn--ghost" data-action="cal-next">Next ›</button>
      </div>
      <div class="grid-month">
        ${weeksRow}
        ${blanks}${cells.join('')}
      </div>
    </section>
  `;
}

function isOnDate(ev, dateStr) {
  const s = todayStr(ev.start);
  const e = ev.end ? todayStr(ev.end) : s;
  return dateStr >= s && dateStr <= e;
}

function openDaySheet(dateStr) {
  const sum = AppState.daySummaries.find(s => s.date === dateStr) || computeDayTotals(dateStr);
  const d = new Date(dateStr);
  const header = `${weekdays[d.getDay()]} ${monthNames[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  // Lists
  const tasks = AppState.tasks.filter(t => t.dueDate && todayStr(t.dueDate) === dateStr);
  const events = AppState.events.filter(ev => isOnDate(ev, dateStr));
  const comps = [];

  // Completed items on that date (for clarity)
  for (const t of AppState.tasks) if (t.completedAt && isSameDay(t.completedAt, dateStr)) {
    const overdue = t.dueDate && isAfter(t.completedAt, t.dueDate);
    comps.push({ type:'Task', title:t.title, pts: overdue ? 0 : (t.points||0) });
  }
  for (const ev of AppState.events) if (ev.completedAt && isSameDay(ev.completedAt, dateStr) && ev.pointsEnabled) {
    comps.push({ type:'Event', title:ev.title, pts:(ev.points||0) });
  }
  for (const aq of AppState.assignedQuests) if (aq.completedAt && isSameDay(aq.completedAt, dateStr)) {
    const lib = AppState.questLibrary.find(q => q.id === aq.libraryId);
    const pts = Math.floor((lib?.basePoints || 0) * (aq.multiplier || 1));
    comps.push({ type: aq.type==='daily'?'Daily Quest':'Weekly Quest', title: lib?.title || 'Quest', pts });
  }

  const list = (arr, empty) => arr.length ? arr.map(x => `<div class="log-item"><div>${escapeHtml(x.title)}</div><div class="log-points">${x.pts ?? ''} ${x.pts!=null?'pts':''}</div></div>`).join('') : `<div class="muted">${empty}</div>`;

  showSheet(`
    <div class="sheet day-detail">
      <div class="drag"></div>
      <h3>${header}</h3>
      <div class="content">
        <div class="summary">
          <div class="summary-card">
            <div class="k">Points</div>
            <div class="v">${sum.totalPoints}</div>
          </div>
          <div class="summary-card">
            <div class="k">Goal Met</div>
            <div class="v">${sum.goalMet ? 'Yes' : 'No'}</div>
          </div>
        </div>
        <h4>Completed</h4>
        <div>${list(comps, 'Nothing completed')}</div>
        <h4>Events</h4>
        <div>${events.length ? events.map(ev => `<div class="log-item"><div>${escapeHtml(ev.title)}</div><div class="badge">${ev.allDay ? 'All-day' : timeRange(ev.start, ev.end)}</div></div>`).join('') : `<div class="muted">No events</div>`}</div>
        <h4>Tasks due this day</h4>
        <div>${tasks.length ? tasks.map(t => `<div class="log-item"><div>${escapeHtml(t.title)}</div><div class="badge">${t.points||0} pts</div></div>`).join('') : `<div class="muted">No tasks due</div>`}</div>
      </div>
    </div>
  `);
}

/* ----------------------------- Render: Stats ----------------------------- */

function renderStats() {
  const root = $('#view');
  // Heatmap: last 35 days (5 weeks)
  const days = [];
  const today = new Date();
  for (let i = 34; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = todayStr(d);
    const sum = AppState.daySummaries.find(s => s.date === ds) || computeDayTotals(ds);
    days.push({ date: ds, total: sum.totalPoints });
  }
  const max = Math.max(1, ...days.map(d => d.total));
  const bucket = (v) => v === 0 ? 0 : Math.min(5, Math.ceil(v / (max/5)));

  root.innerHTML = `
    <section class="heatmap">
      ${days.map(d => `<div class="hm-cell hm-${bucket(d.total)}" title="${d.date}: ${d.total} pts"></div>`).join('')}
    </section>

    <section class="chart-card">
      <div class="title">Last 7 Days</div>
      <div class="chart-wrap"><canvas id="chart7"></canvas></div>
    </section>

    <section class="chart-card">
      <div class="title">Last 30 Days</div>
      <div class="chart-wrap"><canvas id="chart30"></canvas></div>
    </section>

    <section class="section">
      <div class="section-header">
        <div class="section-title">Streaks & Totals</div>
      </div>
      <div class="section-body">
        <div class="item"><div class="item-left"><div class="item-title">Current Streak</div></div><div class="item-right"><span class="pill">${AppState.meta.streak||0}</span></div></div>
        <div class="item"><div class="item-left"><div class="item-title">Best Streak</div></div><div class="item-right"><span class="pill">${AppState.meta.bestStreak||0}</span></div></div>
        <div class="item"><div class="item-left"><div class="item-title">Points This Week</div></div><div class="item-right"><span class="pill">${sumRange(7)} pts</span></div></div>
        <div class="item"><div class="item-left"><div class="item-title">Points This Month</div></div><div class="item-right"><span class="pill">${sumMonth()} pts</span></div></div>
      </div>
    </section>
  `;

  drawLineChart($('#chart7'), 7);
  drawLineChart($('#chart30'), 30);
}

function sumRange(nDays) {
  const t = new Date();
  let s = 0;
  for (let i=0;i<nDays;i++){
    const d = new Date(t); d.setDate(d.getDate() - i);
    const ds = todayStr(d);
    const sum = AppState.daySummaries.find(x=>x.date===ds) || computeDayTotals(ds);
    s += sum.totalPoints;
  }
  return s;
}
function sumMonth() {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth()+1, 0);
  let s = 0;
  for (let day=1; day<=end.getDate(); day++) {
    const ds = todayStr(new Date(d.getFullYear(), d.getMonth(), day));
    const sum = AppState.daySummaries.find(x=>x.date===ds) || computeDayTotals(ds);
    s += sum.totalPoints;
  }
  return s;
}

function drawLineChart(canvas, days) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const pts = [];
  const today = new Date();
  let max = 1;
  for (let i = days-1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = todayStr(d);
    const sum = AppState.daySummaries.find(s => s.date === ds) || computeDayTotals(ds);
    pts.push(sum.totalPoints);
    if (sum.totalPoints > max) max = sum.totalPoints;
  }

  // Padding
  const padL = 28, padR = 8, padT = 12, padB = 24;
  const cw = w - padL - padR, ch = h - padT - padB;

  // Axes
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + ch);
  ctx.lineTo(padL + cw, padT + ch);
  ctx.stroke();

  // Line
  ctx.strokeStyle = '#2bd576';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = padL + (i / (days-1)) * cw;
    const y = padT + ch - (v / max) * ch;
    if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  // Dots
  ctx.fillStyle = '#22c66f';
  pts.forEach((v, i) => {
    const x = padL + (i / (days-1)) * cw;
    const y = padT + ch - (v / max) * ch;
    ctx.beginPath(); ctx.arc(x,y,2.2,0,Math.PI*2); ctx.fill();
  });

  // Labels (min ticks)
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText('0', 4, padT + ch);
  ctx.fillText(String(max), 4, padT + 10);
}

/* ---------------------------- Render: Settings --------------------------- */

function renderSettings() {
  const s = AppState.settings;
  const root = $('#view');
  const questRows = AppState.questLibrary.map(q => `
    <div class="item">
      <div class="item-left">
        <div class="item-title">${escapeHtml(q.title)}</div>
        <div class="item-meta">
          <span class="badge">${q.basePoints||0} pts</span>
          <span class="badge">${q.active ? 'Active' : 'Inactive'}</span>
        </div>
      </div>
      <div class="item-right">
        <button class="btn btn--ghost" data-action="questlib-edit" data-id="${q.id}">Edit</button>
        <button class="btn btn--danger" data-action="questlib-delete" data-id="${q.id}">Delete</button>
      </div>
    </div>
  `).join('');

  const habitRows = AppState.habits.map(h => `
    <div class="item">
      <div class="item-left">
        <div class="item-title">${escapeHtml(h.name)}</div>
        <div class="item-meta">
          <span class="badge">${h.type}</span>
          ${h.type==='counter'?`<span class="badge">Target ${h.target}</span>`:''}
          <span class="badge">${h.points||0} pts</span>
          <span class="badge">${h.schedule.join(', ')}</span>
        </div>
      </div>
      <div class="item-right">
        <button class="btn btn--ghost" data-action="habit-edit" data-id="${h.id}">Edit</button>
        <button class="btn btn--danger" data-action="habit-delete" data-id="${h.id}">Delete</button>
      </div>
    </div>
  `).join('');

  root.innerHTML = `
    <section class="section">
      <div class="section-header"><div class="section-title">Preferences</div></div>
      <div class="section-body">
        <div class="row row-3">
          <div>
            <label>Daily Goal</label>
            <input type="number" min="0" value="${s.dailyGoal}" data-action="set-daily-goal" />
          </div>
          <div>
            <label>Daily Quests (count)</label>
            <input type="number" min="0" value="${s.dailyQuestCount}" data-action="set-daily-quest-count" />
          </div>
          <div>
            <label>Week Starts</label>
            <select data-action="set-week-start">
              <option ${s.weekStart==='Mon'?'selected':''}>Mon</option>
              <option ${s.weekStart==='Sun'?'selected':''}>Sun</option>
            </select>
          </div>
        </div>
        <div class="row row-3">
          <div>
            <label>Weekly Quest Mode</label>
            <select data-action="set-weekly-mode">
              <option value="fixed" ${s.weeklyQuestMode==='fixed'?'selected':''}>Fixed</option>
              <option value="range" ${s.weeklyQuestMode==='range'?'selected':''}>Range</option>
            </select>
          </div>
          <div>
            <label>Weekly Count (fixed)</label>
            <input type="number" min="0" value="${s.weeklyQuestCount}" data-action="set-weekly-count" />
          </div>
          <div>
            <label>Weekly Range (min–max)</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <input type="number" min="0" value="${s.weeklyQuestMin}" data-action="set-weekly-min" />
              <input type="number" min="0" value="${s.weeklyQuestMax}" data-action="set-weekly-max" />
            </div>
          </div>
        </div>
        <div class="row">
          <div>
            <label>Weekly Reward Factor (1.0–3.0)</label>
            <input type="number" step="0.1" min="1" max="3" value="${s.weeklyFactor}" data-action="set-weekly-factor" />
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div class="section-title">Quest Library</div>
        <div class="section-actions"><button class="btn btn--primary" data-action="questlib-add">+ Quest</button></div>
      </div>
      <div class="section-body">${questRows || `<div class="muted" style="padding:6px 8px;">No quests yet</div>`}</div>
    </section>

    <section class="section">
      <div class="section-header">
        <div class="section-title">Habits</div>
        <div class="section-actions"><button class="btn btn--primary" data-action="habit-add">+ Habit</button></div>
      </div>
      <div class="section-body">${habitRows || `<div class="muted" style="padding:6px 8px;">No habits yet</div>`}</div>
    </section>

    <section class="section">
      <div class="section-header">
        <div class="section-title">Tasks</div>
        <div class="section-actions"><button class="btn btn--primary" data-action="task-add">+ Task</button></div>
      </div>
      <div class="section-body">
        ${AppState.tasks.length ? AppState.tasks.map(t => `<div class="item"><div class="item-left"><div class="item-title">${escapeHtml(t.title)}</div><div class="item-meta"><span class="badge">${t.points||0} pts</span>${t.dueDate?` <span class="badge">${monthNames[new Date(t.dueDate).getMonth()]} ${new Date(t.dueDate).getDate()}</span>`:' <span class="badge">No due</span>'}</div></div><div class="item-right"><button class="btn btn--ghost" data-action="task-edit" data-id="${t.id}">Edit</button><button class="btn btn--danger" data-action="task-delete" data-id="${t.id}">Delete</button></div></div>`).join('') : `<div class="muted" style="padding:6px 8px;">No tasks yet</div>`}
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <div class="section-title">Events</div>
        <div class="section-actions"><button class="btn btn--primary" data-action="event-add">+ Event</button></div>
      </div>
      <div class="section-body">
        ${AppState.events.length ? AppState.events.map(ev => `
          <div class="item">
            <div class="item-left">
              <div class="item-title" style="display:flex;align-items:center;gap:8px;">
                <span class="event-dot" style="width:10px;height:10px;border-radius:50%;background:${ev.color || '#4b83ff'}"></span>
                ${escapeHtml(ev.title)}
              </div>
              <div class="item-meta"><span class="badge">${ev.allDay ? 'All-day' : timeRange(ev.start, ev.end)}</span> ${ev.pointsEnabled?`<span class="badge">${ev.points||0} pts</span>`:`<span class="badge">No points</span>`}</div>
            </div>
            <div class="item-right">
              <button class="btn btn--ghost" data-action="event-edit" data-id="${ev.id}">Edit</button>
              <button class="btn btn--danger" data-action="event-delete" data-id="${ev.id}">Delete</button>
            </div>
          </div>`).join('') : `<div class="muted" style="padding:6px 8px;">No events yet</div>`}
      </div>
    </section>
  `;
}

/* ----------------------------- Modals/Sheets ----------------------------- */

function showModal(html) {
  $('#modal-root').innerHTML = `<div class="overlay" data-action="close-overlay"></div><div class="modal">${html}</div>`;
  $('#modal-root').removeAttribute('aria-hidden');
}
function closeModal() {
  $('#modal-root').setAttribute('aria-hidden','true');
  $('#modal-root').innerHTML = '';
}
function showSheet(html) {
  $('#sheet-root').innerHTML = `<div class="overlay" data-action="close-overlay"></div>${html}`;
  $('#sheet-root').removeAttribute('aria-hidden');
}
function closeSheet() {
  $('#sheet-root').setAttribute('aria-hidden','true');
  $('#sheet-root').innerHTML = '';
}

function escapeHtml(s) {
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ------------------------------- Handlers -------------------------------- */

function bindGlobalHandlers() {
  window.addEventListener('hashchange', route);

  // Delegated click
  document.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const act = btn.getAttribute('data-action');

    try {
      // Overlay close
      if (act === 'close-overlay') { closeModal(); closeSheet(); return; }

      // Calendar navigation
      if (act === 'cal-prev') { AppState.currentMonth.setMonth(AppState.currentMonth.getMonth()-1); renderCalendar(); return; }
      if (act === 'cal-next') { AppState.currentMonth.setMonth(AppState.currentMonth.getMonth()+1); renderCalendar(); return; }
      if (act === 'open-day') { openDaySheet(btn.getAttribute('data-date')); return; }

      // FAB
      if (btn.id === 'fab') { openAddMenu(); return; }

      // Tasks
      if (act === 'task-add') { openTaskForm(); return; }
      if (act === 'task-edit') { openTaskForm(btn.getAttribute('data-id')); return; }
      if (act === 'task-delete') { await deleteTask(btn.getAttribute('data-id')); return; }
      if (act === 'task-toggle') { await toggleTask(btn.getAttribute('data-id')); return; }

      // Habits
      if (act === 'habit-add') { openHabitForm(); return; }
      if (act === 'habit-edit') { openHabitForm(btn.getAttribute('data-id')); return; }
      if (act === 'habit-delete') { await deleteHabit(btn.getAttribute('data-id')); return; }
      if (act === 'habit-toggle') { await toggleHabitBinary(btn.getAttribute('data-id')); return; }
      if (act === 'habit-step') { await stepHabitCounter(btn.getAttribute('data-id'), parseInt(btn.getAttribute('data-delta'),10)); return; }
      if (act === 'habit-complete') { await completeHabitCounter(btn.getAttribute('data-id')); return; }

      // Quests (library)
      if (act === 'questlib-add') { openQuestLibForm(); return; }
      if (act === 'questlib-edit') { openQuestLibForm(btn.getAttribute('data-id')); return; }
      if (act === 'questlib-delete') { await deleteQuestLib(btn.getAttribute('data-id')); return; }

      // Quests (assigned)
      if (act === 'quest-toggle') { await toggleAssignedQuest(btn.getAttribute('data-id')); return; }

      // Events
      if (act === 'event-add') { openEventForm(); return; }
      if (act === 'event-edit') { openEventForm(btn.getAttribute('data-id')); return; }
      if (act === 'event-delete') { await deleteEvent(btn.getAttribute('data-id')); return; }
      if (act === 'event-toggle') { await toggleEvent(btn.getAttribute('data-id')); return; }

    } catch (err) {
      console.error(err);
      toast('Action failed');
    }
  });

  // Settings inputs (delegated)
  document.body.addEventListener('input', async (e) => {
    const el = e.target;
    const act = el.getAttribute('data-action');
    if (!act) return;
    const s = AppState.settings;
    if (act === 'set-daily-goal') s.dailyGoal = clamp(parseInt(el.value||'0',10),0,100000);
    else if (act === 'set-daily-quest-count') s.dailyQuestCount = clamp(parseInt(el.value||'0',10),0,20);
    else if (act === 'set-week-start') s.weekStart = el.value;
    else if (act === 'set-weekly-mode') s.weeklyQuestMode = el.value;
    else if (act === 'set-weekly-count') s.weeklyQuestCount = clamp(parseInt(el.value||'0',10),0,20);
    else if (act === 'set-weekly-min') s.weeklyQuestMin = clamp(parseInt(el.value||'0',10),0,20);
    else if (act === 'set-weekly-max') s.weeklyQuestMax = clamp(parseInt(el.value||'0',10),0,20);
    else if (act === 'set-weekly-factor') s.weeklyFactor = clamp(parseFloat(el.value||'1'),1,3);
    await db.set('settings', s);
    AppState.settings = s;
    updateKPI();
  });
}

/* -------------------------- Add Menus & Forms ---------------------------- */

function openAddMenu() {
  showSheet(`
    <div class="sheet">
      <div class="drag"></div>
      <h3>Add New</h3>
      <div class="content">
        <div class="row row-2">
          <button class="btn btn--primary" data-action="task-add">+ Task</button>
          <button class="btn btn--primary" data-action="habit-add">+ Habit</button>
        </div>
        <div class="row row-2">
          <button class="btn btn--primary" data-action="event-add">+ Event</button>
          <button class="btn btn--primary" data-action="questlib-add">+ Quest (Library)</button>
        </div>
      </div>
    </div>
  `);
}

function openTaskForm(id=null) {
  const t = id ? AppState.tasks.find(x=>x.id===id) : { title:'', points:10, dueDate:'' };
  showModal(`
    <h3>${id?'Edit Task':'New Task'}</h3>
    <div class="content">
      <form class="form-grid" id="form-task">
        <div><label>Title</label><input name="title" required value="${escapeHtml(t.title)}"/></div>
        <div class="row row-2">
          <div><label>Points</label><input name="points" type="number" min="0" value="${t.points || 0}"/></div>
          <div><label>Due Date (optional)</label><input name="dueDate" type="datetime-local" value="${t.dueDate ? t.dueDate.slice(0,16) : ''}"/></div>
        </div>
        <div class="row">
          <button class="btn btn--primary" type="submit">${id?'Save':'Create'}</button>
          <button class="btn btn--ghost" type="button" data-action="close-overlay">Cancel</button>
        </div>
      </form>
    </div>
  `);
  $('#form-task').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const obj = {
      id: id || uid('t'),
      title: f.get('title').trim(),
      points: parseInt(f.get('points')||'0',10),
      dueDate: f.get('dueDate') ? new Date(f.get('dueDate')).toISOString() : null,
      createdAt: id ? t.createdAt : new Date().toISOString(),
      completedAt: id ? t.completedAt : null
    };
    await db.set('tasks', obj);
    if (id) {
      const i = AppState.tasks.findIndex(x=>x.id===id); AppState.tasks[i]=obj;
    } else {
      AppState.tasks.push(obj);
    }
    closeModal();
    route();
    toast(id?'Task saved':'Task added');
  };
}

async function deleteTask(id) {
  await db.del('tasks', id);
  AppState.tasks = AppState.tasks.filter(x=>x.id!==id);
  route(); toast('Task deleted');
}

async function toggleTask(id) {
  const t = AppState.tasks.find(x=>x.id===id);
  if (!t) return;
  t.completedAt = t.completedAt ? null : new Date().toISOString();
  await db.set('tasks', t);
  await upsertDaySummary(todayStr());
  route(); toast(t.completedAt?'Task completed':'Task uncompleted');
}

function openHabitForm(id=null) {
  const h = id ? AppState.habits.find(x=>x.id===id) : {
    name:'', type:'binary', target:3, points:10, schedule:['Mon','Tue','Wed','Thu','Fri']
  };
  const chk = (d) => h.schedule.includes(d) ? 'checked' : '';
  showModal(`
    <h3>${id?'Edit Habit':'New Habit'}</h3>
    <div class="content">
      <form class="form-grid" id="form-habit">
        <div><label>Name</label><input name="name" required value="${escapeHtml(h.name)}"/></div>
        <div class="row row-3">
          <div>
            <label>Type</label>
            <select name="type">
              <option value="binary" ${h.type==='binary'?'selected':''}>Binary</option>
              <option value="counter" ${h.type==='counter'?'selected':''}>Counter</option>
            </select>
          </div>
          <div>
            <label>Target (counter)</label>
            <input name="target" type="number" min="1" value="${h.target || 3}"/>
          </div>
          <div>
            <label>Points</label>
            <input name="points" type="number" min="0" value="${h.points || 0}"/>
          </div>
        </div>
        <div>
          <label>Schedule</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${weekdays.map(w => `<label style="display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);padding:6px 10px;border-radius:999px;"><input type="checkbox" name="sch" value="${w}" ${chk(w)}/> ${w}</label>`).join('')}
          </div>
        </div>
        <div class="row">
          <button class="btn btn--primary" type="submit">${id?'Save':'Create'}</button>
          <button class="btn btn--ghost" type="button" data-action="close-overlay">Cancel</button>
        </div>
      </form>
    </div>
  `);
  $('#form-habit').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const sched = f.getAll('sch'); if (sched.length===0) { toast('Select at least one day'); return; }
    const obj = {
      id: id || uid('h'),
      name: f.get('name').trim(),
      type: f.get('type'),
      target: parseInt(f.get('target')||'1',10),
      points: parseInt(f.get('points')||'0',10),
      schedule: sched
    };
    await db.set('habits', obj);
    if (id) {
      const i = AppState.habits.findIndex(x=>x.id===id); AppState.habits[i]=obj;
    } else {
      AppState.habits.push(obj);
    }
    closeModal(); route(); toast(id?'Habit saved':'Habit added');
  };
}

async function deleteHabit(id) {
  await db.del('habits', id);
  AppState.habits = AppState.habits.filter(x=>x.id!==id);
  // Remove logs for this habit
  const rm = AppState.habitLogs.filter(l=>l.habitId===id).map(l=>l.id);
  if (rm.length) { await db.bulkDel('habitLogs', rm); AppState.habitLogs = AppState.habitLogs.filter(l=>l.habitId!==id); }
  route(); toast('Habit deleted');
}

async function getOrCreateHabitLog(habitId, dateStr) {
  let log = AppState.habitLogs.find(l=>l.habitId===habitId && l.date===dateStr);
  if (!log) {
    log = { id:`hl_${habitId}|${dateStr}`, habitId, date:dateStr, count:0, completedAt:null };
    await db.set('habitLogs', log);
    AppState.habitLogs.push(log);
  }
  return log;
}

async function toggleHabitBinary(id) {
  const h = AppState.habits.find(x=>x.id===id); if (!h) return;
  const log = await getOrCreateHabitLog(id, todayStr());
  if (h.type !== 'binary') return;
  log.count = log.count >= 1 ? 0 : 1;
  log.completedAt = log.count >= 1 ? new Date().toISOString() : null;
  await db.set('habitLogs', log);
  await upsertDaySummary(todayStr());
  route(); toast(log.count>=1?'Habit completed':'Habit uncompleted');
}

async function stepHabitCounter(id, delta) {
  const h = AppState.habits.find(x=>x.id===id); if (!h) return;
  if (h.type !== 'counter') return;
  const log = await getOrCreateHabitLog(id, todayStr());
  const tgt = h.target || 1;
  log.count = clamp((log.count || 0) + delta, 0, tgt);
  if (log.count >= tgt) log.completedAt = new Date().toISOString();
  else log.completedAt = null;
  await db.set('habitLogs', log);
  await upsertDaySummary(todayStr());
  route(); // live points update
}

async function completeHabitCounter(id) {
  const h = AppState.habits.find(x=>x.id===id); if (!h) return;
  if (h.type !== 'counter') return;
  const log = await getOrCreateHabitLog(id, todayStr());
  const tgt = h.target || 1;
  log.count = tgt;
  log.completedAt = new Date().toISOString();
  await db.set('habitLogs', log);
  await upsertDaySummary(todayStr());
  route(); toast('Habit completed');
}

function openQuestLibForm(id=null) {
  const q = id ? AppState.questLibrary.find(x=>x.id===id) : { title:'', basePoints:10, active:true };
  showModal(`
    <h3>${id?'Edit Quest':'New Quest'}</h3>
    <div class="content">
      <form class="form-grid" id="form-quest">
        <div><label>Title</label><input name="title" required value="${escapeHtml(q.title)}"/></div>
        <div class="row row-3">
          <div><label>Base Points</label><input type="number" min="0" name="basePoints" value="${q.basePoints || 0}"/></div>
          <div>
            <label>Active</label>
            <select name="active"><option value="true" ${q.active?'selected':''}>Active</option><option value="false" ${!q.active?'selected':''}>Inactive</option></select>
          </div>
        </div>
        <div class="row">
          <button class="btn btn--primary" type="submit">${id?'Save':'Create'}</button>
          <button class="btn btn--ghost" type="button" data-action="close-overlay">Cancel</button>
        </div>
      </form>
    </div>
  `);
  $('#form-quest').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const obj = {
      id: id || uid('q'),
      title: f.get('title').trim(),
      basePoints: parseInt(f.get('basePoints')||'0',10),
      active: f.get('active') === 'true'
    };
    await db.set('questLibrary', obj);
    if (id) {
      const i = AppState.questLibrary.findIndex(x=>x.id===id); AppState.questLibrary[i]=obj;
    } else {
      AppState.questLibrary.push(obj);
    }
    closeModal(); route(); toast(id?'Quest saved':'Quest added');
  };
}

async function deleteQuestLib(id) {
  await db.del('questLibrary', id);
  AppState.questLibrary = AppState.questLibrary.filter(x=>x.id!==id);
  // Remove assigned referencing this lib (optional: or keep)
  const rm = AppState.assignedQuests.filter(a=>a.libraryId===id).map(a=>a.id);
  if (rm.length) { await db.bulkDel('assignedQuests', rm); AppState.assignedQuests = AppState.assignedQuests.filter(a=>a.libraryId!==id); }
  route(); toast('Quest deleted');
}

async function toggleAssignedQuest(id) {
  const a = AppState.assignedQuests.find(x=>x.id===id);
  if (!a) return;
  a.completedAt = a.completedAt ? null : new Date().toISOString();
  await db.set('assignedQuests', a);
  await upsertDaySummary(todayStr());
  route(); toast(a.completedAt?'Quest completed':'Quest uncompleted');
}

function openEventForm(id=null) {
  const ev = id ? AppState.events.find(x=>x.id===id) : {
    title:'', start: new Date().toISOString().slice(0,16), end:'', allDay: false,
    color:'#4b83ff', pointsEnabled:false, points:10, completedAt: null
  };
  showModal(`
    <h3>${id?'Edit Event':'New Event'}</h3>
    <div class="content">
      <form class="form-grid" id="form-event">
        <div><label>Title</label><input name="title" required value="${escapeHtml(ev.title)}"/></div>
        <div class="row row-2">
          <div><label>Start</label><input type="datetime-local" name="start" value="${(ev.start||new Date().toISOString()).slice(0,16)}"/></div>
          <div><label>End (optional)</label><input type="datetime-local" name="end" value="${ev.end ? ev.end.slice(0,16) : ''}"/></div>
        </div>
        <div class="row row-3">
          <div>
            <label>All-day</label>
            <select name="allDay"><option value="false" ${!ev.allDay?'selected':''}>No</option><option value="true" ${ev.allDay?'selected':''}>Yes</option></select>
          </div>
          <div>
            <label>Color</label>
            <input name="color" type="color" value="${ev.color || '#4b83ff'}"/>
          </div>
          <div>
            <label>Points Enabled</label>
            <select name="pointsEnabled"><option value="false" ${!ev.pointsEnabled?'selected':''}>No</option><option value="true" ${ev.pointsEnabled?'selected':''}>Yes</option></select>
          </div>
        </div>
        <div>
          <label>Points (if enabled)</label>
          <input name="points" type="number" min="0" value="${ev.points || 0}"/>
        </div>
        <div class="row">
          <button class="btn btn--primary" type="submit">${id?'Save':'Create'}</button>
          <button class="btn btn--ghost" type="button" data-action="close-overlay">Cancel</button>
        </div>
      </form>
    </div>
  `);
  $('#form-event').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const obj = {
      id: id || uid('e'),
      title: f.get('title').trim(),
      start: new Date(f.get('start')).toISOString(),
      end: f.get('end') ? new Date(f.get('end')).toISOString() : null,
      allDay: f.get('allDay') === 'true',
      color: f.get('color') || '#4b83ff',
      pointsEnabled: f.get('pointsEnabled') === 'true',
      points: parseInt(f.get('points')||'0',10),
      completedAt: id ? AppState.events.find(x=>x.id===id)?.completedAt || null : null
    };
    await db.set('events', obj);
    if (id) {
      const i = AppState.events.findIndex(x=>x.id===id); AppState.events[i]=obj;
    } else {
      AppState.events.push(obj);
    }
    closeModal(); route(); toast(id?'Event saved':'Event added');
  };
}

async function deleteEvent(id) {
  await db.del('events', id);
  AppState.events = AppState.events.filter(x=>x.id!==id);
  route(); toast('Event deleted');
}

async function toggleEvent(id) {
  const ev = AppState.events.find(x=>x.id===id);
  if (!ev || !ev.pointsEnabled) return;
  ev.completedAt = ev.completedAt ? null : new Date().toISOString();
  await db.set('events', ev);
  await upsertDaySummary(todayStr());
  route(); toast(ev.completedAt?'Event completed':'Event uncompleted');
}

/* --------------------------- Notifications/Toasts ------------------------ */

function toast(msg) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast fade-in';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(()=>{ el.remove(); }, 2200);
}

/* --------------------------- Midnight Watcher ---------------------------- */

function tickMidnightWatcher() {
  // Foreground check every 60s
  setInterval(async () => {
    const t = todayStr();
    if (t !== AppState.meta.lastAssignmentRun) {
      await ensureRollover();
      route();
      toast('New day! Quests assigned.');
    } else {
      // keep today's summary fresh
      await upsertDaySummary(t);
      updateKPI();
    }
  }, 60 * 1000);

  // Also on visibility change (catch-up when app resumes)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await ensureRollover();
      route();
    }
  });
}

/* ------------------------------ Startup ---------------------------------- */

window.addEventListener('load', boot);
