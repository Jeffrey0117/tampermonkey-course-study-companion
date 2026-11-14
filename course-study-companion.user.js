// ==UserScript==
// @name         Online Course Study Companion
// @namespace    da
// @version      1.0.0
// @description  yourjobpocket 課程頁個人輔助。
// @homepageURL  https://github.com/Jeffrey0117/tampermonkey-course-study-companion
// @updateURL    https://raw.githubusercontent.com/Jeffrey0117/tampermonkey-course-study-companion/main/course-study-companion.user.js
// @downloadURL  https://raw.githubusercontent.com/Jeffrey0117/tampermonkey-course-study-companion/main/course-study-companion.user.js
// @match        https://yourjobpocket.com/lessons
// @match        https://yourjobpocket.com/lessons/*
// @grant        GM_download
// @connect      downloads.yourjobpocket.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VERSIONS = ['v1', 'v2', 'v3', 'v4'];

  // ⚠ SPA 換課不重整頁面，所以課程代號不能存成「載入時」的常數，
  //   每次都要用「當下網址」現算，否則切到別課還拿舊課的資料。
  function currentCourse() {
    return location.pathname.split('/')[2];            // /lessons/{課}/learn/... -> {課}
  }
  const DL_ROOT = 'https://downloads.yourjobpocket.com/lessons';

  // ⚠ 版本段(v1~v4)的位置不固定：有的課在 course 後、有的在 course 前。
  //   所以每個版本都產出「兩種排列」的候選網址，實際哪個通由 canLoad 決定。
  //   之後若發現更多位置，往這個 list 加一行就好。
  function candidateUrls(course, slug) {
    const urls = [];
    for (const ver of VERSIONS) {
      urls.push(`${DL_ROOT}/${course}/${ver}/${slug}.mp4`); // 版本在課後：/lessons/{課}/{版本}/{slug}
      urls.push(`${DL_ROOT}/${ver}/${course}/${slug}.mp4`); // 版本在課前：/lessons/{版本}/{課}/{slug}
    }
    return urls;
  }

  // ───────────────────────────────────────────────
  // 判斷核心 1：單一網址能不能載入？回傳 Promise<boolean>
  // ───────────────────────────────────────────────
  function canLoad(url) {
    return new Promise((resolve) => {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => resolve(true);
      probe.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 5000);
      probe.src = url;
    });
  }

  // 判斷核心 2：逐一試候選網址（v1→v4 × 兩種版本位置），回傳第一個成功的，全失敗回 null
  async function findWorkingUrl(slug, course) {
    for (const url of candidateUrls(course, slug)) {
      if (await canLoad(url)) return url;
    }
    return null;
  }

  // ───────────────────────────────────────────────
  // A. 把頁面上的付費牆 ls-locked 換成播放器
  // ───────────────────────────────────────────────
  function markUnlocked() {
    const h1 = document.querySelector('h1');
    if (!h1 || h1.querySelector('.da-unlocked')) return;
    const tag = document.createElement('span');
    tag.className = 'da-unlocked';
    tag.textContent = ' [已解鎖]';
    tag.style.cssText = 'color:#2563eb;font-weight:bold';
    h1.appendChild(tag);
  }

  async function handleLocked(lockedEl) {
    if (lockedEl.dataset.done) return;
    lockedEl.dataset.done = '1';
    lockedEl.style.visibility = 'hidden';          // 先藏，避免換課閃到鎖頭

    const course = currentCourse();
    const slug = location.pathname.split('/').filter(Boolean).pop();
    const url = await findWorkingUrl(slug, course);
    if (!url) {
      lockedEl.textContent = '影片暫時壞掉';
      lockedEl.style.visibility = 'visible';
      return;
    }
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    video.style.cssText = 'width:100%;border-radius:12px;background:#000';
    lockedEl.replaceWith(video);
    markUnlocked();
  }

  // ───────────────────────────────────────────────
  // B. 目錄：全解鎖標記 + 每個影片課的下載按鈕
  // ───────────────────────────────────────────────

  // 目錄裡上鎖的課是 <span class="is-locked">，沒有 slug，
  // 所以先跟 API 拿「標題 -> {slug, video}」對照表。
  // 快取用「課程代號」當 key，每門課各存一份（不能全域一份，否則換課還用舊的）
  const titleMaps = {};
  async function getTitleMap(course) {
    if (titleMaps[course]) return titleMaps[course];
    const res = await fetch(`/v1/lessons/courses/${course}`, { credentials: 'include' });
    const data = await res.json();
    const map = new Map();
    data.course.chapters.forEach((ch) =>
      ch.lessons.forEach((ls) =>
        map.set(ls.title.trim(), { slug: ls.id, video: ls.video })
      )
    );
    titleMaps[course] = map;
    return map;
  }

  // 從目錄的一列取出「純標題」（<a> 有 .ls-lesson-title；上鎖列要扣掉 <small> 的「影片・X 分」）
  function rowTitle(row) {
    const t = row.querySelector('.ls-lesson-title');
    if (t) return t.textContent.trim();
    const small = row.querySelector('small');
    let txt = row.textContent || '';
    if (small) txt = txt.replace(small.textContent, '');
    return txt.trim();
  }

  // 按下「下載」：找到可用版本 -> GM_download（跨網域才抓得下來）
  function downloadVideo(slug, btn, course) {
    btn.textContent = '…';
    btn.disabled = true;
    findWorkingUrl(slug, course).then((url) => {
      if (!url) { btn.textContent = '無檔'; return; }
      GM_download({
        url,
        name: `${slug}.mp4`,
        onload:  () => { btn.textContent = '✓'; },
        onerror: () => { btn.textContent = '失敗'; btn.disabled = false; },
      });
    });
  }

  let badgePlaced = false;
  async function decorateTOC() {
    // 目錄標題後加「全解鎖」藍標（只找一次，找到就不再掃，省效能）
    if (!badgePlaced) {
      const titleEl = Array.from(document.querySelectorAll('h1,h2,h3,strong,div,span'))
        .find((el) => el.childElementCount <= 2 && el.textContent.trim() === '課程目錄');
      if (titleEl && !titleEl.querySelector('.da-allunlock')) {
        const b = document.createElement('span');
        b.className = 'da-allunlock';
        b.textContent = ' 全解鎖';
        b.style.cssText = 'color:#2563eb;font-weight:bold;font-size:12px';
        titleEl.appendChild(b);
        badgePlaced = true;
      }
    }

    // 目錄的課程列：可能是 <a>（可點）或 <span class="is-locked">（上鎖）
    const rows = document.querySelectorAll('li > a[href*="/learn/"], li > span.is-locked');
    if (!rows.length) return;                      // 目錄沒展開就跳過
    const course = currentCourse();                // 當下這門課（SPA 換課會變）
    if (!course) return;
    const map = await getTitleMap(course);

    rows.forEach((row) => {
      const info = map.get(rowTitle(row));         // 標題配對 -> slug
      if (!info || !info.video) return;            // 配不到、或不是影片課 -> 不給下載
      const li = row.closest('li');
      if (!li || li.dataset.daDone) return;        // 這列處理過了
      li.dataset.daDone = '1';

      // ── 上鎖列補完：當初 HTML 沒寫成連結，這裡示範三個基本 DOM 改法 ──
      if (row.matches('span.is-locked')) {
        const svg = row.querySelector('svg');
        if (svg) svg.remove();                     // (1) 改圖：拿掉鎖頭 icon
        const a = document.createElement('a');     // (2) 改連結：span -> <a>
        a.href = `/lessons/${course}/learn/${info.slug}`;
        a.innerHTML = row.innerHTML;               //     把剩下內容搬進連結
        a.style.color = '#2563eb';                 // (3) 上色：藍字
        a.style.textDecoration = 'none';
        row.replaceWith(a);                        //     用連結換掉原本的 span
      }

      // li 的定位改由注入的 CSS 規則 li[data-da-done] 負責（不用 inline）
      const btn = document.createElement('button');
      btn.className = 'da-dl';
      btn.textContent = '下載';
      btn.style.cssText =
        'position:absolute;right:10px;top:50%;transform:translateY(-50%);z-index:2;' +
        'font-size:11px;padding:2px 8px;border:1px solid #2563eb;color:#2563eb;' +
        'background:#fff;border-radius:4px;cursor:pointer';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();                       // 別觸發到課程連結
        downloadVideo(info.slug, btn, course);
      });
      li.appendChild(btn);
    });
  }

  // ───────────────────────────────────────────────
  // C. 課程總覽：CTA 改成炫麗「直接學習」，直接跳進第一課
  //    一律用 href 推出課程代號 -> 所有課程通用，不寫死
  // ───────────────────────────────────────────────
  const SKIP = new Set(['handouts', 'quizzes', 'mine', 'courses']);

  // 注入炫麗漸層樣式（只做一次）
  function ensureFlashyStyle() {
    if (document.getElementById('da-flashy')) return;
    const st = document.createElement('style');
    st.id = 'da-flashy';
    st.textContent = `
      @keyframes daShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
      .da-learn{background:linear-gradient(90deg,#6366f1,#ec4899,#f59e0b,#6366f1)!important;background-size:300% 100%!important;
        animation:daShift 4s ease infinite!important;color:#fff!important;border:none!important;border-radius:10px!important;
        font-weight:700!important;box-shadow:0 4px 18px rgba(99,102,241,.5)!important;text-decoration:none!important;cursor:pointer;transition:transform .15s}
      .da-learn:hover{transform:scale(1.05)}
      .da-learn-pill{position:absolute!important;top:10px;right:10px;z-index:3;padding:4px 10px!important;font-size:12px!important}
      /* 卡片原生 position:static，pill 要靠它當定位錨點。用 CSS !important 強制，
         比 inline 耐得住 React 重繪（inline 會被洗掉，pill 就跑去蓋隔壁卡） */
      a.lk-card[data-da-cta]{position:relative!important}
      li[data-da-done]{position:relative!important}`;
    (document.head || document.documentElement).appendChild(st);
  }

  // 每門課要跳去的「接續點」：第一個還沒看完(done:false)的課。
  // 都看完 / 都沒看 -> 退回第一課。回傳 { slug, resumed }，resumed 表示「中途接續」。
  const resumeCache = {};
  async function resumeLesson(course) {
    if (resumeCache[course] !== undefined) return resumeCache[course];
    try {
      const r = await fetch(`/v1/lessons/courses/${course}`, { credentials: 'include' });
      const d = await r.json();
      const flat = [];
      d.course.chapters.forEach((ch) => ch.lessons.forEach((ls) => flat.push(ls)));
      const undone = flat.find((l) => !l.done);     // 第一個沒看完的
      const target = undone || flat[0];             // 沒有沒看完的就回第一課
      const hasProgress = flat.some((l) => l.done); // 看過至少一課？
      resumeCache[course] = target
        ? { slug: target.id, resumed: hasProgress && !!undone }
        : null;
    } catch (e) {
      resumeCache[course] = null;
    }
    return resumeCache[course];
  }

  // 從連結取出課程代號（排除 handouts/mine 這種工具頁）
  function courseOf(el) {
    const c = (el.getAttribute('href') || '').split('/')[2];
    return c && !SKIP.has(c) ? c : null;
  }

  async function decorateCourseCTAs() {
    ensureFlashyStyle();

    // A. 明確的「看課程內容」按鈕 -> 直接學習
    //    只抓連到課程總覽頁(/lessons/{課})的 CTA；
    //    :not([href*="/learn/"]) 排除底部「上一課/下一課」導覽鈕(它們 href 帶 /learn/)
    for (const a of document.querySelectorAll('a.lx-btn[href^="/lessons/"]:not([href*="/learn/"])')) {
      if (a.dataset.daCta) continue;
      const course = courseOf(a);
      if (!course) continue;
      a.dataset.daCta = '1';
      const info = await resumeLesson(course);
      if (!info) continue;
      a.href = `/lessons/${course}/learn/${info.slug}`;        // 跳去接續點
      a.textContent = info.resumed ? '繼續上課 →' : '直接學習 →';
      a.classList.add('da-learn');
      a.style.padding = '10px 20px';
    }

    // B. 整張課程卡 lk-card -> 點卡直接進第一課 + 炫麗 pill
    for (const card of document.querySelectorAll('a.lk-card[href^="/lessons/"]')) {
      if (card.dataset.daCta) continue;
      const course = courseOf(card);
      if (!course) continue;
      card.dataset.daCta = '1';
      const info = await resumeLesson(course);
      if (!info) continue;
      card.href = `/lessons/${course}/learn/${info.slug}`;
      // 定位靠上面注入的 CSS 規則 a.lk-card[data-da-cta]，不用 inline（才不會被重繪洗掉）
      const pill = document.createElement('span');
      pill.textContent = info.resumed ? '繼續上課' : '直接學習';
      pill.className = 'da-learn da-learn-pill';
      card.appendChild(pill);
    }
  }

  // ───────────────────────────────────────────────
  // 統一驅動：DOM 一變就重跑（SPA 晚畫、換課、章節展開都接得到）
  // 用 rAF debounce，避免 Observer 狂觸發時重工
  // ───────────────────────────────────────────────
  function runAll() {
    ensureFlashyStyle();   // 先確保定位用的 CSS 規則就位（給目錄下載鈕和卡片 pill 用）
    document.querySelectorAll('.ls-locked').forEach(handleLocked);
    decorateTOC();
    decorateCourseCTAs();
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; runAll(); });
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  schedule();
})();
