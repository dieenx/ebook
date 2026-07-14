
const $ = id => document.getElementById(id);
let book = {title:'', chapters:[], ch:0};

// ── FILE OPEN ──
$('file-input').addEventListener('change', async e => {
  const f = e.target.files[0];
  if(f) { try { await loadEpub(f); } catch(err) { alert('Lỗi: '+err.message); } }
  e.target.value = '';
});

// ── EPUB PARSER ──
async function loadEpub(file) {
  const zip = await JSZip.loadAsync(file);
  const cxml = await zip.file('META-INF/container.xml').async('text');
  const opfPath = cxml.match(/full-path="([^"]+\.opf)"/i)?.[1];
  if(!opfPath) throw new Error('Không tìm thấy OPF');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')+1) : '';
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async('text'), 'application/xml');

  book.title = opf.querySelector('title')?.textContent.trim() || file.name.replace('.epub','');
  $('header-title').textContent = book.title;

  const items = {};
  opf.querySelectorAll('manifest item').forEach(it => {
    items[it.getAttribute('id')] = { href: opfDir + it.getAttribute('href') };
  });

  let tocT = {};
  const ncxId = opf.querySelector('spine')?.getAttribute('toc');
  if(ncxId && items[ncxId]) {
    try {
      const ncx = new DOMParser().parseFromString(await zip.file(items[ncxId].href).async('text'), 'application/xml');
      ncx.querySelectorAll('navPoint').forEach(np => {
        const src = np.querySelector('content')?.getAttribute('src')?.split('#')[0];
        const lbl = np.querySelector('navLabel text')?.textContent?.trim();
        if(src && lbl) tocT[opfDir+src] = lbl;
      });
    } catch(e){}
  }
  const navIt = [...opf.querySelectorAll('manifest item')].find(it => it.getAttribute('properties')==='nav');
  if(navIt) {
    try {
      const nd = new DOMParser().parseFromString(await zip.file(opfDir+navIt.getAttribute('href')).async('text'),'text/html');
      nd.querySelectorAll('nav a').forEach(a => { const h=a.getAttribute('href')?.split('#')[0]; if(h) tocT[opfDir+h]=a.textContent.trim(); });
    } catch(e){}
  }

  const spineIds = [...opf.querySelectorAll('spine itemref')].map(r => r.getAttribute('idref'));
  book.chapters = [];
  for(const id of spineIds) {
    const item = items[id]; if(!item) continue;
    try {
      const raw = await zip.file(item.href).async('text');
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      for(const img of doc.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        if(!src || src.startsWith('data:')) continue;
        const p = resolveUrl(item.href, src);
        const f2 = zip.file(p) || zip.file(decodeURIComponent(p));
        if(f2) {
          try {
            const b = await f2.async('base64');
            const ext = p.split('.').pop().toLowerCase();
            img.setAttribute('src', `data:${ext==='png'?'image/png':ext==='svg'?'image/svg+xml':'image/jpeg'};base64,${b}`);
          } catch(e){}
        }
      }
      const title = tocT[item.href] || doc.querySelector('title,h1,h2')?.textContent?.trim() || `Chương ${book.chapters.length+1}`;
      book.chapters.push({title, html: doc.body?.innerHTML||''});
    } catch(e){ console.warn('skip', item.href); }
  }
  if(!book.chapters.length) throw new Error('Không có nội dung');

  buildTOC();
  $('header').classList.add('visible');
  $('empty-state')?.style && ($('empty-state').style.display = 'none');
  if(!(await restoreReadingProgress())) loadChapter(0);
}

function resolveUrl(base, rel) {
  if(rel.startsWith('/')) return rel.slice(1);
  const p = base.split('/'); p.pop();
  for(const s of rel.split('/')) { if(s==='..') p.pop(); else p.push(s); }
  return p.join('/');
}

function buildTOC() {
  $('toc-list').innerHTML = '';
  book.chapters.forEach((ch, i) => {
    const d = document.createElement('div');
    d.className = 'toc-item';
    d.textContent = ch.title;
    d.onclick = () => loadChapter(i);
    $('toc-list').appendChild(d);
  });
}

function loadChapter(idx) {
  if(idx < 0 || idx >= book.chapters.length) return;
  book.ch = idx;
  $('reader-content').innerHTML = book.chapters[idx].html;
  window.scrollTo({top:0,behavior:'instant'});
  _lastScrollY = 0;
  $('header-chapter').textContent = book.chapters[idx].title;

  // always close TOC when a chapter is selected
  closeTOC();

  // update toc highlight
  document.querySelectorAll('.toc-item').forEach((el, i) => {
    el.classList.toggle('active', i===idx);
  });

  // nav buttons state
  const atStart = idx <= 0, atEnd = idx >= book.chapters.length - 1;
  $('bb-prev').disabled = atStart;
  $('bb-next').disabled = atEnd;
  $('ch-prev').disabled = atStart;
  $('ch-next').disabled = atEnd;
  $('ch-nav').classList.add('visible');

  // hide FABs on new chapter (they'll reappear on scroll)
  $('fab-up').classList.remove('show');
  $('fab-down').classList.remove('show');

  showBars();
  saveReadingProgress();
}

