import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
  import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
  import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

  // ====================================================================
  // FIREBASE CONFIG — replace this with YOUR project's config object.
  // ====================================================================
const firebaseConfig = {
    apiKey: "AIzaSyDKPOmP_HuGrca5AX3HhEn6xr4EBfu-xhs",
  authDomain: "my-study-tracker-3678f.firebaseapp.com",
  projectId: "my-study-tracker-3678f",
  storageBucket: "my-study-tracker-3678f.firebasestorage.app",
  messagingSenderId: "240696535190",
  appId: "1:240696535190:web:df3a7a13315811c411fab7"
  };

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const auth = getAuth(app);

  const storage = {
    async get(studentId){
      const snap = await getDoc(doc(db, "students", studentId));
      return snap.exists() ? snap.data() : null;
    },
    async set(studentId, data){
      await setDoc(doc(db, "students", studentId), data);
      const totalMs = (data.sessions||[]).reduce((sum,s)=>sum+(s.durationMs||0),0);
      await setDoc(doc(db, "roster", studentId), {
        id: studentId,
        lastActive: Date.now(),
        totalMs,
        sessionCount: (data.sessions||[]).length
      });
    },
    async listRoster(){
      const snap = await getDocs(collection(db, "roster"));
      const rows = [];
      snap.forEach(d=>rows.push(d.data()));
      return rows;
    },
    async delete(studentId){
      await deleteDoc(doc(db, "students", studentId));
      await deleteDoc(doc(db, "roster", studentId));
    }
  };

  // ============================================================
  // SIDEBAR / PAGE ROUTER
  // ============================================================
  (function(){
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebarToggle');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const navItems = document.querySelectorAll('.nav-item');
    const pages = document.querySelectorAll('.page');
    const brand = document.querySelector('.brand');

    function updateBrand(){
      if(sidebar.classList.contains('collapsed')){
        brand.innerHTML = 'T<span>.</span>';
      }else{
        brand.innerHTML = 'Tymerr<span>.</span>';
      }
    }

    function isMobile(){ return window.innerWidth <= 860; }

    function syncMobileButton(){
      mobileMenuBtn.classList.toggle('hidden', !(isMobile() && sidebar.classList.contains('collapsed')));
    }

    toggle.addEventListener('click', ()=>{
      sidebar.classList.toggle('collapsed');
      updateBrand();
      syncMobileButton();
      // Sidebar width animates over ~0.2s — wait for it to settle, then
      // let the Analytics page know its available width changed.
      setTimeout(()=> window.dispatchEvent(new Event('resize')), 220);
    });

    mobileMenuBtn.addEventListener('click', ()=>{
      sidebar.classList.remove('collapsed');
      updateBrand();
      syncMobileButton();
      setTimeout(()=> window.dispatchEvent(new Event('resize')), 220);
    });

    window.addEventListener('resize', syncMobileButton);

    navItems.forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const target = btn.getAttribute('data-page');
        navItems.forEach(b=>b.classList.toggle('active', b===btn));
        pages.forEach(p=>p.classList.toggle('active', p.id === 'page-' + target));
        if(target === 'activity') window.dispatchEvent(new Event('focus:render-activity'));
        if(target === 'subjects') window.dispatchEvent(new Event('focus:render-subjects'));
        if(isMobile()) sidebar.classList.add('collapsed');
        syncMobileButton();
      });
    });

    syncMobileButton();
  })();

