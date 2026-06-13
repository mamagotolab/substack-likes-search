console.log('[bg] service worker loaded (build: saved+filter=all)', new Date().toLocaleTimeString());

// 拡張アイコンクリックで検索画面をタブで開く
// （ポップアップだとLinuxでIMEが効かないためタブ方式）
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    chrome.tabs.update(existing.id, { active: true });
  } else {
    chrome.tabs.create({ url });
  }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getItemUrl(item) {
  const post = item.post || item.entity || item;
  return post.canonical_url || post.url || '';
}

// フィード系APIを新しい順にページングして取得。既知URLに到達したら打ち切る（差分同期）。
// knownUrls が空なら全件取得（初回）。
async function fetchNewItems(buildUrl, knownUrls, label) {
  const fresh = [];
  let cursor = null;
  let page = 0;

  loop:
  do {
    const resp = await fetch(buildUrl(cursor), { credentials: 'include' });
    console.log(`[bg] ${label} page`, page, 'status', resp.status);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const payload = data.result || data;
    let items = payload.items || payload.posts || [];
    // 旧・受信箱API形式：inboxItems の post_id を posts 配列から引き当てる
    if (Array.isArray(payload.inboxItems) && Array.isArray(payload.posts)) {
      const byId = new Map(payload.posts.map(p => [p.id, p]));
      items = payload.inboxItems.map(ii => byId.get(ii.post_id)).filter(Boolean);
    }
    if (!items.length) break;
    if (Array.isArray(items)) {
      for (const item of items) {
        const u = getItemUrl(item);
        if (u && knownUrls.has(u)) {
          console.log(`[bg] ${label} 既知の記事に到達。差分取得を終了`);
          break loop;
        }
        fresh.push(item);
      }
    }

    cursor = payload.nextCursor || payload.next_cursor || payload.cursor || null;
    page++;
    if (cursor) await sleep(400);
  } while (cursor && page < 100);

  console.log(`[bg] ${label} 新着`, fresh.length, '件');
  return fresh;
}

function likesUrl(userId) {
  return cursor => {
    let url = `https://substack.com/api/v1/reader/feed/profile/${userId}?types%5B%5D=like`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    return url;
  };
}

function savedUrl() {
  return cursor => {
    // filter パラメータ必須（無いと404になる）
    let url = 'https://substack.com/api/v1/reader/saved?filter=all';
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    return url;
  };
}

// 旧UIアカウント用（enable_comment_saves フラグが無効だと上のAPIは404を返す）
function savedUrlLegacy() {
  return cursor => {
    let url = 'https://substack.com/api/v1/reader/posts?inboxType=saved&limit=20';
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    return url;
  };
}
const stripHtml = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function parseUrl(canonicalUrl) {
  try {
    const u = new URL(canonicalUrl);
    const m = u.hostname.match(/^([^.]+)\.substack\.com$/);
    const slug = (u.pathname.split('/p/')[1] || '').split('/')[0];
    return { subdomain: m ? m[1] : null, slug: slug || null };
  } catch {
    return { subdomain: null, slug: null };
  }
}

function extractItem(item, kind) {
  const post = item.post || item.entity || item;
  const bylines = (post.publishedBylines || []).map(b => b.name).filter(Boolean);
  const author = [post.publication_name, post.publication?.name, ...bylines, post.byline]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(' / ');

  return {
    title: post.title || '',
    url: post.canonical_url || post.url || '',
    author,
    date: (post.post_date || post.created_at || '').slice(0, 10),
    description: post.description || post.truncated_body_text || '',
    body: '',
    kinds: [kind]
  };
}

async function fetchBody(url) {
  const { subdomain, slug } = parseUrl(url);
  if (!subdomain || !slug) return '';
  try {
    const r = await fetch(`https://${subdomain}.substack.com/api/v1/posts/${slug}`, { credentials: 'include' });
    if (!r.ok) return '';
    const d = await r.json();
    return stripHtml(d.body_html || d.body || '');
  } catch {
    return '';
  }
}

