let allLikes = [];
let activeKind = 'all';
const $ = id => document.getElementById(id);

// v1データ互換：kinds が無い項目は「いいね」扱い
const migrate = likes => likes.map(l => (l.kinds ? l : { ...l, kinds: ['like'] }));
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// 検索語（複数）を正規表現用にエスケープ
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// テキスト内の各検索語を <mark> で囲む（HTMLエスケープ後にハイライト）
function highlight(text, terms) {
  let html = esc(text);
  for (const t of terms) {
    if (!t) continue;
    html = html.replace(new RegExp('(' + reEsc(esc(t)) + ')', 'gi'), '<mark>$1</mark>');
  }
  return html;
}

// 本文・抜粋から検索語がヒットした箇所の周辺を抜き出す（Google検索風）
function snippet(like, terms) {
  const text = like.body || like.description || '';
  if (!text) return '';
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) return ''; // 本文にヒットなし（タイトル等でヒット）→ 出さない
  const start = Math.max(0, pos - 40);
  const end = Math.min(text.length, pos + 80);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function kindBadges(l) {
  const b = [];
  if ((l.kinds || []).includes('like')) b.push('♥');
  if ((l.kinds || []).includes('saved')) b.push('🔖');
  return b.join(' ');
}

function render(likes, terms = []) {
  $('results').innerHTML = likes.map(l => {
    const snip = terms.length ? snippet(l, terms) : '';
    return `
    <li class="item">
      <a href="${esc(l.url)}" target="_blank">
        <div class="title">${terms.length ? highlight(l.title, terms) : esc(l.title)}</div>
        <div class="meta"><span class="badges">${kindBadges(l)}</span> ${esc(l.author)}${l.date ? ' · '+l.date : ''}</div>
        ${snip ? `<div class="snippet">${highlight(snip, terms)}</div>` : ''}
      </a>
    </li>`;
  }).join('');
  $('status').textContent = likes.length ? `${likes.length} 件` : (allLikes.length ? '見つかりません' : '「同期」を押してください');
}

// 種別タブ切り替え
document.querySelectorAll('#kindTabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    activeKind = btn.dataset.kind;
    document.querySelectorAll('#kindTabs button').forEach(b => b.classList.toggle('active', b === btn));
    applySearch();
  });
});

// 設定パネル開閉
$('settingsBtn').addEventListener('click', () => {
  const p = $('settingsPanel');
  const open = !p.classList.contains('hidden');
  p.classList.toggle('hidden', open);
  $('settingsBtn').textContent = open ? '⚙' : '✕';
});

// ID保存 → そのまま同期まで実行
$('saveIdBtn').addEventListener('click', async () => {
  const v = $('userIdInput').value.trim();
  if (!/^\d+$/.test(v)) { $('saveMsg').textContent = '数字を入力してください'; return; }
  await chrome.storage.local.set({ userId: v });
  $('saveMsg').textContent = '';
  $('settingsPanel').classList.add('hidden');
  $('settingsBtn').textContent = '⚙';
  $('syncBtn').click();
});

// IDを自動検出
$('detectBtn').addEventListener('click', async () => {
  $('detectBtn').disabled = true;
  $('detectBtn').textContent = '検出中…';
  $('saveMsg').textContent = '';

  const resp = await chrome.runtime.sendMessage({ type: 'DETECT_ID' });

  if (resp.ok && resp.found) {
    await chrome.storage.local.set({ userId: resp.found });
    $('saveMsg').textContent = `ID ${resp.found} を検出しました`;
    $('userIdInput').value = resp.found;
    $('settingsPanel').classList.add('hidden');
    $('settingsBtn').textContent = '⚙';
    $('syncBtn').click();
  } else {
    $('saveMsg').textContent = '自動検出できませんでした。Substackにログインしているか確認してください';
  }

  $('detectBtn').disabled = false;
  $('detectBtn').textContent = 'IDを自動検出';
});