// ── TOC PANEL ──
function showBars() {
  $('header').classList.remove('hidden-bar');
  $('bottombar').classList.remove('hidden-bar');
}
function openTOC() {
  showBars();
  $('toc-panel').classList.add('open');
  $('toc-overlay').classList.add('on');
  const active = $('toc-list').querySelector('.toc-item.active');
  if(active) setTimeout(() => active.scrollIntoView({block:'center'}), 300);
  $('toc-search').value = '';
  filterTOC('');
  // KHÔNG tự focus — người dùng tự bấm vào ô tìm kiếm khi cần
}
function closeTOC() {
  $('toc-panel').classList.remove('open');
  $('toc-overlay').classList.remove('on');
}
function filterTOC(q) {
  const items = $('toc-list').querySelectorAll('.toc-item');
  const lower = q.toLowerCase().trim();
  items.forEach(item => {
    const match = !lower || item.textContent.toLowerCase().includes(lower);
    item.classList.toggle('hidden', !match);
  });
}
$('toc-search').addEventListener('input', function() { filterTOC(this.value); });

// ── SETTINGS PANEL ──
function openSettings() {
  showBars();
  $('settings-panel').classList.add('open');
  $('settings-overlay').classList.add('on');
  $('sync-code-input').value = getSyncCode();
  setSyncStatus(db ? 'Sẵn sàng đồng bộ' : 'Chưa cấu hình Firebase');
}
function applySyncCode() {
  setSyncCode($('sync-code-input').value);
  setSyncStatus('Đã đổi mã — đang tải tiến độ...');
  if(book.chapters.length) {
    loadProgressFromCloud().then(s => {
      if(s && s.ch < book.chapters.length) {
        loadChapter(s.ch);
        setTimeout(() => window.scrollTo({top: s.top||0, behavior:'instant'}), 80);
      }
      setSyncStatus('Đã đồng bộ');
    });
  }
}
function closeSettings() { $('settings-panel').classList.remove('open'); $('settings-overlay').classList.remove('on'); }

// ── SCROLL & AUTO-HIDE & PROGRESS ──
let _lastScrollY = 0;

const isDesktop = () => window.innerWidth >= 1024;

window.addEventListener('scroll', () => {
  const cur = window.scrollY;
  const delta = cur - _lastScrollY;
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;

  // scroll progress bar
  const pct = maxScroll > 0 ? (cur / maxScroll) * 100 : 0;
  $('scroll-progress').style.width = pct + '%';

  // auto-hide bars when scrolling down, show when scrolling up
  if(Math.abs(delta) > 6) {
    const hiding = delta > 0 && cur > 100;
    $('header').classList.toggle('hidden-bar', hiding);
    $('bottombar').classList.toggle('hidden-bar', hiding);
  }
  _lastScrollY = cur;

  // smart FABs
  const scrollingDown = delta > 0;
  const scrollingUp = delta < 0;
  const farFromTop = cur > 300;
  const farFromBottom = cur < maxScroll - 300;

  if (scrollingDown && farFromTop) {
    $('fab-up').classList.add('show');
    $('fab-down').classList.remove('show');
  } else if (scrollingUp && farFromBottom) {
    $('fab-down').classList.add('show');
    $('fab-up').classList.remove('show');
  }

  // autosave
  clearTimeout(window._saveTimer);
  window._saveTimer = setTimeout(saveReadingProgress, 2000);
});

// ── CLOUD SYNC (Firebase Firestore) ──
// 1) Tạo project miễn phí tại https://console.firebase.google.com
// 2) Vào Project settings > General > Your apps > Web app, copy config vào đây
// 3) Vào Firestore Database > Create database > bật ở chế độ "test mode"
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
let db = null;
try {
  if(firebaseConfig.apiKey !== "YOUR_API_KEY" && window.firebase) {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
  }
} catch(e) { console.warn('Firebase chưa sẵn sàng:', e); }

function getSyncCode() {
  let code = localStorage.getItem('sync_code');
  if(!code) {
    code = Math.random().toString(36).slice(2,6) + '-' + Math.random().toString(36).slice(2,6);
    localStorage.setItem('sync_code', code);
  }
  return code;
}
function setSyncCode(code) {
  code = (code||'').trim();
  if(!code) return;
  localStorage.setItem('sync_code', code);
}