(function(){
  const DEFAULT_SUBJECTS = [];
  const LEGACY_DEFAULT_SUBJECTS = ['General', 'Math', 'Science', 'Reading'];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MANAGE_SUBJECTS_VALUE = '__manage_subjects__';

  // ============================================================
  // LOADING QUOTES (for subject deep dive fake-loading effect)
  // ============================================================
  const LOADING_QUOTE = "Extracting analysis data from NASA server…";

  function uid(){
    return 'student-' + Math.random().toString(36).slice(2,8) + Date.now().toString(36).slice(-4);
  }

  let myId = localStorage.getItem('focus_user_id');
  if(!myId){
    myId = uid();
    localStorage.setItem('focus_user_id', myId);
  }
  document.getElementById('idTag').textContent = myId;

  let state = {
    subjects: DEFAULT_SUBJECTS.slice(),
    sessions: [],
    timer: { running:false, paused:false, subject: null, startedAt:null, elapsedBeforePause:0 },
    lastBreakReminder: 0,
    pGoals: {}
  };

  let tickHandle = null;
  let saveTimeout = null;
  const BREAK_INTERVAL = 2 * 60 * 60 * 1000;

  // ============================================================
  // THEME (light / dark)
  // ============================================================
  const THEME_KEY = 'focus_theme';
  let currentTheme = localStorage.getItem(THEME_KEY) || 'dark';
  function applyTheme(t){
    currentTheme = t;
    document.documentElement.dataset.theme = t;
    localStorage.setItem(THEME_KEY, t);
    const btn = document.getElementById('themeToggle');
    if(btn) btn.textContent = t === 'dark' ? '☀' : '☾';
  }
  applyTheme(currentTheme);
  const themeBtn = document.getElementById('themeToggle');
  if(themeBtn) themeBtn.addEventListener('click', ()=>{
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });

  // ============================================================
  // MIDNIGHT SPLIT
  // Takes one raw session {startedAt, endedAt, durationMs, ...}
  // and returns an array of sessions each confined to a single
  // calendar day (local time). If the session never crosses
  // midnight it returns the original as a single-element array.
  //
  // Each split piece carries:
  //   startedAt  — real wall-clock start of that piece
  //   endedAt    — real wall-clock end of that piece
  //   durationMs — exact ms for that piece (sum == original durationMs)
  //   _split     — true on every piece except possibly the first,
  //                so the log can show a "continued" badge if desired
  // ============================================================
  function splitSessionsByMidnight(session){
    const { startedAt, endedAt, subject, note, id } = session;

    // If the session has no startedAt (legacy data), fall back to
    // treating endedAt as a point-in-time with no split needed.
    if(!startedAt || startedAt >= endedAt){
      return [session];
    }

    const pieces = [];
    let cursor = startedAt;
    let pieceIndex = 0;

    while(cursor < endedAt){
      // find the next midnight after cursor (local time)
      const cursorDate = new Date(cursor);
      cursorDate.setHours(24, 0, 0, 0);          // next midnight local
      const nextMidnight = cursorDate.getTime();

      const pieceEnd = Math.min(nextMidnight, endedAt);
      const pieceMs  = pieceEnd - cursor;

      // Drop sub-second slivers that can appear due to floating point
      if(pieceMs >= 1000){
        pieces.push({
          id: pieceIndex === 0 ? id : id + '_p' + pieceIndex,
          subject,
          note: note || '',
          startedAt: cursor,
          endedAt: pieceEnd,
          durationMs: pieceMs,
          _split: pieceIndex > 0   // mark continuation pieces
        });
      }

      cursor = nextMidnight;
      pieceIndex++;
    }

    // No actual split — keep original session (preserves test-advanced durationMs)
    if(pieces.length === 1) return [session];

    // Actual midnight split: if the timer's durationMs differs from wall-clock
    // (e.g. dev-test-advanced time), distribute proportionally so the total
    // elapsed time isn't lost.
    const origTotal = session.durationMs;
    if(origTotal){
      const wallTotal = pieces.reduce((s,p)=> s + p.durationMs, 0);
      if(Math.abs(origTotal - wallTotal) > 1000){
        pieces.forEach(p => {
          p.durationMs = Math.round(origTotal * (p.durationMs / wallTotal));
        });
      }
    }
    return pieces;
  }

  async function loadState(){
    try{
      const data = await storage.get(myId);
      if(data){
        state = Object.assign(state, data);
        if(!state.subjects) state.subjects = [];
        if(!state.subjectColors) state.subjectColors = {};
        if(!state.pGoals) state.pGoals = {};
        if(!state.pMockDays) state.pMockDays = {};
      }
    }catch(e){
      console.error('Could not load saved data — check your Firebase config.', e);
    }

    // One-time cleanup: earlier versions of the app auto-seeded every new
    // user with General/Math/Science/Reading. Strip out any of those that
    // this user never actually logged a session under, for everyone.
    const usedSubjects = new Set(state.sessions.map(s=>s.subject));
    const hadLegacy = state.subjects.some(s=>LEGACY_DEFAULT_SUBJECTS.includes(s) && !usedSubjects.has(s));
    if(hadLegacy){
      state.subjects = state.subjects.filter(s=> !LEGACY_DEFAULT_SUBJECTS.includes(s) || usedSubjects.has(s));
      if(state.timer && !state.subjects.includes(state.timer.subject)){
        state.timer.subject = state.subjects[0] || null;
      }
      queueSave();
    }

    renderSubjectOptions();
    renderAll();
    if(state.timer && state.timer.running){
      resumeTicking();
    } else if(state.timer && state.timer.paused){
      restorePausedState();
    }
    scheduleMidnightRefresh();
  }

  function pruneGoals(){
    const today = startOfDay(Date.now());
    const min = today - 365 * DAY_MS;
    const max = today + 365 * DAY_MS;
    Object.keys(state.pGoals).forEach(k => {
      const ts = Number(k);
      if(ts < min || ts > max) delete state.pGoals[k];
    });
    if(state.pMockDays){
      Object.keys(state.pMockDays).forEach(k => {
        const ts = Number(k);
        if(ts < min || ts > max) delete state.pMockDays[k];
      });
    }
  }

  function queueSave(){
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async ()=>{
      try{
        pruneGoals();
        await storage.set(myId, state);
      }catch(e){
        console.error('Save failed — check your Firebase config and security rules.', e);
      }
    }, 250);
  }

  // ============================================================
  // MIDNIGHT AUTO-REFRESH
  // Schedules a timeout to fire exactly at the next local midnight,
  // calls renderAll() so "Today" resets correctly, then reschedules
  // itself so it keeps working for tabs left open for days.
  // ============================================================
  function scheduleMidnightRefresh(){
    const now = Date.now();
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);              // next midnight local
    const msUntilMidnight = tomorrow.getTime() - now;

    setTimeout(()=>{
      renderAll();
      scheduleMidnightRefresh();                  // reschedule for the next night
    }, msUntilMidnight + 50);                     // +50ms buffer so we're definitely past midnight
  }

  function renderSubjectOptions(){
    const sel = document.getElementById('subjectSelect');
    sel.innerHTML = '';
    if(!state.subjects.length){
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No subjects yet';
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
    }
    state.subjects.forEach(s=>{
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      sel.appendChild(opt);
    });
    const manageOpt = document.createElement('option');
    manageOpt.value = MANAGE_SUBJECTS_VALUE;
    manageOpt.textContent = '+ Add / manage subjects…';
    sel.appendChild(manageOpt);

    if(state.subjects.length){
      sel.value = state.subjects.includes(state.timer.subject) ? state.timer.subject : state.subjects[0];
    }
  }

  // Picking the "manage subjects" option teleports to the Subjects tab
  // instead of being treated as a real subject selection.
  document.getElementById('subjectSelect').addEventListener('change', (e)=>{
    if(e.target.value === MANAGE_SUBJECTS_VALUE){
      renderSubjectOptions(); // reset selection back to a real subject
      const subjectsNav = document.querySelector('.nav-item[data-page="subjects"]');
      if(subjectsNav) subjectsNav.click();
    }
  });

  document.getElementById('addSubjectBtn').addEventListener('click', addSubject);
  document.getElementById('newSubjectInput').addEventListener('keydown', e=>{
    if(e.key === 'Enter'){ addSubject(); }
  });
  function addSubject(){
    const input = document.getElementById('newSubjectInput');
    const val = input.value.trim();
    if(!val) return;
    if(state.subjects.includes(val)){ input.value=''; return; }
    state.subjects.push(val);
    input.value = '';
    renderSubjectOptions();
    document.getElementById('subjectSelect').value = val;
    queueSave();
    renderSubjectsPage();
  }

  const RING_CIRC = 2 * Math.PI * 118;
  function formatHMS(ms){
    const totalSec = Math.floor(ms/1000);
    const h = Math.floor(totalSec/3600);
    const m = Math.floor((totalSec%3600)/60);
    const s = totalSec%60;
    return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':');
  }

  let audioCtx = null;
  function playTone(freq, dur){
    try{
      if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur/1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur/1000);
    }catch(e){}
  }

  function currentElapsedMs(){
    let ms = state.timer.elapsedBeforePause || 0;
    if(state.timer.running && state.timer.startedAt){
      ms += (Date.now() - state.timer.startedAt);
    }
    return ms;
  }

  function tick(){
    const ms = currentElapsedMs();
    document.getElementById('elapsed').textContent = formatHMS(ms);
    const phaseMs = ms - (state.lastBreakReminder || 0);
    const frac = Math.min(phaseMs / BREAK_INTERVAL, 1);
    const offset = RING_CIRC * (1 - frac);
    document.getElementById('ringProgress').style.strokeDashoffset = offset;
    if(state.timer.running && !state.timer.paused && phaseMs >= BREAK_INTERVAL){
      showBreakReminder();
    }
  }

  function resumeTicking(){
    document.getElementById('elapsed').classList.add('active', 'pulse');
    document.getElementById('subjectLabel').textContent = state.timer.subject;
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = false;
    document.getElementById('pauseBtn').textContent = 'Pause';
    document.getElementById('pauseBtn').className = 'btn btn-pause';
    document.getElementById('subjectSelect').value = state.timer.subject;
    document.getElementById('subjectSelect').disabled = true;
    document.getElementById('devBreakTestBtn').disabled = false;
    document.body.classList.add('timer-active', 'focus-mode');
    clearInterval(tickHandle);
    tickHandle = setInterval(tick, 1000);
    tick();
  }

  function restorePausedState(){
    const ms = state.timer.elapsedBeforePause || 0;
    document.getElementById('elapsed').textContent = formatHMS(ms);
    document.getElementById('elapsed').classList.add('active');
    document.getElementById('elapsed').classList.remove('pulse');
    document.getElementById('subjectLabel').textContent = state.timer.subject;
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = false;
    document.getElementById('pauseBtn').textContent = 'Resume';
    document.getElementById('pauseBtn').className = 'btn btn-resume';
    document.getElementById('subjectSelect').value = state.timer.subject;
    document.getElementById('subjectSelect').disabled = true;
    document.getElementById('devBreakTestBtn').disabled = false;
    document.body.classList.add('timer-active');
    document.body.classList.remove('focus-mode');
    const phaseMs = ms - (state.lastBreakReminder || 0);
    const frac = Math.min(phaseMs / BREAK_INTERVAL, 1);
    const offset = RING_CIRC * (1 - frac);
    document.getElementById('ringProgress').style.strokeDashoffset = offset;
  }

  document.getElementById('startBtn').addEventListener('click', ()=>{
    const subject = document.getElementById('subjectSelect').value;
    if(!subject || subject === MANAGE_SUBJECTS_VALUE){
      const subjectsNav = document.querySelector('.nav-item[data-page="subjects"]');
      if(subjectsNav) subjectsNav.click();
      return;
    }
    state.timer = { running:true, paused:false, subject, startedAt: Date.now(), elapsedBeforePause: 0 };
    state.lastBreakReminder = 0;
    queueSave();
    playTone(660, 80);
    resumeTicking();
  });

  document.getElementById('stopBtn').addEventListener('click', ()=>{
    const ms = currentElapsedMs();
    if(ms < 1000){
      cancelTimer();
      playTone(350, 80);
      return;
    }
    const note = document.getElementById('noteInput').value.trim();
    const now = Date.now();

    const rawSession = {
      id: 's' + now.toString(36) + Math.random().toString(36).slice(2,6),
      subject: state.timer.subject,
      durationMs: ms,
      note,
      startedAt: state.timer.startedAt || (now - ms),
      endedAt: now
    };

    // Split at midnight boundaries — may produce 1 or more pieces
    const pieces = splitSessionsByMidnight(rawSession);

    // Insert newest (last piece = most recent) at front of log
    pieces.reverse().forEach(p => state.sessions.unshift(p));

    cancelTimer();
    playTone(440, 120);
    showToast(rawSession.subject, ms);
    document.getElementById('noteInput').value = '';
    queueSave();
    renderAll();
  });

  document.getElementById('pauseBtn').addEventListener('click', ()=>{
    if(state.timer.paused){
      playTone(550, 80);
      state.timer.running = true;
      state.timer.startedAt = Date.now();
      state.timer.paused = false;
      document.getElementById('pauseBtn').textContent = 'Pause';
      document.getElementById('pauseBtn').className = 'btn btn-pause';
      document.getElementById('elapsed').classList.add('pulse');
      document.body.classList.add('focus-mode');
      clearInterval(tickHandle);
      tickHandle = setInterval(tick, 1000);
      tick();
    } else {
      const now = Date.now();
      state.timer.elapsedBeforePause += (now - state.timer.startedAt);
      state.timer.startedAt = null;
      state.timer.running = false;
      state.timer.paused = true;
      playTone(350, 80);
      clearInterval(tickHandle);
      document.getElementById('pauseBtn').textContent = 'Resume';
      document.getElementById('pauseBtn').className = 'btn btn-resume';
      document.getElementById('elapsed').classList.remove('pulse');
      document.body.classList.remove('focus-mode');
      queueSave();
    }
  });

  function cancelTimer(){
    clearInterval(tickHandle);
    state.timer = { running:false, paused:false, subject: state.timer.subject, startedAt:null, elapsedBeforePause:0 };
    document.getElementById('elapsed').textContent = '00:00:00';
    document.getElementById('elapsed').classList.remove('active','pulse');
    document.getElementById('subjectLabel').textContent = '';
    document.getElementById('ringProgress').style.strokeDashoffset = RING_CIRC;
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('pauseBtn').textContent = 'Pause';
    document.getElementById('pauseBtn').className = 'btn btn-pause';
    document.getElementById('devBreakTestBtn').disabled = true;
    document.getElementById('subjectSelect').disabled = false;
    state.lastBreakReminder = 0;
    document.body.classList.remove('focus-mode', 'timer-active');
    clearInterval(breakCountdownHandle);
    document.getElementById('breakOverlay').classList.remove('visible', 'hiding');
    queueSave();
  }

  function showToast(subject, durationMs){
    const totalMin = Math.round(durationMs/60000);
    let timeStr;
    if(totalMin < 1){
      timeStr = '<1m';
    } else if(totalMin >= 60){
      const h = Math.floor(totalMin/60);
      const m = totalMin%60;
      timeStr = h + 'h' + (m ? ' ' + m + 'm' : '');
    } else {
      timeStr = totalMin + 'm';
    }
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = '<span class="toast-icon">✓</span><span>' + subject + ' — ' + timeStr + ' logged</span>';
    container.appendChild(toast);
    setTimeout(()=>{
      toast.classList.add('out');
      setTimeout(()=> toast.remove(), 350);
    }, 2000);
  }

  let breakCountdownHandle = null;

  function showBreakReminder(){
    const overlay = document.getElementById('breakOverlay');
    if(overlay.classList.contains('visible')) return;
    overlay.classList.remove('hiding');
    overlay.classList.add('visible');

    let countdown = 60;
    const cdText = document.getElementById('cdText');
    const cdProg = document.getElementById('cdProgress');
    const CIRC = 163.36;

    cdText.textContent = countdown;
    cdProg.style.strokeDashoffset = '0';

    document.getElementById('breakDismiss').onclick = ()=>{
      hideBreakReminder(false);
    };
    document.getElementById('breakRest').onclick = ()=>{
      hideBreakReminder(true);
    };

    clearInterval(breakCountdownHandle);
    breakCountdownHandle = setInterval(()=>{
      countdown--;
      cdText.textContent = countdown;
      cdProg.style.strokeDashoffset = CIRC * (1 - countdown / 60);
      if(countdown <= 0){
        clearInterval(breakCountdownHandle);
        hideBreakReminder(false);
      }
    }, 1000);
  }

  function hideBreakReminder(rest){
    clearInterval(breakCountdownHandle);
    const overlay = document.getElementById('breakOverlay');
    if(!overlay.classList.contains('visible')) return;
    state.lastBreakReminder = currentElapsedMs();
    queueSave();
    overlay.classList.add('hiding');
    overlay.classList.remove('visible');
    if(rest){
      const pauseBtn = document.getElementById('pauseBtn');
      if(pauseBtn && !pauseBtn.disabled && !state.timer.paused && state.timer.running){
        pauseBtn.click();
      }
    }
  }

  function fmtHrMin(ms){
    const totalMin = Math.round(ms/60000);
    const h = Math.floor(totalMin/60);
    const m = totalMin%60;
    return h + 'h ' + m + 'm';
  }

  function startOfDay(ts){
    const d = new Date(ts);
    d.setHours(0,0,0,0);
    return d.getTime();
  }

  // ============================================================
  // DAY BUCKETING
  // For split sessions we use startedAt (the beginning of that
  // piece) as the bucket key — this is the day the student was
  // actually studying during that piece.
  // For legacy sessions without startedAt we fall back to endedAt.
  // ============================================================
  function sessionDayKey(s){
    const ts = s.startedAt || s.endedAt;
    return startOfDay(ts);
  }

  function renderStats(){
    const now = Date.now();
    const todayStart = startOfDay(now);

    let today = 0;
    const byDay = {};
    state.sessions.forEach(s=>{
      const dk = sessionDayKey(s);
      const dms = s.durationMs || 0;
      byDay[dk] = (byDay[dk] || 0) + dms;
      if(dk === todayStart) today += dms;
    });

    document.getElementById('statToday').textContent = fmtHrMin(today);

    const bestMs = Object.values(byDay).reduce((max, ms) => Math.max(max, ms), 0);
    document.getElementById('statBestDay').textContent = fmtHrMin(bestMs);
  }

  function computeBreakdown(sessions){
    const bySubject = {};
    sessions.forEach(s=>{
      bySubject[s.subject] = (bySubject[s.subject]||0) + (s.durationMs||0);
    });
    return Object.entries(bySubject).sort((a,b)=>b[1]-a[1]);
  }

  function renderBreakdownInto(containerId, entries, emptyMsg){
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if(!entries.length){
      container.innerHTML = `<div class="empty">${emptyMsg}</div>`;
      return;
    }
    const max = entries[0][1];
    entries.forEach(([subject, ms])=>{
      const row = document.createElement('div');
      row.className = 'bar-row';
      const pct = Math.max(4, Math.round((ms/max)*100));
      row.innerHTML = `
        <div class="bar-name">${escapeHtml(subject)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-time">${fmtHrMin(ms)}</div>
      `;
      container.appendChild(row);
    });
  }

   const DONUT_COLORS = ['#E8A33D','#7C9A82','#D4537E','#5DCAA5','#378ADD','#AFA9EC','#F0997B','#ED93B1'];

  function getSubjectColor(subject){
    if(!state.subjectColors) state.subjectColors = {};
    if(!state.subjectColors[subject]){
      const used = new Set(Object.values(state.subjectColors));
      const free = DONUT_COLORS.find(c => !used.has(c));
      state.subjectColors[subject] = free || DONUT_COLORS[Object.keys(state.subjectColors).length % DONUT_COLORS.length];
    }
    return state.subjectColors[subject];
  }

  function fmtMinShort(ms){
    const totalMin = Math.round(ms/60000);
    if(totalMin < 60) return totalMin + 'm';
    const h = Math.floor(totalMin/60), m = totalMin%60;
    return m ? `${h}h${m}m` : `${h}h`;
  }

  function buildMiniDonutSVG(ms, maxMs, color){
    const r = 34, cx = 40, cy = 40, stroke = 8;
    const circ = 2*Math.PI*r;
    const frac = maxMs > 0 ? Math.min(ms/maxMs, 1) : 0;
    const dash = frac*circ;
    return `
      <svg viewBox="0 0 80 80" class="mini-donut-svg">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--paper-raised)" stroke-width="${stroke}"></circle>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
          stroke-linecap="round" stroke-dasharray="${dash} ${circ-dash}"
          transform="rotate(-90 ${cx} ${cy})"></circle>
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" class="mini-donut-text">${fmtMinShort(ms)}</text>
      </svg>
    `;
  }

  function renderTodayDonuts(){
    const now = Date.now();
    const todayStart = startOfDay(now);
    // Use sessionDayKey so split pieces land on the right day
    const todaySessions = state.sessions.filter(s => sessionDayKey(s) === todayStart);
    const entries = computeBreakdown(todaySessions);
    const container = document.getElementById('breakdownList');
    container.innerHTML = '';

    if(!entries.length){
      container.innerHTML = '<div class="empty">No sessions yet today — start the timer above.</div>';
      return;
    }

    const maxMs = entries[0][1];
    entries.forEach(([subject, ms])=>{
      const color = getSubjectColor(subject);
      const item = document.createElement('div');
      item.className = 'mini-donut-item';
      item.innerHTML = `
        ${buildMiniDonutSVG(ms, maxMs, color)}
        <div class="mini-donut-label">${escapeHtml(subject)}</div>
      `;
      container.appendChild(item);
    });
  }

  function renderBreakdown(){
    renderTodayDonuts();
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function fmtDate(ts){
    const d = new Date(ts);
    const today = startOfDay(Date.now());
    const day = startOfDay(ts);
    const diffDays = Math.round((today-day)/DAY_MS);
    const time = d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    if(diffDays===0) return 'Today, ' + time;
    if(diffDays===1) return 'Yesterday, ' + time;
    return d.toLocaleDateString([], {month:'short', day:'numeric'}) + ', ' + time;
  }

  let logSearchQuery = '';

  function renderLog(){
    const list = document.getElementById('logList');
    const countEl = document.getElementById('logCount');
    list.innerHTML = '';
    const q = logSearchQuery.toLowerCase().trim();
    const filtered = q ? state.sessions.filter(s=>{
      return (s.subject||'').toLowerCase().includes(q) || (s.note||'').toLowerCase().includes(q);
    }) : state.sessions;
    countEl.textContent = filtered.length ? filtered.length + ' session' + (filtered.length===1?'':'s') : 'Nothing logged yet.';
    if(!filtered.length){
      list.innerHTML = '<div class="empty">Nothing logged yet. Your first session will show up here.</div>';
      return;
    }
    filtered.slice(0, 100).forEach(s=>{
      const row = document.createElement('div');
      row.className = 'log-row';
      const timeLabel = s.startedAt
        ? new Date(s.startedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) +
          ' – ' +
          new Date(s.endedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
        : '';
      const splitBadge = s._split ? '<span class="log-split-badge">continued</span>' : '';
      row.innerHTML = `
        <div class="log-dot"></div>
        <div class="log-main">
          <div class="log-subject">${escapeHtml(s.subject)} ${splitBadge}</div>
          ${s.note ? `<div class="log-note">${escapeHtml(s.note)}</div>` : ''}
          ${timeLabel ? `<div class="log-note">${timeLabel}</div>` : ''}
        </div>
        <div class="log-meta">
          <div class="log-dur">${formatHMS(s.durationMs)}</div>
          <div class="log-date">${fmtDate(s.endedAt)}</div>
        </div>
        <button class="log-trim" data-id="${s.id}" aria-label="Trim forgotten time">⏱ trim</button>
      `;
      list.appendChild(row);

      const trimPanel = document.createElement('div');
      trimPanel.className = 'log-trim-panel';
      trimPanel.id = 'trim-' + s.id;
      trimPanel.innerHTML = `
        <span>Forgot the timer was running? Remove</span>
        <input type="number" class="log-trim-input" min="1" max="${Math.max(1, Math.round(s.durationMs/60000))}" placeholder="min">
        <span>minutes from the end.</span>
        <button class="log-trim-apply" data-id="${s.id}">Apply</button>
        <button class="log-trim-cancel" data-id="${s.id}">Cancel</button>
      `;
      list.appendChild(trimPanel);
    });

    list.querySelectorAll('.log-trim').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-id');
        document.querySelectorAll('.log-trim-panel').forEach(p=>{
          p.classList.toggle('open', p.id === 'trim-' + id ? !p.classList.contains('open') : false);
        });
        const panel = document.getElementById('trim-' + id);
        const input = panel.querySelector('.log-trim-input');
        if(panel.classList.contains('open')) input.focus();
      });
    });

    function applyTrim(id, panel){
      const session = state.sessions.find(s=>s.id===id);
      if(!session) return;
      const input = panel.querySelector('.log-trim-input');
      const trimMin = parseFloat(input.value);
      if(!Number.isFinite(trimMin) || trimMin <= 0) return;
      const dms = session.durationMs || 0;
      const trimMs = Math.min(Math.round(trimMin*60000), dms);

      const baseId = id.replace(/_p\d+$/, '');
      const group = state.sessions.filter(s=> s.id.replace(/_p\d+$/, '') === baseId);
      const groupTotal = group.reduce((sum,s)=>sum+(s.durationMs||0), 0);
      let remainingTrim = Math.min(trimMs, groupTotal);

      group.sort((a,b)=> b.endedAt - a.endedAt);
      group.forEach(s=>{
        if(remainingTrim <= 0) return;
        const cut = Math.min(remainingTrim, s.durationMs || 0);
        s.durationMs = (s.durationMs || 0) - cut;
        s.endedAt -= cut;
        remainingTrim -= cut;
      });

      state.sessions = state.sessions.filter(s=> (s.durationMs||0) >= 1000);
      queueSave();
      renderAll();
    }

    list.querySelectorAll('.log-trim-apply').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-id');
        applyTrim(id, document.getElementById('trim-' + id));
      });
    });
    list.querySelectorAll('.log-trim-input').forEach(inp=>{
      inp.addEventListener('keydown', e=>{
        if(e.key === 'Enter'){
          const panel = inp.closest('.log-trim-panel');
          applyTrim(panel.id.replace('trim-',''), panel);
        }
      });
    });
    list.querySelectorAll('.log-trim-cancel').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        document.getElementById('trim-' + btn.getAttribute('data-id')).classList.remove('open');
      });
    });
  }

  // ============================================================
  // SUBJECTS PAGE
  // ============================================================
  function renderSubjectsPage(){
    const totals = {};
    state.sessions.forEach(s=>{ totals[s.subject] = (totals[s.subject]||0) + (s.durationMs||0); });
    const list = document.getElementById('subjectsList');
    list.innerHTML = '';
    if(!state.subjects.length){
      list.innerHTML = '<div class="empty">No subjects yet — add one above.</div>';
      return;
    }
    state.subjects.forEach(s=>{
      const row = document.createElement('div');
      row.className = 'subject-row';
      row.innerHTML = `
        <div class="subject-name">${escapeHtml(s)}</div>
        <div class="subject-row-right">
          <div class="subject-stat">${fmtHrMin(totals[s]||0)} logged</div>
          <button class="subject-del" data-subject="${escapeHtml(s)}" aria-label="Delete subject">✕</button>
        </div>
      `;
      list.appendChild(row);
    });

    // Subject deletion — warns that all sessions logged under this
    // subject will be permanently removed before doing so.
    list.querySelectorAll('.subject-del').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const subject = btn.getAttribute('data-subject');
        const sessionCount = state.sessions.filter(s=>s.subject===subject).length;
        const loggedMs = totals[subject] || 0;
        const warning = sessionCount
          ? `Delete "${subject}"? This will permanently erase ${sessionCount} logged session${sessionCount===1?'':'s'} (${fmtHrMin(loggedMs)}) for this subject. This cannot be undone.`
          : `Delete "${subject}"? No sessions are logged for it yet.`;
        if(!confirm(warning)) return;

        state.subjects = state.subjects.filter(x=>x!==subject);
        state.sessions = state.sessions.filter(x=>x.subject!==subject);
        delete state.subjectColors[subject];
        if(state.timer.subject === subject){
          state.timer.subject = state.subjects[0] || null;
        }

        renderSubjectOptions();
        queueSave();
        renderAll();
      });
    });

    // Refresh the subject deep-dive dropdown when subjects are added/removed
    if(document.getElementById('subjectDetailSelect')) renderSubjectDetailOptions();
  }
  window.addEventListener('focus:render-subjects', renderSubjectsPage);

  // ============================================================
  // PLANNER
  // ============================================================
  let pSelectedDay = startOfDay(Date.now());
  let pCalView = new Date();

  function pUid(){
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  }

  function renderStickyNote(){
    const body = document.getElementById('snBody');
    if(!body) return;
    const today = startOfDay(Date.now());
    const goals = state.pGoals[today] || [];
    body.innerHTML = '';
    if(!goals.length){
      body.innerHTML = '<div class="sn-empty">Nothing planned</div>';
      return;
    }
    goals.forEach(g => {
      const row = document.createElement('div');
      row.className = 'sn-item';

      const cb = document.createElement('div');
      cb.className = 'sn-cb' + (g.done ? ' checked' : '');
      cb.addEventListener('click', () => {
          g.done = !g.done;
          renderStickyNote();
          renderGoals();
          renderCalendar();
          queueSave();
          renderCarryForward();
      });

      const txt = document.createElement('span');
      txt.className = 'sn-text' + (g.done ? ' done' : '');
      txt.textContent = g.text;

      row.appendChild(cb);
      row.appendChild(txt);
      body.appendChild(row);
    });
  }

  function renderPlanner(){
    const subjSel = document.getElementById('pSubjectSelect');
    if(subjSel){
      subjSel.innerHTML = '<option value="">Subject</option>';
      (state.subjects || []).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        subjSel.appendChild(opt);
      });
    }
    renderCalendar();
    renderGoals();
    renderStickyNote();
    renderCarryForward();
  }

  function renderCalendar(){
    const grid = document.getElementById('pCalGrid');
    const monthEl = document.getElementById('pCalMonth');
    if(!grid || !monthEl) return;
    grid.innerHTML = '';

    const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    dows.forEach(d => {
      const el = document.createElement('div');
      el.className = 'p-cal-dow';
      el.textContent = d;
      grid.appendChild(el);
    });

    const year = pCalView.getFullYear();
    const month = pCalView.getMonth();
    monthEl.textContent = pCalView.toLocaleDateString([], { month:'long', year:'numeric' });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = startOfDay(Date.now());
    const dayTotals = computeDayTotals();

    let exams = [];
    try{ exams = JSON.parse(localStorage.getItem('focus_exams')) || []; }catch(e){}

    const prevMonthDays = new Date(year, month, 0).getDate();
    for(let i = firstDay - 1; i >= 0; i--){
      const day = prevMonthDays - i;
      const d = new Date(year, month - 1, day);
      const ts = startOfDay(d.getTime());
      calCreateCell(grid, day, ts, today, true, dayTotals, exams);
    }

    for(let day = 1; day <= daysInMonth; day++){
      const d = new Date(year, month, day);
      const ts = startOfDay(d.getTime());
      calCreateCell(grid, day, ts, today, false, dayTotals, exams);
    }

    const totalCells = firstDay + daysInMonth;
    const remaining = (7 - (totalCells % 7)) % 7;
    for(let day = 1; day <= remaining; day++){
      const d = new Date(year, month + 1, day);
      const ts = startOfDay(d.getTime());
      calCreateCell(grid, day, ts, today, true, dayTotals, exams);
    }
  }

  function calCreateCell(container, dayNum, ts, today, isOther, dayTotals, exams){
    const cell = document.createElement('div');
    cell.className = 'p-cal-cell';
    if(isOther) cell.classList.add('other');
    if(ts === today) cell.classList.add('today');
    if(ts === pSelectedDay) cell.classList.add('active');

    const num = document.createElement('div');
    num.className = 'cal-num';
    num.textContent = dayNum;
    cell.appendChild(num);

    const studyMs = dayTotals[ts] || 0;
    const timeEl = document.createElement('div');
    timeEl.className = 'cal-time';
    if(studyMs > 0){
      timeEl.textContent = fmtMinShort(studyMs);
    }
    cell.appendChild(timeEl);

    const labelEl = document.createElement('div');
    labelEl.className = 'cal-label';

    let hasLabel = false;

    if(ts === today){
      labelEl.textContent = 'today';
      labelEl.classList.add('cal-label-today');
      cell.appendChild(labelEl);
      hasLabel = true;
    }

    if(state.pMockDays && state.pMockDays[ts]){
      const mockEl = document.createElement('div');
      mockEl.className = 'p-mock-badge';
      mockEl.textContent = 'MOCK';
      cell.appendChild(mockEl);
    }

    if(exams && exams.length){
      const d = new Date(ts);
      const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      const exam = exams.find(e => e.date === dateStr);
      if(exam){
        const examEl = document.createElement('div');
        examEl.className = 'cal-label cal-label-exam';
        examEl.textContent = exam.name;
        cell.appendChild(examEl);
        hasLabel = true;
      }
    }

    cell.addEventListener('click', () => {
      pSelectedDay = ts;
      if(isOther){
        pCalView = new Date(new Date(ts).getFullYear(), new Date(ts).getMonth(), 1);
      }
      renderCalendar();
      renderGoals();
      renderCarryForward();
    });

    container.appendChild(cell);
  }

  function renderGoals(){
    const list = document.getElementById('pGoalList');
    const title = document.getElementById('pGoalsTitle');
    const fill = document.getElementById('pProgressFill');
    const label = document.getElementById('pProgressLabel');
    if(!list || !title) return;

    const d = new Date(pSelectedDay);
    const dowNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    title.textContent = dowNames[d.getDay()] + ', ' + d.toLocaleDateString([], {month:'long', day:'numeric'});

    let mockBtn = document.getElementById('pMockBtn');
    if(!mockBtn){
      mockBtn = document.createElement('button');
      mockBtn.id = 'pMockBtn';
      mockBtn.className = 'p-mock-btn';
      title.parentNode.appendChild(mockBtn);
    }
    const isMock = state.pMockDays && state.pMockDays[pSelectedDay];
    mockBtn.textContent = isMock ? 'Mock' : '+ Mock';
    mockBtn.classList.toggle('active', !!isMock);
    mockBtn.onclick = () => {
      if(!state.pMockDays) state.pMockDays = {};
      if(state.pMockDays[pSelectedDay]){
        delete state.pMockDays[pSelectedDay];
      } else {
        state.pMockDays[pSelectedDay] = true;
      }
      queueSave();
      renderCalendar();
      renderGoals();
    };

    const goals = state.pGoals[pSelectedDay] || [];
    const done = goals.filter(g => g.done).length;
    const total = goals.length;
    const pct = total ? (done / total) * 100 : 0;
    if(fill) fill.style.width = pct + '%';
    if(label) label.textContent = done + ' / ' + total + ' done';

    list.innerHTML = '';
    if(!goals.length){
      const empty = document.createElement('div');
      empty.className = 'p-goal-empty';
      empty.textContent = 'No goals for this day.';
      list.appendChild(empty);
    } else {
      goals.forEach(g => {
        const row = document.createElement('div');
        row.className = 'p-goal';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'gcb';
        cb.checked = g.done;
        cb.addEventListener('change', () => {
          g.done = cb.checked;
          state.pGoals[pSelectedDay] = goals;
          renderGoals();
          renderCalendar();
          renderStickyNote();
          queueSave();
          renderCarryForward();
        });

        const txt = document.createElement('div');
        txt.className = 'gtxt' + (g.done ? ' done' : '');
        txt.textContent = g.text;

        const sub = document.createElement('span');
        if(g.subject){
          sub.className = 'gsub';
          sub.textContent = g.subject;
        }

        const del = document.createElement('button');
        del.className = 'gdel';
        del.textContent = '✕';
        del.addEventListener('click', () => {
          state.pGoals[pSelectedDay] = goals.filter(x => x.id !== g.id);
          if(!state.pGoals[pSelectedDay].length) delete state.pGoals[pSelectedDay];
          queueSave();
          renderPlanner();
        });

        row.appendChild(cb);
        row.appendChild(txt);
        if(g.subject) row.appendChild(sub);
        row.appendChild(del);
        list.appendChild(row);
      });
    }
  }



  function renderCarryForward(){
    const card = document.getElementById('pCarryCard');
    const text = document.getElementById('pCarryText');
    const btn = document.getElementById('pCarryBtn');
    if(!card || !text || !btn) return;

    const today = startOfDay(Date.now());
    const yesterday = today - 86400000;
    const yesterdayGoals = state.pGoals[yesterday] || [];
    const incomplete = yesterdayGoals.filter(g => !g.done);

    if(!incomplete.length){
      card.style.display = 'none';
      return;
    }

    card.style.display = 'flex';
    text.textContent = incomplete.length + ' goal' + (incomplete.length > 1 ? 's' : '') + ' left incomplete from yesterday.';
    btn.onclick = () => {
      const todayGoals = state.pGoals[today] || [];
      incomplete.forEach(g => {
        todayGoals.push({
          id: pUid(),
          text: g.text,
          done: false,
          subject: g.subject || ''
        });
      });
      state.pGoals[today] = todayGoals;
      queueSave();
      renderPlanner();
    };
  }

  function addGoal(text, subject){
    if(!text) return;
    if(!state.pGoals[pSelectedDay]) state.pGoals[pSelectedDay] = [];
    state.pGoals[pSelectedDay].push({
      id: pUid(),
      text,
      done: false,
      subject: subject || ''
    });
    queueSave();
  }

  function setupPlanner(){
    const input = document.getElementById('pGoalInput');
    const subjSel = document.getElementById('pSubjectSelect');
    const addBtn = document.getElementById('pAddBtn');
    if(!input || !addBtn) return;

    function populateSubjects(){
      subjSel.innerHTML = '<option value="">Subject</option>';
      (state.subjects || []).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        subjSel.appendChild(opt);
      });
    }

    function handleAdd(){
      const text = input.value.trim();
      if(!text) return;
      addGoal(text, subjSel.value);
      input.value = '';
      subjSel.value = '';
      renderPlanner();
    }

    if(document.querySelector('#pCalPrev').dataset.bound) return;
    document.querySelector('#pCalPrev').dataset.bound = '1';

    addBtn.addEventListener('click', handleAdd);
    input.addEventListener('keydown', e => { if(e.key === 'Enter') handleAdd(); });
    populateSubjects();

    document.getElementById('pCalPrev').addEventListener('click', () => {
      pCalView = new Date(pCalView.getFullYear(), pCalView.getMonth() - 1, 1);
      renderCalendar();
    });
    document.getElementById('pCalNext').addEventListener('click', () => {
      pCalView = new Date(pCalView.getFullYear(), pCalView.getMonth() + 1, 1);
      renderCalendar();
    });
    document.getElementById('pCalToday').addEventListener('click', () => {
      const now = new Date();
      pCalView = new Date(now.getFullYear(), now.getMonth(), 1);
      pSelectedDay = startOfDay(Date.now());
      renderCalendar();
      renderGoals();
      renderCarryForward();
    });
  }

  window.addEventListener('focus:render-subjects', () => {
    const sel = document.getElementById('pSubjectSelect');
    if(!sel) return;
    sel.innerHTML = '<option value="">Subject</option>';
    (state.subjects || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      sel.appendChild(opt);
    });
  });

  document.addEventListener('DOMContentLoaded', setupPlanner);
  if(document.readyState !== 'loading') setupPlanner();

  // Sticky note drag & close
  (function(){
    const header = document.querySelector('.sn-header');
    const closeBtn = document.getElementById('snClose');
    if(!header) return;

    if(closeBtn){
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        document.getElementById('stickyNote').style.display = 'none';
      });
    }

    let dragging = false, startX, startY, startR, startB;
    header.addEventListener('mousedown', e => {
      if(closeBtn && closeBtn.contains(e.target)) return;
      dragging = true;
      const rect = document.getElementById('stickyNote').getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startR = window.innerWidth - rect.right;
      startB = window.innerHeight - rect.bottom;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if(!dragging) return;
      const n = document.getElementById('stickyNote');
      n.style.right = (startR - (e.clientX - startX)) + 'px';
      n.style.bottom = (startB - (e.clientY - startY)) + 'px';
      n.style.left = 'auto'; n.style.top = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  })();

  // ============================================================
  // EXAM COUNTDOWN
  // ============================================================
  (function(){
    const EXAM_KEY = 'focus_exams';

    function loadExams(){
      try{ return JSON.parse(localStorage.getItem(EXAM_KEY)) || []; }catch(e){ return []; }
    }
    function saveExams(arr){
      localStorage.setItem(EXAM_KEY, JSON.stringify(arr));
    }

    function renderCountdown(){
      const strip = document.getElementById('examCountdownStrip');
      const exams = loadExams();
      if(!exams.length){ strip.style.display='none'; return; }

      strip.style.display = 'flex';
      strip.innerHTML = '';

      exams.forEach((exam, idx) => {
        const now = new Date();
        const target = new Date(exam.date + 'T00:00:00');
        const diffMs = target - now;
        const diffDays = Math.ceil(diffMs / (1000*60*60*24));

        const card = document.createElement('div');
        card.className = 'ecc-card';

        const banner = document.createElement('div');
        banner.className = 'ecc-banner';
        if(exam.banner){
          banner.style.display = 'block';
          banner.style.backgroundImage = 'url(' + exam.banner + ')';
        } else {
          banner.style.display = 'none';
        }
        card.appendChild(banner);

        const body = document.createElement('div');
        body.className = 'ecc-body';

        const nameEl = document.createElement('div');
        nameEl.className = 'ecc-name';
        nameEl.textContent = exam.name || 'Exam';
        body.appendChild(nameEl);

        const daysEl = document.createElement('div');
        daysEl.className = 'ecc-days';

        const subEl = document.createElement('div');
        subEl.className = 'ecc-sub';

        if(diffDays < 0){
          daysEl.textContent = 'Completed';
          subEl.textContent = exam.date;
        } else if(diffDays === 0){
          daysEl.textContent = 'Today!';
          subEl.textContent = 'Good luck';
        } else {
          daysEl.textContent = diffDays + (diffDays === 1 ? ' day' : ' days');
          subEl.textContent = target.toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'});
        }
        body.appendChild(daysEl);
        body.appendChild(subEl);
        card.appendChild(body);

        const clear = document.createElement('button');
        clear.className = 'ecc-clear';
        clear.textContent = '✕';
        clear.addEventListener('click', () => {
          exams.splice(idx, 1);
          saveExams(exams);
          renderCountdown();
        });
        card.appendChild(clear);

        strip.appendChild(card);
      });
    }

    document.getElementById('examAddBtn').addEventListener('click', ()=>{
      document.getElementById('examName').value = '';
      document.getElementById('examDate').value = '';
      document.getElementById('examBanner').value = '';
      document.getElementById('examModal').classList.add('visible');
    });

    function closeModal(){
      document.getElementById('examModal').classList.remove('visible');
    }

    document.getElementById('examModalClose').addEventListener('click', closeModal);
    document.getElementById('examModalCancel').addEventListener('click', closeModal);
    document.getElementById('examModal').addEventListener('click', e=>{
      if(e.target === document.getElementById('examModal')) closeModal();
    });

    document.getElementById('examModalSave').addEventListener('click', ()=>{
      const name = document.getElementById('examName').value.trim();
      const date = document.getElementById('examDate').value;
      const banner = document.getElementById('examBanner').value.trim();
      if(!name || !date) return;
      const exams = loadExams();
      exams.push({ name, date, banner });
      saveExams(exams);
      closeModal();
      renderCountdown();
    });

    window.__renderExamCountdown = renderCountdown;
    renderCountdown();
  })();

  function computeDayTotals(){
    const totals = {};
    state.sessions.forEach(s=>{
      const k = sessionDayKey(s);   // uses startedAt for split pieces
      totals[k] = (totals[k]||0) + (s.durationMs||0);
    });
    return totals;
  }

  function levelFor(ms){
    if(!ms) return 0;
    const min = ms/60000;
    if(min < 15) return 1;
    if(min < 45) return 2;
    if(min < 90) return 3;
    return 4;
  }

  function computeStreaks(dayTotals){
    const today = startOfDay(Date.now());
    let current = 0;
    let cursor = today;
    if(!dayTotals[today]) cursor -= DAY_MS;
    while(dayTotals[cursor]){
      current++;
      cursor -= DAY_MS;
    }
    const days = Object.keys(dayTotals).map(Number).sort((a,b)=>a-b);
    let longest = 0, run = 0, prev = null;
    days.forEach(d=>{
      if(prev !== null && d - prev === DAY_MS){ run++; } else { run = 1; }
      longest = Math.max(longest, run);
      prev = d;
    });
    return { current, longest };
  }

  // ---- PACE: daily average on active days + switchable period comparison ----
  let paceRange = 'week';

  function setupPaceToggle(){
    const toggle = document.getElementById('paceRangeToggle');
    if(!toggle || toggle.dataset.bound) return;
    toggle.dataset.bound = '1';
    toggle.querySelectorAll('.range-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        paceRange = btn.getAttribute('data-range');
        toggle.querySelectorAll('.range-btn').forEach(b=>b.classList.toggle('active', b===btn));
        renderPace(computeDayTotals());
      });
    });
  }

  function renderPace(dayTotals){
    const activeDays = Object.values(dayTotals).filter(ms=>ms>0);
    const avgMs = activeDays.length ? activeDays.reduce((a,b)=>a+b,0) / activeDays.length : 0;
    document.getElementById('paceDailyAvg').textContent = fmtHrMin(avgMs);

    const today = startOfDay(Date.now());

    let currentMs = 0, previousMs = 0, currentLabel = '', previousLabel = '';

    if(paceRange === 'week'){
      const todayDow = new Date(today).getDay();
      const thisWeekStart = today - todayDow * DAY_MS;
      const lastWeekStart = thisWeekStart - 7 * DAY_MS;
      Object.entries(dayTotals).forEach(([k, ms])=>{
        const ts = Number(k);
        if(ts >= thisWeekStart && ts <= today) currentMs += ms;
        else if(ts >= lastWeekStart && ts < thisWeekStart) previousMs += ms;
      });
      currentLabel = 'This week';
      previousLabel = 'Last week';
    } else if(paceRange === 'month'){
      const thisMonthStart = new Date(new Date(today).getFullYear(), new Date(today).getMonth(), 1).getTime();
      const lastMonthStart = new Date(new Date(today).getFullYear(), new Date(today).getMonth() - 1, 1).getTime();
      Object.entries(dayTotals).forEach(([k, ms])=>{
        const ts = Number(k);
        if(ts >= thisMonthStart && ts <= today) currentMs += ms;
        else if(ts >= lastMonthStart && ts < thisMonthStart) previousMs += ms;
      });
      currentLabel = 'This month';
      previousLabel = 'Last month';
    } else {
      const thisYearStart = new Date(new Date(today).getFullYear(), 0, 1).getTime();
      const lastYearStart = new Date(new Date(today).getFullYear() - 1, 0, 1).getTime();
      Object.entries(dayTotals).forEach(([k, ms])=>{
        const ts = Number(k);
        if(ts >= thisYearStart && ts <= today) currentMs += ms;
        else if(ts >= lastYearStart && ts < thisYearStart) previousMs += ms;
      });
      currentLabel = 'This year';
      previousLabel = 'Last year';
    }

    document.getElementById('paceCurrentLabel').textContent = currentLabel;
    document.getElementById('pacePreviousLabel').textContent = previousLabel;
    document.getElementById('paceThisWeek').textContent = fmtHrMin(currentMs);
    document.getElementById('paceLastWeek').textContent = fmtHrMin(previousMs);

    const deltaEl = document.getElementById('paceWeekDelta');
    if(previousMs === 0 && currentMs === 0){
      deltaEl.textContent = 'no data yet';
      deltaEl.className = 'pace-sub';
    } else if(previousMs === 0){
      deltaEl.textContent = 'first period tracked';
      deltaEl.className = 'pace-sub up';
    } else {
      const pct = Math.round(((currentMs - previousMs) / previousMs) * 100);
      const arrow = pct >= 0 ? '↑' : '↓';
      deltaEl.textContent = `${arrow} ${Math.abs(pct)}% vs ${previousLabel.toLowerCase()}`;
      deltaEl.className = 'pace-sub ' + (pct >= 0 ? 'up' : 'down');
    }
  }

  // ---- BAR GRAPH: week / month / year, switchable ----
  let bargraphRange = 'week';

  function renderBargraph(dayTotals){
    const today = startOfDay(Date.now());
    const container = document.getElementById('bargraphChart');
    const rangeLabelEl = document.getElementById('bargraphRangeLabel');
    container.innerHTML = '';

    let buckets = [];   // [{label, ms, isCurrent}]

    if(bargraphRange === 'week'){
      // Last 7 days, oldest to newest
      const dowShort = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      for(let i=6; i>=0; i--){
        const ts = today - i*DAY_MS;
        buckets.push({
          label: dowShort[new Date(ts).getDay()],
          ms: dayTotals[ts] || 0,
          isCurrent: i===0
        });
      }
      rangeLabelEl.textContent = 'last 7 days';
    }else if(bargraphRange === 'month'){
      // Last 30 days, grouped... actually show all 30 individual days (thin bars)
      for(let i=29; i>=0; i--){
        const ts = today - i*DAY_MS;
        const d = new Date(ts);
        buckets.push({
          label: d.getDate() === 1 || i===0 || i===29 ? d.toLocaleDateString([], {month:'short', day:'numeric'}) : '',
          ms: dayTotals[ts] || 0,
          isCurrent: i===0
        });
      }
      rangeLabelEl.textContent = 'last 30 days';
    }else{
      // Year: 12 calendar months, oldest to newest, summed
      const now = new Date(today);
      const months = [];
      for(let i=11; i>=0; i--){
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(d);
      }
      months.forEach((mDate, idx)=>{
        const mStart = mDate.getTime();
        const mEnd = new Date(mDate.getFullYear(), mDate.getMonth()+1, 1).getTime();
        let sum = 0;
        Object.entries(dayTotals).forEach(([k, ms])=>{
          const ts = Number(k);
          if(ts >= mStart && ts < mEnd) sum += ms;
        });
        buckets.push({
          label: mDate.toLocaleDateString([], {month:'short'}),
          ms: sum,
          isCurrent: idx === months.length-1
        });
      });
      rangeLabelEl.textContent = 'last 12 months';
    }

    const maxMs = Math.max(1, ...buckets.map(b=>b.ms));

    buckets.forEach(b=>{
      const col = document.createElement('div');
      col.className = 'bargraph-col';
      const heightPct = Math.max(b.ms > 0 ? 4 : 0, Math.round((b.ms/maxMs)*100));
      col.innerHTML = `
        <div class="bargraph-value">${b.ms ? fmtHrMin(b.ms) : '—'}</div>
        <div class="bargraph-bar-wrap">
          <div class="bargraph-bar${b.isCurrent ? ' today' : ''}" style="height:${heightPct}%"></div>
        </div>
        <div class="bargraph-label">${b.label}</div>
      `;
      container.appendChild(col);
    });
  }

  function setupBargraphToggle(){
    const toggle = document.getElementById('rangeToggle');
    if(toggle.dataset.bound) return;
    toggle.dataset.bound = '1';
    toggle.querySelectorAll('.range-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        bargraphRange = btn.getAttribute('data-range');
        toggle.querySelectorAll('.range-btn').forEach(b=>b.classList.toggle('active', b===btn));
        renderBargraph(computeDayTotals());
      });
    });
  }

  // ---- DAY-OF-WEEK PATTERN: average study time per weekday, all time ----
  function renderDowPattern(dayTotals){
    const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const sums = [0,0,0,0,0,0,0];
    const counts = [0,0,0,0,0,0,0];

    Object.entries(dayTotals).forEach(([k, ms])=>{
      const dow = new Date(Number(k)).getDay();
      sums[dow] += ms;
      counts[dow] += 1;
    });

    const avgs = sums.map((sum, i)=> counts[i] ? sum/counts[i] : 0);
    const maxAvg = Math.max(1, ...avgs);
    const bestDow = avgs.indexOf(Math.max(...avgs));

    const container = document.getElementById('dowChart');
    container.innerHTML = '';

    // Display Mon -> Sun order for readability
    const order = [1,2,3,4,5,6,0];
    order.forEach(dow=>{
      const pct = Math.max(avgs[dow] > 0 ? 3 : 0, Math.round((avgs[dow]/maxAvg)*100));
      const row = document.createElement('div');
      row.className = 'dow-row';
      row.innerHTML = `
        <div class="dow-name">${dowNames[dow]}</div>
        <div class="dow-track"><div class="dow-fill${dow===bestDow && avgs[dow]>0 ? ' best' : ''}" style="width:${pct}%"></div></div>
        <div class="dow-time">${avgs[dow] ? fmtHrMin(avgs[dow]) : '—'}</div>
      `;
      container.appendChild(row);
    });
  }

  // ---- SUBJECT COMPARISON (colored bars, switchable range) ----
  let subjectCompareRange = 'week';

  function rangeStartFor(range){
    const today = startOfDay(Date.now());
    if(range === 'week')  return today - 6*DAY_MS;
    if(range === 'month') return today - 29*DAY_MS;
    if(range === 'year')  return today - 364*DAY_MS;
    return 0; // all-time
  }

  function renderSubjectCompare(){
    const start = rangeStartFor(subjectCompareRange);
    const filtered = state.sessions.filter(s => sessionDayKey(s) >= start);
    const entries = computeBreakdown(filtered);
    const container = document.getElementById('subjectCompareChart');
    const legend = document.getElementById('subjectCompareLegend');
    container.innerHTML = '';
    legend.innerHTML = '';
    if(!entries.length){
      container.innerHTML = '<div class="empty">No sessions in this range yet.</div>';
      return;
    }
    const maxMs = entries[0][1];
    entries.forEach(([subject, ms])=>{
      const color = getSubjectColor(subject);
      const heightPct = Math.max(4, Math.round((ms/maxMs)*100));
      const col = document.createElement('div');
      col.className = 'bargraph-col';
      col.innerHTML = `
        <div class="bargraph-value">${fmtHrMin(ms)}</div>
        <div class="bargraph-bar-wrap">
          <div class="bargraph-bar" style="height:${heightPct}%; background:${color};"></div>
        </div>
        <div class="bargraph-label">${escapeHtml(subject)}</div>
      `;
      container.appendChild(col);

      const item = document.createElement('div');
      item.className = 'subject-compare-legend-item';
      item.innerHTML = `<span class="legend-dot" style="background:${color}"></span>${escapeHtml(subject)} — ${fmtHrMin(ms)}`;
      legend.appendChild(item);
    });
  }

  function setupSubjectCompareToggle(){
    const toggle = document.getElementById('subjectRangeToggle');
    if(toggle.dataset.bound) return;
    toggle.dataset.bound = '1';
    toggle.querySelectorAll('.range-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        subjectCompareRange = btn.getAttribute('data-range');
        toggle.querySelectorAll('.range-btn').forEach(b=>b.classList.toggle('active', b===btn));
        renderSubjectCompare();
      });
    });
  }

  // ---- SUBJECT DEEP DIVE (dropdown + fake loading) ----
  function renderSubjectDetailOptions(){
    const sel = document.getElementById('subjectDetailSelect');
    if(sel.dataset.bound !== '1'){
      sel.dataset.bound = '1';
      sel.addEventListener('change', e => loadSubjectDetail(e.target.value));
    }
    const prev = sel.value;
    sel.innerHTML = '';
    if(!state.subjects.length){
      sel.innerHTML = '<option value="">No subjects yet</option>';
      document.getElementById('subjectDetailContent').innerHTML = '<div class="empty">Add a subject first.</div>';
      document.getElementById('subjectDetailContent').classList.add('visible');
      return;
    }
    state.subjects.forEach(s=>{
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      sel.appendChild(opt);
    });
    const target = (prev && state.subjects.includes(prev)) ? prev : state.subjects[0];
    sel.value = target;
    loadSubjectDetail(target);
  }

  function loadSubjectDetail(subject){
    if(!subject) return;
    const loadingEl = document.getElementById('subjectDetailLoading');
    const loadingText = document.getElementById('subjectDetailLoadingText');
    const contentEl = document.getElementById('subjectDetailContent');
    loadingText.textContent = LOADING_QUOTE;
    loadingEl.classList.add('visible');
    contentEl.classList.remove('visible');
    setTimeout(()=>{
      renderSubjectDetail(subject);
      loadingEl.classList.remove('visible');
      contentEl.classList.add('visible');
    }, 1000);
  }

  function renderSubjectDetail(subject){
    const contentEl = document.getElementById('subjectDetailContent');
    const sessions = state.sessions.filter(s=>s.subject===subject);
    const totalMs = sessions.reduce((sum,s)=>sum+(s.durationMs||0),0);
    const count = sessions.length;
    const avgMs = count ? totalMs/count : 0;

    const today = startOfDay(Date.now());

    // last 14 days
    const dayRows = [];
    for(let i=13;i>=0;i--){
      const ts = today - i*DAY_MS;
      const ms = sessions.filter(s=>sessionDayKey(s)===ts).reduce((sum,s)=>sum+(s.durationMs||0),0);
      dayRows.push({ts, ms});
    }
    const maxDay = Math.max(1, ...dayRows.map(d=>d.ms));

    // last 8 weeks
    const todayDow = new Date(today).getDay();
    const thisWeekStart = today - todayDow*DAY_MS;
    const weekRows = [];
    for(let i=7;i>=0;i--){
      const wStart = thisWeekStart - i*7*DAY_MS;
      const wEnd = wStart + 7*DAY_MS;
      const ms = sessions.filter(s=>{ const dk = sessionDayKey(s); return dk>=wStart && dk<wEnd; })
                          .reduce((sum,s)=>sum+(s.durationMs||0),0);
      weekRows.push(ms);
    }
    const maxWeek = Math.max(1, ...weekRows);

    const allEntries = computeBreakdown(state.sessions);
    const myColor = getSubjectColor(subject);
    const maxAll = allEntries.length ? allEntries[0][1] : 1;

    contentEl.innerHTML = `
      <div class="subj-stats-row">
        <div class="stat-card"><div class="stat-label">Total time</div><div class="stat-value">${fmtHrMin(totalMs)}</div></div>
        <div class="stat-card"><div class="stat-label">Sessions</div><div class="stat-value">${count}</div></div>
        <div class="stat-card"><div class="stat-label">Avg session</div><div class="stat-value">${fmtHrMin(avgMs)}</div></div>
      </div>

      <div class="subj-section-title">Trend — last 8 weeks</div>
      <div class="subj-trend-chart">
        ${weekRows.map(ms=>`
          <div class="subj-trend-col">
            <div class="bargraph-value">${ms ? fmtHrMin(ms) : '—'}</div>
            <div class="subj-trend-bar-wrap">
              <div class="subj-trend-bar" style="height:${ms?Math.max(4,Math.round(ms/maxWeek*100)):0}%; background:${myColor};"></div>
            </div>
          </div>`).join('')}
      </div>

      <div class="subj-section-title">Daily — last 14 days</div>
      <div class="subj-daily-chart">
        ${dayRows.map(d=>`
          <div class="subj-trend-col">
            <div class="bargraph-value">${d.ms ? fmtHrMin(d.ms) : '—'}</div>
            <div class="subj-trend-bar-wrap">
              <div class="subj-trend-bar" style="height:${d.ms?Math.max(4,Math.round(d.ms/maxDay*100)):0}%; background:${myColor};"></div>
            </div>
            <div class="subj-daily-label">${new Date(d.ts).toLocaleDateString([],{day:'numeric'})}</div>
          </div>`).join('')}
      </div>

      <div class="subj-section-title">vs other subjects — all time</div>
      ${allEntries.map(([s,ms])=>`
        <div class="bar-row">
          <div class="bar-name${s===subject?' subj-vs-active':''}">${escapeHtml(s)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4,Math.round(ms/maxAll*100))}%; background:${s===subject?myColor:'var(--sage)'};"></div></div>
          <div class="bar-time">${fmtHrMin(ms)}</div>
        </div>`).join('')}
    `;
  }

  function renderActivityPage(){
    const dayTotals = computeDayTotals();
    const { current, longest } = computeStreaks(dayTotals);
    document.getElementById('streakCurrent').textContent = current + (current===1?' day':' days');
    document.getElementById('streakLongest').textContent = longest + (longest===1?' day':' days');
    document.getElementById('activeDaysCount').textContent = Object.keys(dayTotals).filter(k=>{
      return Number(k) >= startOfDay(Date.now()) - 364*DAY_MS;
    }).length;

    renderPace(dayTotals);
    setupPaceToggle();
    setupBargraphToggle();
    renderBargraph(dayTotals);
    renderDowPattern(dayTotals);

    const today = startOfDay(Date.now());
    const todayDow = new Date(today).getDay();
    const gridEnd = today + (6 - todayDow) * DAY_MS;

    // Always show a true full year (52 weeks) — never cut weeks to fit.
    // Only the cell size adapts to the available card width.
    const weeks = 52;
    const heatmapBody = document.getElementById('heatmapBody');
    const dayLabelsWidth = 32; // matches CSS .heatmap-day-labels width
    const cellGap = 3;
    const maxCellSize = 14;    // cap so cells don't get oversized on huge screens
    const availableWidth = Math.max(260, heatmapBody.clientWidth - dayLabelsWidth);

    let cellSize = Math.floor((availableWidth - (weeks - 1) * cellGap) / weeks);
    cellSize = Math.max(6, Math.min(maxCellSize, cellSize));

    document.documentElement.style.setProperty('--heatmap-cell-size', cellSize + 'px');

    const totalDays = weeks * 7;
    const gridStart = gridEnd - (totalDays - 1) * DAY_MS;

    document.getElementById('heatmapRange').textContent =
      new Date(gridStart).toLocaleDateString([], {month:'short', year:'numeric'}) + ' – ' +
      new Date(today).toLocaleDateString([], {month:'short', year:'numeric'});

    const grid = document.getElementById('heatmapGrid');
    const monthsRow = document.getElementById('heatmapMonths');
    const dayLabels = document.getElementById('heatmapDayLabels');
    grid.innerHTML = '';
    monthsRow.innerHTML = '';
    dayLabels.innerHTML = '';

    ['Sun','','Tue','','Thu','','Sat'].forEach(lbl=>{
      const span = document.createElement('span');
      span.textContent = lbl;
      dayLabels.appendChild(span);
    });

    let lastMonth = -1;
    for(let week=0; week<weeks; week++){
      const weekStartTs = gridStart + week*7*DAY_MS;
      const monthLabelCell = document.createElement('div');
      const wMonth = new Date(weekStartTs).getMonth();
      if(wMonth !== lastMonth){
        monthLabelCell.textContent = new Date(weekStartTs).toLocaleDateString([], {month:'short'});
        lastMonth = wMonth;
      }
      monthsRow.appendChild(monthLabelCell);

      for(let dow=0; dow<7; dow++){
        const ts = weekStartTs + dow*DAY_MS;
        const cell = document.createElement('div');
        if(ts > today){
          cell.className = 'heatmap-cell future';
        }else{
          const ms = dayTotals[ts] || 0;
          const lvl = levelFor(ms);
          cell.className = 'heatmap-cell l' + lvl;
          const dateStr = new Date(ts).toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'});
          cell.title = ms ? `${dateStr} — ${fmtHrMin(ms)}` : `${dateStr} — no sessions`;
        }
        grid.appendChild(cell);
      }
    }

    // Wire up subject comparison and deep-dive panels
    setupSubjectCompareToggle();
    renderSubjectCompare();
    renderSubjectDetailOptions();
  }
  window.addEventListener('focus:render-activity', renderActivityPage);

  // Heatmap week-count depends on measured pixel width, so re-render it
  // (debounced) whenever the window resizes — but only while the
  // Analytics page is actually visible, to avoid pointless work elsewhere.
  let heatmapResizeTimeout = null;
  window.addEventListener('resize', ()=>{
    clearTimeout(heatmapResizeTimeout);
    heatmapResizeTimeout = setTimeout(()=>{
      const activityPage = document.getElementById('page-activity');
      if(activityPage && activityPage.classList.contains('active')){
        renderActivityPage();
      }
    }, 150);
  });

  function renderAll(){
    renderStats();
    renderBreakdown();
    renderLog();
    renderSubjectsPage();
    renderActivityPage();
    renderPlanner();
  }

  // ============================================================
  // EXPORT REPORT
  // ============================================================
  document.getElementById('exportBtn').addEventListener('click', ()=>{
    const dayTotals = computeDayTotals();
    const { current, longest } = computeStreaks(dayTotals);
    const totalMs = state.sessions.reduce((s,p)=>s+(p.durationMs||0),0);
    const activeDays = Object.keys(dayTotals).filter(k=>Number(k)>=startOfDay(Date.now())-364*DAY_MS).length;
    const breakdown = computeBreakdown(state.sessions);

    let txt = 'Focus Study Report\n';
    txt += '==================\n\n';
    txt += `Generated: ${new Date().toLocaleString()}\n`;
    txt += `Total study time: ${fmtHrMin(totalMs)}\n`;
    txt += `Total sessions: ${state.sessions.length}\n`;
    txt += `Current streak: ${current} day${current===1?'':'s'}\n`;
    txt += `Longest streak: ${longest} day${longest===1?'':'s'}\n`;
    txt += `Active days (1yr): ${activeDays}\n\n`;

    txt += '--- Subject Breakdown ---\n';
    breakdown.forEach(([s,ms])=> txt += `${s}: ${fmtHrMin(ms)}\n`);

    txt += '\n\n--- Session Log ---\n';
    txt += 'Date,Subject,Duration (min),Note\n';
    state.sessions.slice().reverse().forEach(s=>{
      const d = new Date(s.endedAt).toLocaleDateString();
      const min = Math.round((s.durationMs||0)/60000);
      const note = (s.note||'').replace(/,/g,';');
      txt += `${d},${s.subject},${min},${note}\n`;
    });

    const blob = new Blob([txt], {type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `focus-report-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('logSearch').addEventListener('input', e=>{
    logSearchQuery = e.target.value;
    renderLog();
  });

  // ============================================================
  // DEV TOOLS
  // ============================================================
  (function(){
    const statusEl = document.getElementById('devStatus');

    function randInt(min, max){ return Math.floor(Math.random()*(max-min+1))+min; }
    function pick(arr){ return arr[randInt(0, arr.length-1)]; }

    document.getElementById('devGenerateBtn').addEventListener('click', ()=>{
      const days = Math.max(1, Math.min(365, Number(document.getElementById('devDays').value) || 30));
      const avgSessions = Math.max(1, Math.min(6, Number(document.getElementById('devSessionsPerDay').value) || 2));
      const activeChance = Math.max(1, Math.min(100, Number(document.getElementById('devActiveChance').value) || 70)) / 100;

      const subjects = state.subjects.length ? state.subjects : DEFAULT_SUBJECTS;
      const notes = ['', '', 'review', 'practice problems', 'reading ch. 4', 'flashcards', 'past papers'];
      const today = startOfDay(Date.now());

      let added = 0;
      for(let d = 0; d < days; d++){
        const dayStart = today - d*DAY_MS;
        if(Math.random() > activeChance) continue;
        const sessionCount = randInt(1, avgSessions*2-1 || 1);
        for(let i=0; i<sessionCount; i++){
          const subject = pick(subjects);
          const durationMin = randInt(8, 95);
          const hourOffset = randInt(8, 22);
          const minuteOffset = randInt(0, 59);
          const startedAt = dayStart + hourOffset*60*60*1000 + minuteOffset*60*1000;
          const endedAt = startedAt + durationMin*60*1000;
          if(endedAt > Date.now()) continue;
          const rawId = 'fake' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
          const pieces = splitSessionsByMidnight({
            id: rawId, subject, durationMs: durationMin*60000,
            note: pick(notes), startedAt, endedAt
          });
          pieces.forEach(p => state.sessions.push(p));
          added++;
        }
      }
      state.sessions.sort((a,b)=> b.endedAt - a.endedAt);
      queueSave();
      renderAll();
      statusEl.textContent = `Added ${added} fake sessions across ${days} days.`;
    });

    document.getElementById('devAddTodayBtn').addEventListener('click', ()=>{
      const subjects = state.subjects.length ? state.subjects : DEFAULT_SUBJECTS;
      const subject = pick(subjects);
      const durationMin = randInt(5, 60);
      const endedAt = Date.now();
      const startedAt = endedAt - durationMin*60*1000;
      state.sessions.unshift({
        id: 'fake' + endedAt.toString(36) + Math.random().toString(36).slice(2,8),
        subject, durationMs: durationMin*60000, note: '', startedAt, endedAt
      });
      queueSave();
      renderAll();
      statusEl.textContent = `Added one ${durationMin}m ${subject} session for today.`;
    });

    document.getElementById('devClearBtn').addEventListener('click', ()=>{
      if(!confirm('Clear ALL your sessions (fake and real)? This only affects your own browser\'s data.')) return;
      state.sessions = [];
      queueSave();
      renderAll();
      statusEl.textContent = 'Cleared all sessions.';
    });

    // ── Midnight split tester ──────────────────────────────────
    // Constructs a synthetic session that starts N hours before
    // the most recent local midnight and runs for M minutes,
    // then runs it through splitSessionsByMidnight() and shows
    // exactly how it was cut, before injecting it into state.
    document.getElementById('devSplitTestBtn').addEventListener('click', ()=>{
      const hrsBefore = Math.max(0.1, parseFloat(document.getElementById('devSplitHrsBefore').value) || 2);
      const durationMin = Math.max(1, parseInt(document.getElementById('devSplitDuration').value) || 180);
      const resultEl = document.getElementById('devSplitResult');

      // Anchor to the most recent midnight (00:00:00 today local)
      const todayMidnight = startOfDay(Date.now());
      const startedAt = todayMidnight - Math.round(hrsBefore * 60 * 60 * 1000);
      const endedAt   = startedAt + durationMin * 60 * 1000;

      const subject = (state.subjects.length ? state.subjects : DEFAULT_SUBJECTS)[0];
      const rawId   = 'splitTest' + Date.now().toString(36);

      const rawSession = { id: rawId, subject, note: 'midnight split test',
                           startedAt, endedAt, durationMs: durationMin * 60 * 1000 };
      const pieces = splitSessionsByMidnight(rawSession);

      // ── Build readable result display ──
      const fmt = ts => new Date(ts).toLocaleString([], {
        weekday:'short', month:'short', day:'numeric',
        hour:'2-digit', minute:'2-digit', second:'2-digit'
      });
      const fmtDay = ts => new Date(ts).toLocaleDateString([], {weekday:'long', month:'short', day:'numeric'});

      let html = `<div style="color:var(--text-faint); margin-bottom:0.5rem;">
        Raw: <span style="color:var(--text)">${fmt(startedAt)}</span> →
             <span style="color:var(--text)">${fmt(endedAt)}</span>
             &nbsp;(<span style="color:var(--amber)">${durationMin}m total</span>)
        &nbsp;→&nbsp; split into <strong style="color:var(--text)">${pieces.length} piece${pieces.length>1?'s':''}</strong>
      </div>`;

      pieces.forEach((p, i) => {
        const mins = Math.round(p.durationMs / 60000);
        html += `<div class="dev-split-piece">
          <span class="dev-split-day">Piece ${i+1} — ${fmtDay(p.startedAt)}</span><br>
          <span class="dev-split-time">${new Date(p.startedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>
          <span style="color:var(--text-faint)"> → </span>
          <span class="dev-split-time">${new Date(p.endedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>
          &nbsp; <span class="dev-split-dur">${mins}m (${fmtHrMin(p.durationMs)})</span>
          ${p._split ? ' <span style="color:var(--amber); font-size:0.7rem;">[continued]</span>' : ''}
        </div>`;
      });

      resultEl.innerHTML = html;
      resultEl.classList.add('visible');

      // Inject into state
      pieces.reverse().forEach(p => state.sessions.unshift(p));
      state.sessions.sort((a,b) => b.endedAt - a.endedAt);
      queueSave();
      renderAll();
      statusEl.textContent = `Injected ${pieces.length} piece(s). Check Log and Analytics pages.`;
    });

    document.getElementById('devBreakTestBtn').addEventListener('click', ()=>{
      const statusEl = document.getElementById('devBreakStatus');
      if(!state.timer.running && !state.timer.paused){
        statusEl.textContent = 'Start or resume a timer first.';
        return;
      }
      state.timer.elapsedBeforePause += BREAK_INTERVAL - 10000;
      tick();
      queueSave();
      statusEl.textContent = 'Timer advanced by 1h 59m 50s — ring should be near full.';
    });

    // Time travel
    (function(){
      const _origDateNow = Date.now;
      let _offset = 0;
      const _Date = window.Date;

      function applyOffset(ms){
        _offset = ms;
        Date.now = function(){ return _origDateNow() + _offset; };
        const P = function Date(...a){
          if(a.length === 0) return new _Date(Date.now());
          return new _Date(...a);
        };
        P.prototype = _Date.prototype;
        P.now = Date.now;
        P.UTC = _Date.UTC;
        P.parse = _Date.parse;
        window.Date = P;
      }

      function resetTime(){
        _offset = 0;
        Date.now = _origDateNow;
        window.Date = _Date;
      }

      const virtualInput = document.getElementById('devVirtualDate');
      const applyBtn = document.getElementById('devTimeApplyBtn');
      const resetBtn = document.getElementById('devTimeResetBtn');
      const statusEl = document.getElementById('devTimeStatus');

      if(virtualInput){
        // Default to today
        virtualInput.value = new Date().toISOString().slice(0,10);

        applyBtn.addEventListener('click', ()=>{
          if(!virtualInput.value){
            statusEl.textContent = 'Pick a date first.';
            return;
          }
          const target = new Date(virtualInput.value + 'T12:00:00').getTime();
          const now = _origDateNow();
          applyOffset(target - now);
          statusEl.textContent = 'Virtual date: ' + virtualInput.value + '  (refresh page to clear)';
          renderAll();
          if(window.__renderExamCountdown) window.__renderExamCountdown();
        });

        resetBtn.addEventListener('click', ()=>{
          resetTime();
          statusEl.textContent = 'Reset to real time.';
          virtualInput.value = new Date().toISOString().slice(0,10);
          renderAll();
          if(window.__renderExamCountdown) window.__renderExamCountdown();
        });
      }
    })();
  })();

  loadState();
})();

// ============================================================
// ADMIN VIEW
// ============================================================
(function(){
  const loginView = document.getElementById('adminLoginView');
  const dashboard = document.getElementById('adminDashboard');
  const detailView = document.getElementById('adminDetailView');
  const rosterList = document.getElementById('adminRosterList');

  document.getElementById('adminLoginBtn').addEventListener('click', async ()=>{
    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    const errEl = document.getElementById('adminError');
    errEl.textContent = '';
    try{
      await signInWithEmailAndPassword(auth, email, password);
    }catch(e){
      errEl.textContent = 'Sign-in failed — check email and password.';
    }
  });

  document.getElementById('adminSignOutBtn').addEventListener('click', ()=>{
    signOut(auth);
  });

  document.getElementById('adminBackBtn').addEventListener('click', ()=>{
    detailView.style.display = 'none';
    rosterList.style.display = 'block';
  });

  document.getElementById('adminResetBtn').addEventListener('click', async ()=>{
    const titleEl = document.getElementById('adminDetailTitle');
    const studentId = titleEl.getAttribute('data-student');
    if(!studentId) return;
    if(!confirm('Delete all data for "' + studentId + '"? This cannot be undone.')) return;
    if(!confirm('Are you sure? All sessions, stats, and history will be permanently removed.')) return;
    try{
      await storage.delete(studentId);
      delete adminAliases[studentId];
      saveAliases();
      detailView.style.display = 'none';
      rosterList.style.display = 'block';
      loadRoster();
    }catch(e){
      alert('Failed to reset: ' + e.message);
    }
  });

  let allRosterRows = [];
  const adminAliases = JSON.parse(localStorage.getItem('admin_aliases') || '{}');
  function saveAliases(){ localStorage.setItem('admin_aliases', JSON.stringify(adminAliases)); }

  document.getElementById('adminRosterSearch').addEventListener('input', ()=>{
    renderRoster(allRosterRows);
  });

  document.getElementById('adminExportBtn').addEventListener('click', async ()=>{
    const btn = document.getElementById('adminExportBtn');
    btn.textContent = 'Exporting…';
    btn.disabled = true;
    try{
      const rows = await storage.listRoster();
      const lines = [['Student ID','Subject','Duration (min)','Started','Ended','Note']];
      for(const r of rows){
        const data = await storage.get(r.id);
        if(!data || !data.sessions) continue;
        for(const s of data.sessions){
          lines.push([
            r.id,
            s.subject||'',
            Math.round((s.durationMs||0)/60000),
            s.startedAt ? new Date(s.startedAt).toISOString() : '',
            s.endedAt ? new Date(s.endedAt).toISOString() : '',
            (s.note||'').replace(/,/g, ';')
          ]);
        }
      }
      const csv = lines.map(row=>row.map(c=>`"${c}"`).join(',')).join('\n');
      const blob = new Blob([csv], {type:'text/csv'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'study_tracker_export.csv';
      a.click();
      URL.revokeObjectURL(url);
    }catch(e){
      alert('Export failed — ' + e.message);
    }
    btn.textContent = 'Export CSV';
    btn.disabled = false;
  });

  onAuthStateChanged(auth, (user)=>{
    const devNavItem = document.getElementById('navDevTools');
    if(user){
      loginView.style.display = 'none';
      dashboard.style.display = 'block';
      loadRoster();
      devNavItem.style.display = 'flex';
    }else{
      loginView.style.display = 'block';
      dashboard.style.display = 'none';
      devNavItem.style.display = 'none';
      const devPage = document.getElementById('page-devtools');
      if(devPage && devPage.classList.contains('active')){
        const timerNav = document.querySelector('.nav-item[data-page="timer"]');
        if(timerNav) timerNav.click();
      }
    }
  });

  function fmtHrMin(ms){
    const totalMin = Math.round(ms/60000);
    const h = Math.floor(totalMin/60);
    const m = totalMin%60;
    return h + 'h ' + m + 'm';
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function loadRoster(){
    rosterList.innerHTML = '<div class="empty">Loading…</div>';
    try{
      allRosterRows = await storage.listRoster();
    }catch(e){
      rosterList.innerHTML = '<div class="empty">Could not load roster — check Firestore rules.</div>';
      return;
    }
    allRosterRows.sort((a,b)=> (b.lastActive||0) - (a.lastActive||0));
    renderRoster(allRosterRows);
  }

  // ============================================================
  // INLINE RENAME
  // Previously this used window.prompt(), which several embedded /
  // webview contexts silently block or no-op — clicking the pencil
  // looked like it did nothing. Replaced with an inline editor that
  // always works regardless of host environment.
  // ============================================================
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';

  function startRename(studentId, idSpan, row){
    // Avoid stacking multiple edit boxes if clicked twice quickly
    if(idSpan.querySelector('.roster-rename-input')) return;

    const current = adminAliases[studentId] || '';
    idSpan.innerHTML = '';
    idSpan.classList.add('roster-rename-edit');
    row.classList.add('renaming');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'roster-rename-input';
    input.value = current;
    input.placeholder = studentId;
    input.maxLength = 40;
    input.autocomplete = 'off';
    input.spellcheck = false;

    const hint = document.createElement('span');
    hint.className = 'roster-rename-hint';
    hint.textContent = 'Enter to save · Esc to cancel';

    const actions = document.createElement('div');
    actions.className = 'roster-rename-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'roster-rename-confirm';
    confirmBtn.title = 'Save name';
    confirmBtn.setAttribute('aria-label', 'Save name');
    confirmBtn.innerHTML = ICON_CHECK;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'roster-rename-cancel';
    cancelBtn.title = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel rename');
    cancelBtn.innerHTML = ICON_X;

    let settled = false;
    function commit(){
      if(settled) return;
      settled = true;
      const trimmed = input.value.trim();
      if(trimmed){
        adminAliases[studentId] = trimmed;
      }else{
        delete adminAliases[studentId];
      }
      saveAliases();
      renderRoster(allRosterRows);
    }
    function cancel(){
      if(settled) return;
      settled = true;
      renderRoster(allRosterRows);
    }

    input.addEventListener('click', e=> e.stopPropagation());
    input.addEventListener('keydown', e=>{
      e.stopPropagation();
      if(e.key === 'Enter') commit();
      if(e.key === 'Escape') cancel();
    });
    // Clicking away from an in-progress rename saves it, same as Enter —
    // avoids the easy-to-hit "typed a name, clicked elsewhere, lost it" trap.
    input.addEventListener('blur', ()=> setTimeout(()=>{ if(!settled) commit(); }, 120));
    confirmBtn.addEventListener('click', e=>{ e.stopPropagation(); commit(); });
    cancelBtn.addEventListener('click', e=>{ e.stopPropagation(); cancel(); });

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    idSpan.appendChild(input);
    idSpan.appendChild(hint);
    idSpan.appendChild(actions);
    input.focus();
    input.select();
  }

  function renderRoster(rows){
    const weekAgo = Date.now() - 7*24*60*60*1000;
    const q = document.getElementById('adminRosterSearch').value.trim().toLowerCase();
    const filtered = q ? rows.filter(r=>{
      const alias = adminAliases[r.id];
      return r.id.toLowerCase().includes(q) || (alias && alias.toLowerCase().includes(q));
    }) : rows;

    document.getElementById('adminStudentCount').textContent = filtered.length;
    document.getElementById('adminTotalHours').textContent =
      fmtHrMin(filtered.reduce((sum,r)=>sum+(r.totalMs||0),0));
    document.getElementById('adminActiveWeek').textContent =
      filtered.filter(r=>(r.lastActive||0) >= weekAgo).length;

    rosterList.innerHTML = '';
    if(!filtered.length){
      rosterList.innerHTML = '<div class="empty">No students match your filter.</div>';
      return;
    }
    filtered.forEach(r=>{
      const row = document.createElement('div');
      row.className = 'roster-row';
      const alias = adminAliases[r.id];
      const lastActiveStr = r.lastActive ? new Date(r.lastActive).toLocaleDateString([], {month:'short', day:'numeric'}) : '—';

      const idSpan = document.createElement('div');
      idSpan.className = 'roster-id';
      if(alias){
        const aliasSpan = document.createElement('span');
        aliasSpan.className = 'roster-alias roster-id-text';
        aliasSpan.textContent = alias;
        idSpan.appendChild(aliasSpan);
        const idSmall = document.createElement('span');
        idSmall.className = 'roster-id-sub';
        idSmall.textContent = r.id;
        idSpan.appendChild(idSmall);
      }else{
        const idText = document.createElement('span');
        idText.className = 'roster-id-text';
        idText.textContent = r.id;
        idSpan.appendChild(idText);
      }
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'roster-rename-btn';
      renameBtn.innerHTML = ICON_PENCIL;
      renameBtn.title = 'Rename student';
      renameBtn.setAttribute('aria-label', 'Rename student');
      idSpan.appendChild(renameBtn);
      row.appendChild(idSpan);

      const meta = document.createElement('div');
      meta.className = 'roster-meta';
      meta.innerHTML = `
        <div class="roster-stat"><div class="roster-stat-val">${fmtHrMin(r.totalMs||0)}</div><div class="roster-stat-label">total</div></div>
        <div class="roster-stat"><div class="roster-stat-val">${r.sessionCount||0}</div><div class="roster-stat-label">sessions</div></div>
        <div class="roster-stat"><div class="roster-stat-val">${lastActiveStr}</div><div class="roster-stat-label">last active</div></div>
      `;
      row.appendChild(meta);

      renameBtn.addEventListener('click', function(e){
        e.stopPropagation();
        e.preventDefault();
        startRename(r.id, idSpan, row);
      });

      row.addEventListener('click', function(e){
        if(row.classList.contains('renaming')) return;
        openDetail(r.id);
      });

      rosterList.appendChild(row);
    });
  }

  function getWeekLabel(ts){
    const d = new Date(ts);
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay() + (d.getDay()===0?-6:1));
    return start.toLocaleDateString([], {month:'short', day:'numeric'});
  }

  async function openDetail(studentId){
    const data = await storage.get(studentId);
    if(!data){
      alert('No data found for this student.');
      return;
    }
    const alias = adminAliases[studentId];
    const titleEl = document.getElementById('adminDetailTitle');
    titleEl.setAttribute('data-student', studentId);
    titleEl.innerHTML = alias
      ? `${escapeHtml(alias)} <span style="font-size:0.75rem; font-weight:400; color:var(--text-faint);">${escapeHtml(studentId)}</span>`
      : escapeHtml(studentId);
    rosterList.style.display = 'none';
    detailView.style.display = 'block';

    const sessions = data.sessions || [];

    // weekly trend (last 12 weeks)
    const trendEl = document.getElementById('adminDetailTrend');
    const weekBuckets = {};
    const now = Date.now();
    const twelveWeeksAgo = now - 84*24*60*60*1000;
    sessions.forEach(s=>{
      if((s.endedAt||0) < twelveWeeksAgo) return;
      const label = getWeekLabel(s.endedAt);
      weekBuckets[label] = (weekBuckets[label]||0) + (s.durationMs||0);
    });
    const weekEntries = Object.entries(weekBuckets).sort((a,b)=>{
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    if(weekEntries.length){
      const maxWeek = weekEntries.reduce((m,e)=>Math.max(m,e[1]), 0);
      trendEl.innerHTML = '<div style="font-size:0.75rem; font-weight:500; letter-spacing:0.04em; text-transform:uppercase; color:var(--text-faint); margin-bottom:0.5rem;">Weekly trend (last 12 weeks)</div>' +
        weekEntries.map(([label,ms])=>{
          const pct = Math.max(4, Math.round((ms/maxWeek)*100));
          return `<div class="bar-row">
            <div class="bar-name" style="font-size:0.72rem;">${label}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <div class="bar-time" style="font-size:0.72rem;">${fmtHrMin(ms)}</div>
          </div>`;
        }).join('');
    }else{
      trendEl.innerHTML = '';
    }

    const bySubject = {};
    sessions.forEach(s=>{ bySubject[s.subject] = (bySubject[s.subject]||0) + (s.durationMs||0); });
    const entries = Object.entries(bySubject).sort((a,b)=>b[1]-a[1]);
    const breakdownEl = document.getElementById('adminDetailBreakdown');
    if(!entries.length){
      breakdownEl.innerHTML = '<div class="empty">No sessions logged.</div>';
    }else{
      const max = entries[0][1];
      breakdownEl.innerHTML = entries.map(([subject,ms])=>{
        const pct = Math.max(4, Math.round((ms/max)*100));
        return `<div class="bar-row">
          <div class="bar-name">${escapeHtml(subject)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <div class="bar-time">${fmtHrMin(ms)}</div>
        </div>`;
      }).join('');
    }

    const logEl = document.getElementById('adminDetailLog');
    if(!sessions.length){
      logEl.innerHTML = '<div class="empty">No sessions logged.</div>';
    }else{
      logEl.innerHTML = sessions.slice(0,100).map(s=>{
        const d = new Date(s.endedAt);
        const totalSec = Math.floor((s.durationMs||0)/1000);
        const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60), sec = totalSec%60;
        const dur = [h,m,sec].map(n=>String(n).padStart(2,'0')).join(':');
        return `<div class="log-row">
          <div class="log-dot"></div>
          <div class="log-main">
            <div class="log-subject">${escapeHtml(s.subject)}</div>
            ${s.note ? `<div class="log-note">${escapeHtml(s.note)}</div>` : ''}
          </div>
          <div class="log-meta">
            <div class="log-dur">${dur}</div>
            <div class="log-date">${d.toLocaleDateString([], {month:'short', day:'numeric'})}</div>
          </div>
        </div>`;
      }).join('');
    }
  }

})();
