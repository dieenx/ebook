
const $ = id => document.getElementById(id);
let book = {title:'', chapters:[], ch:0, zip:null};

// ── FILE OPEN ──
$('file-input').addEventListener('change', async e => {
  const f = e.target.files[0];
  if(f) { try { await loadEpub(f); } catch(err) { alert('Lỗi: '+err.message); } }
  e.target.value = '';
});

// ── EPUB PARSER (chỉ đọc cấu trúc + TOC, KHÔNG giải nén nội dung chương) ──
async function loadEpub(file) {
  const zip = await JSZip.loadAsync(file);
  book.zip = zip;
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

  // Chỉ lưu href + tên chương (nếu có từ TOC). Nội dung (html, ảnh base64)
  // sẽ được giải nén "lười" trong extractChapter() — chương nào đọc tới mới giải nén,
  // giống YouTube buffer video theo đoạn thay vì tải/parse hết một lần.
  book.chapters = [];
  for(const id of spineIds) {
    const item = items[id]; if(!item) continue;
    book.chapters.push({ href: item.href, title: tocT[item.href] || null, html: null, loading: null });
  }
  if(!book.chapters.length) throw new Error('Không có nội dung');

  buildTOC();
  $('header').classList.add('visible');
  $('empty-state').style.display = 'none';
  if(!(await restoreReadingProgress())) await loadChapter(0);
}

function resolveUrl(base, rel) {
  if(rel.startsWith('/')) return rel.slice(1);
  const p = base.split('/'); p.pop();
  for(const s of rel.split('/')) { if(s==='..') p.pop(); else p.push(s); }
  return p.join('/');
}

// ── GIẢI NÉN 1 CHƯƠNG (LAZY) ──
// Chỉ chạy khi thực sự cần hiện chương đó. Kết quả được cache lại trong book.chapters[idx].
async function extractChapter(idx) {
  const ch = book.chapters[idx];
  if(!ch) return null;
  if(ch.html !== null) return ch;       // đã giải nén rồi, dùng luôn
  if(ch.loading) return ch.loading;     // đang giải nén dở, chờ chung 1 promise (tránh chạy trùng)

  ch.loading = (async () => {
    try {
      const raw = await book.zip.file(ch.href).async('text');
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      for(const img of doc.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        if(!src || src.startsWith('data:')) continue;
        const p = resolveUrl(ch.href, src);
        const f2 = book.zip.file(p) || book.zip.file(decodeURIComponent(p));
        if(f2) {
          try {
            const b = await f2.async('base64');
            const ext = p.split('.').pop().toLowerCase();
            img.setAttribute('src', `data:${ext==='png'?'image/png':ext==='svg'?'image/svg+xml':'image/jpeg'};base64,${b}`);
          } catch(e){}
        }
      }
      if(!ch.title) ch.title = doc.querySelector('title,h1,h2')?.textContent?.trim() || `Chương ${idx+1}`;
      ch.html = doc.body?.innerHTML || '';
      updateTOCTitle(idx);
    } catch(e) {
      console.warn('skip', ch.href, e);
      ch.title = ch.title || `Chương ${idx+1}`;
      ch.html = '<p><em>(Không thể tải nội dung chương này)</em></p>';
    }
    ch.loading = null;
    return ch;
  })();

  return ch.loading;
}

function updateTOCTitle(idx) {
  const el = $('toc-list').children[idx];
  if(el && book.chapters[idx]) el.textContent = book.chapters[idx].title;
}

// ── PREFETCH NỀN: tải trước vài chương kế tiếp lúc rảnh, như buffer video ──
const PREFETCH_AHEAD = 4;
function schedulePrefetch(fromIdx) {
  for(let i=1; i<=PREFETCH_AHEAD; i++) {
    const idx = fromIdx + i;
    if(idx < book.chapters.length && book.chapters[idx].html === null) {
      const run = () => extractChapter(idx);
      if('requestIdleCallback' in window) requestIdleCallback(run, {timeout: 2000});
      else setTimeout(run, 250 * i);
    }
  }
}

function buildTOC() {
  $('toc-list').innerHTML = '';
  book.chapters.forEach((ch, i) => {
    const d = document.createElement('div');
    d.className = 'toc-item';
    d.textContent = ch.title || `Chương ${i+1}`;
    d.onclick = () => loadChapter(i);
    $('toc-list').appendChild(d);
  });
}

async function loadChapter(idx) {
  if(idx < 0 || idx >= book.chapters.length) return;
  book.ch = idx;

  $('reader-content').innerHTML = '<p class="chapter-loading">Đang tải…</p>';
  window.scrollTo({top:0,behavior:'instant'});
  _lastScrollY = 0;
  $('header-chapter').textContent = book.chapters[idx].title || `Chương ${idx+1}`;

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

  const ch = await extractChapter(idx);
  if(book.ch !== idx) return; // người dùng đã bấm chương khác trong lúc chờ giải nén
  $('reader-content').innerHTML = ch.html;
  $('header-chapter').textContent = ch.title;

  schedulePrefetch(idx);
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
function openSettings() { showBars(); $('settings-panel').classList.add('open'); $('settings-overlay').classList.add('on'); }
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

// ── READING PROGRESS (localStorage) ──
function bookKey() { return 'r_' + book.title.slice(0,30); }
function saveReadingProgress() {
  if(!book.chapters.length) return;
  try { localStorage.setItem(bookKey(), JSON.stringify({ch:book.ch, top:window.scrollY})); } catch(e){}
}
async function restoreReadingProgress() {
  try {
    const s = JSON.parse(localStorage.getItem(bookKey()));
    if(s && s.ch < book.chapters.length) {
      await loadChapter(s.ch);
      setTimeout(() => { window.scrollTo({top: s.top||0, behavior:'instant'}); }, 80);
      return true;
    }
  } catch(e){}
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