let _cloudSaveTimer;
function saveProgressToCloud(data) {
  if(!db || !book.chapters.length) return;
  clearTimeout(_cloudSaveTimer);
  _cloudSaveTimer = setTimeout(() => {
    const code = getSyncCode();
    db.collection('reading_progress').doc(code).set({
      [bookKey()]: { ...data, title: book.title }
    }, { merge: true }).then(() => setSyncStatus('Đã đồng bộ'))
      .catch(e => { console.warn('Lỗi đồng bộ:', e); setSyncStatus('Lỗi đồng bộ'); });
  }, 1200);
}

async function loadProgressFromCloud() {
  if(!db) return null;
  try {
    const code = getSyncCode();
    const doc = await db.collection('reading_progress').doc(code).get();
    if(doc.exists) return doc.data()[bookKey()] || null;
  } catch(e) { console.warn('Lỗi tải đồng bộ:', e); }
  return null;
}

function setSyncStatus(text) {
  const el = document.getElementById('sync-status');
  if(el) el.textContent = text;
}

// ── READING PROGRESS (localStorage + cloud) ──
function bookKey() { return 'r_' + book.title.slice(0,30); }
function saveReadingProgress() {
  if(!book.chapters.length) return;
  const data = {ch:book.ch, top:window.scrollY, savedAt: Date.now()};
  try { localStorage.setItem(bookKey(), JSON.stringify(data)); } catch(e){}
  saveProgressToCloud(data);
}
async function restoreReadingProgress() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(bookKey())); } catch(e){}

  const cloud = db ? await loadProgressFromCloud() : null;
  let s = local;
  if(cloud && (!local || (cloud.savedAt||0) > (local.savedAt||0))) s = cloud;

  if(s && s.ch < book.chapters.length) {
    loadChapter(s.ch);
    setTimeout(() => { window.scrollTo({top: s.top||0, behavior:'instant'}); }, 80);
    return true;
  }
  return false;
}

// ── SETTINGS: THEMES ──
const THEMES = ['t-sepia','t-white','t-black','t-brown','t-dark-gray','t-blue','t-green-light','t-pink','t-yellow'];
document.querySelectorAll('.swatch').forEach(s => {
  s.onclick = () => {
    document.body.classList.remove(...THEMES);
    document.body.classList.add(s.dataset.theme);
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
  };
});

// ── SETTINGS: FONT SIZE ──
$('sl-font').oninput = function() {
  document.documentElement.style.setProperty('--font-size', this.value+'px');
  $('val-font').textContent = this.value+'px';
};
$('font-minus').onclick = () => {
  const v = Math.max(13, +$('sl-font').value - 1);
  $('sl-font').value = v; $('sl-font').dispatchEvent(new Event('input'));
};
$('font-plus').onclick = () => {
  const v = Math.min(26, +$('sl-font').value + 1);
  $('sl-font').value = v; $('sl-font').dispatchEvent(new Event('input'));
};

// ── SETTINGS: LINE HEIGHT ──
$('sl-line').oninput = function() {
  const v = (this.value/10).toFixed(1);
  document.documentElement.style.setProperty('--line-height', v);
  $('val-line').textContent = v;
};

// ── SETTINGS: FONTS ──
const FONTS = ['f-merriweather','f-lora','f-literata','f-bevietnam','f-georgia','f-times'];
document.querySelectorAll('.font-btn').forEach(b => {
  b.onclick = () => {
    document.body.classList.remove(...FONTS);
    document.body.classList.add(b.dataset.font);
    document.querySelectorAll('.font-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  };
});

// ── SETTINGS: TEXT ALIGN ──
document.querySelectorAll('.align-btn').forEach(b => {
  b.onclick = () => {
    document.body.classList.remove('align-left','align-justify');
    document.body.classList.add(b.dataset.align);
    document.querySelectorAll('.align-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  };
});

// ── AUTO-LOAD from same folder ──
const AUTO_NAMES = ['co_chan_nhan.epub','truyen.epub','truyện.epub','book.epub','sach.epub','sách.epub','story.epub'];
async function tryAutoLoad() {
  for(const name of AUTO_NAMES) {
    try {
      const res = await fetch(name);
      if(res.ok) { const blob = await res.blob(); if(blob.size>100){ await loadEpub(new File([blob],name)); return; } }
    } catch(e){}
  }
  try {
    const res = await fetch('books.json');
    if(res.ok) {
      const list = await res.json();
      if(Array.isArray(list) && list.length===1) {
        const res2 = await fetch(list[0].file);
        if(res2.ok) { const blob = await res2.blob(); await loadEpub(new File([blob], list[0].name||list[0].file)); }
      }
    }
  } catch(e){}
}
tryAutoLoad();

// keyboard
document.addEventListener('keydown', e => {
  if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  if(e.key==='ArrowRight'||e.key==='ArrowDown') loadChapter(book.ch+1);
  if(e.key==='ArrowLeft'||e.key==='ArrowUp') loadChapter(book.ch-1);
});