// 自分のユーザーIDを自動検出する
// ログイン中の substack.com/home のHTMLに primary_user_id として埋まっている
async function detectUserId() {
  try {
    const r = await fetch('https://substack.com/home', { credentials: 'include' });
    if (!r.ok) { console.log('[detect] home status', r.status); return null; }
    const html = await r.text();
    // 埋め込みJSONはエスケープされている場合があるため、区切り文字を緩く許容
    const m = html.match(/primary_user_id["\\:\s]+(\d+)/);
    if (m) {
      console.log('[detect] primary_user_id →', m[1]);
      return m[1];
    }
    console.log('[detect] primary_user_id が見つかりませんでした（未ログインの可能性）');
    return null;
  } catch (e) {
    console.log('[detect] error', e.message);
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[bg] message received:', msg.type);

  if (msg.type === 'DETECT_ID') {
    (async () => {
      try {
        const found = await detectUserId();
        console.log('[bg] detect result:', found);
        sendResponse({ ok: true, found });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type !== 'SYNC') return;

  (async () => {
    try {
      const { userId, likes: existing = [] } = await chrome.storage.local.get(['userId', 'likes']);
      if (!userId) throw new Error('NO_USER_ID');

      // v1データの移行：kinds が無い項目は「いいね」扱い
      for (const l of existing) if (!l.kinds) l.kinds = ['like'];

      // 種別ごとに既知URLを把握し、新着分だけ取得
      const knownLikeUrls = new Set(existing.filter(l => l.kinds.includes('like')).map(l => l.url));
      const knownSavedUrls = new Set(existing.filter(l => l.kinds.includes('saved')).map(l => l.url));

      const freshLikeItems = await fetchNewItems(likesUrl(userId), knownLikeUrls, 'like');

      // 保存記事の取得失敗はいいね同期を巻き込まない
      let freshSavedItems = [];
      let savedError = null;
      try {
        freshSavedItems = await fetchNewItems(savedUrl(), knownSavedUrls, 'saved');
      } catch (e) {
        if (e.message.includes('404')) {
          // 新保存APIが無効なアカウント → 旧・受信箱APIにフォールバック
          try {
            freshSavedItems = await fetchNewItems(savedUrlLegacy(), knownSavedUrls, 'saved(legacy)');
          } catch (e2) {
            console.error('[bg] saved legacy fetch error:', e2);
            savedError = e2.message;
          }
        } else {
          console.error('[bg] saved fetch error:', e);
          savedError = e.message;
        }
      }

      const fresh = [
        ...freshLikeItems.map(i => extractItem(i, 'like')),
        ...freshSavedItems.map(i => extractItem(i, 'saved'))
      ].filter(l => l.url && l.title);

      // 新着同士をURLで統合（いいね＋保存の両方に該当する記事は kinds をマージ）
      const freshByUrl = new Map();
      for (const it of fresh) {
        const cur = freshByUrl.get(it.url);
        if (cur) {
          for (const k of it.kinds) if (!cur.kinds.includes(k)) cur.kinds.push(k);
        } else {
          freshByUrl.set(it.url, it);
        }
      }

      // 既存とマージ：既知URLは kinds の追加のみ、新規URLだけ本文取得対象
      const existingByUrl = new Map(existing.map(l => [l.url, l]));
      const newItems = [];
      for (const it of freshByUrl.values()) {
        const cur = existingByUrl.get(it.url);
        if (cur) {
          for (const k of it.kinds) if (!cur.kinds.includes(k)) cur.kinds.push(k);
        } else {
          newItems.push(it);
        }
      }

      // 新規分だけ本文を取得
      for (let i = 0; i < newItems.length; i++) {
        newItems[i].body = await fetchBody(newItems[i].url);
        chrome.runtime.sendMessage({ type: 'PROGRESS', done: i + 1, total: newItems.length }).catch(() => {});
        if (i < newItems.length - 1) await sleep(300);
      }

      const merged = [...newItems, ...existing];

      await chrome.storage.local.set({ likes: merged, syncedAt: new Date().toISOString() });
      sendResponse({ ok: true, added: newItems.length, total: merged.length, savedError });
    } catch (e) {
      console.error('[bg] SYNC error:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});