// データを全消去（リセット）
$('clearBtn').addEventListener('click', async () => {
  if (!confirm('保存済みのID・記事データをすべて消去します。よろしいですか？')) return;
  await chrome.storage.local.clear();
  allLikes = [];
  render([]);
  $('syncedAt').textContent = '';
  $('saveMsg').textContent = '';
  $('userIdInput').value = '';
  $('status').textContent = 'データを消去しました';
});

// 現在のタブ・検索語でフィルタして描画
function applySearch() {
  const base = activeKind === 'all'
    ? allLikes
    : allLikes.filter(l => (l.kinds || []).includes(activeKind));

  const terms = $('searchInput').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) { render(base); return; }
  const filtered = base.filter(l => {
    const hay = `${l.title} ${l.author} ${l.description} ${l.body || ''}`.toLowerCase();
    return terms.every(term => hay.includes(term)); // 全語を含む = AND
  });
  render(filtered, terms);
}

// 検索（デバウンス・スペース区切りでAND検索）
let t;
$('searchInput').addEventListener('input', () => {
  clearTimeout(t);
  t = setTimeout(applySearch, 200);
});

function showSyncedAt(syncedAt) {
  if (!syncedAt) return;
  const d = new Date(syncedAt);
  $('syncedAt').textContent = d.toLocaleDateString('ja-JP') + ' ' +
    d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// 本文取得の進捗表示
chrome.runtime.onMessage.addListener(m => {
  if (m.type === 'PROGRESS') {
    $('status').textContent = `本文を取得中… ${m.done} / ${m.total}`;
  }
});

// 同期（手動・自動共通）
async function runSync(auto = false) {
  $('syncBtn').disabled = true;
  $('syncBtn').textContent = '同期中…';
  $('status').textContent = auto ? '新着を確認中…' : '記事を取得中…';

  const resp = await chrome.runtime.sendMessage({ type: 'SYNC' });

  if (resp.ok) {
    const { likes = [], syncedAt } = await chrome.storage.local.get(['likes', 'syncedAt']);
    allLikes = migrate(likes);
    showSyncedAt(syncedAt);
    applySearch();
    let msg = resp.added > 0
      ? `新着 ${resp.added} 件を追加しました（全 ${resp.total} 件）`
      : `最新の状態です（全 ${resp.total} 件）`;
    if (resp.savedError) msg += `（保存記事の取得に失敗: ${resp.savedError}）`;
    $('status').textContent = msg;
  } else if (resp.error === 'NO_USER_ID') {
    $('settingsPanel').classList.remove('hidden');
    $('settingsBtn').textContent = '✕';
    $('status').textContent = '⚙ユーザーIDを設定してから同期してください';
  } else {
    $('status').textContent = (auto ? '自動同期に失敗: ' : 'エラー: ') + resp.error;
  }

  $('syncBtn').disabled = false;
  $('syncBtn').textContent = '同期';
}

$('syncBtn').addEventListener('click', () => runSync(false));

// 起動時：キャッシュを表示してから自動で差分同期
(async () => {
  const { userId, likes = [], syncedAt } = await chrome.storage.local.get(['userId', 'likes', 'syncedAt']);
  allLikes = migrate(likes);
  showSyncedAt(syncedAt);
  render(allLikes);

  if (!userId) {
    // ID未設定：自動検出を試みる
    $('status').textContent = 'ユーザーIDを自動検出中…';
    const resp = await chrome.runtime.sendMessage({ type: 'DETECT_ID' });
    if (resp.ok && resp.found) {
      await chrome.storage.local.set({ userId: resp.found });
      runSync(false); // 検出できたら初回フル同期
    } else {
      $('settingsPanel').classList.remove('hidden');
      $('settingsBtn').textContent = '✕';
      $('status').textContent = 'Substackにログインした状態で「IDを自動検出」を押してください';
    }
  } else if (likes.length === 0) {
    // IDはあるが未取得：初回フル同期は重いので手動で
    $('status').textContent = '「同期」を押して初回データを取得してください';
  } else {
    // 2回目以降は開いた時に自動で差分同期（軽い）
    runSync(true);
  }
})();
