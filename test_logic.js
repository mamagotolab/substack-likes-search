// background.js の同期ロジックのテスト（Node実行・ネットワーク不要）
// 実行: node test_logic.js
const assert = require('assert');

// ---- chrome API スタブ ----
const store = {};
const messageListeners = [];
global.chrome = {
  action: { onClicked: { addListener: () => {} } },
  tabs: { query: async () => [], create: () => {}, update: () => {} },
  runtime: {
    getURL: p => p,
    sendMessage: async () => {},
    onMessage: { addListener: fn => messageListeners.push(fn) }
  },
  storage: {
    local: {
      get: async keys => {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in store) out[k] = store[k];
        return out;
      },
      set: async obj => Object.assign(store, obj),
      clear: async () => { for (const k of Object.keys(store)) delete store[k]; }
    }
  }
};

// ---- fetch スタブ（テストごとに routes を差し替え）----
let routes = {};
global.fetch = async url => {
  for (const [pattern, handler] of Object.entries(routes)) {
    if (url.includes(pattern)) {
      const data = typeof handler === 'function' ? handler(url) : handler;
      if (data.__status) return { ok: false, status: data.__status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => data };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// sleep を高速化（setTimeout の遅延を 0 に）
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);

require('./background.js');
const onMessage = messageListeners[0];
assert(onMessage, 'onMessage リスナーが登録されていること');

const sync = () => new Promise(resolve => onMessage({ type: 'SYNC' }, {}, resolve));
const resetStore = (init = {}) => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, init);
};

const post = (n, extra = {}) => ({
  post: {
    title: `Post ${n}`,
    canonical_url: `https://alice.substack.com/p/post-${n}`,
    publication_name: 'Alice Blog',
    post_date: '2026-06-01T00:00:00Z',
    description: `desc ${n}`,
    ...extra
  }
});
const bodyRoute = { body_html: '<p>本文テキスト</p>' };

(async () => {
  // ---- テスト1: 初回フル同期（いいね2件＋保存2件、うち1件重複 → 3件・kindsマージ）----
  // 保存APIは filter=all 必須・resultラップ・postsキーの実形状を模す
  resetStore({ userId: '111' });
  routes = {
    'reader/feed/profile/111': { items: [post(1), post(2)], nextCursor: null },
    'reader/saved': url => {
      assert(url.includes('filter=all'), '保存APIには filter=all を付けること');
      return { result: { posts: [post(2), post(3)], nextCursor: null } };
    },
    '/api/v1/posts/': bodyRoute
  };
  let r = await sync();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 3, '重複URLは1件に統合され3件になること');
  const byUrl = u => store.likes.find(l => l.url.endsWith(u));
  assert.deepStrictEqual(byUrl('post-1').kinds, ['like']);
  assert.deepStrictEqual(byUrl('post-2').kinds.sort(), ['like', 'saved'], '重複記事は両方のkindsを持つこと');
  assert.deepStrictEqual(byUrl('post-3').kinds, ['saved']);
  assert(byUrl('post-1').body.includes('本文テキスト'), '新規記事は本文が取得されること');
  console.log('✓ テスト1: 初回フル同期・kindsマージ');

  // ---- テスト2: 差分同期（既知URLで打ち切り、ページングは2ページ目に進まない）----
  let page2Fetched = false;
  routes = {
    'reader/feed/profile/111': url => {
      if (url.includes('cursor=')) { page2Fetched = true; return { items: [], nextCursor: null }; }
      return { items: [post(9), post(1)], nextCursor: 'abc' }; // post-1 は既知
    },
    'reader/saved': { items: [post(2)], nextCursor: null }, // 既知のみ
    '/api/v1/posts/': bodyRoute
  };
  r = await sync();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 1, '新着はpost-9の1件のみ');
  assert.strictEqual(page2Fetched, false, '既知URL到達後は次ページを取得しないこと');
  assert.strictEqual(store.likes.length, 4);
  assert.strictEqual(store.likes[0].url.endsWith('post-9'), true, '新着が先頭に来ること');
  console.log('✓ テスト2: 差分同期・既知URLで打ち切り');

  // ---- テスト3: v1データ移行（kindsなし→like扱い、保存追加はkinds追記のみで本文再取得なし）----
  resetStore({
    userId: '111',
    likes: [{ title: 'Post 5', url: 'https://alice.substack.com/p/post-5', author: 'Alice Blog', date: '2026-06-01', description: 'd', body: '既存本文' }]
  });
  let bodyFetchCount = 0;
  routes = {
    'reader/feed/profile/111': { items: [post(5)], nextCursor: null },
    'reader/saved': { items: [post(5)], nextCursor: null },
    '/api/v1/posts/': () => { bodyFetchCount++; return bodyRoute; }
  };
  r = await sync();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 0, '既知URLなので新規追加なし');
  assert.deepStrictEqual(store.likes[0].kinds.sort(), ['like', 'saved'], 'v1データにkindsが補われ、savedが追記されること');
  assert.strictEqual(store.likes[0].body, '既存本文', '既存の本文は再取得されないこと');
  assert.strictEqual(bodyFetchCount, 0);
  console.log('✓ テスト3: v1移行・kinds追記・本文再取得なし');

  // ---- テスト4: 保存APIが失敗してもいいね同期は成功する ----
  resetStore({ userId: '111' });
  routes = {
    'reader/feed/profile/111': { items: [post(1)], nextCursor: null },
    'reader/saved': { __status: 401 },
    '/api/v1/posts/': bodyRoute
  };
  r = await sync();
  assert.strictEqual(r.ok, true, '保存API失敗でも全体はok');
  assert.strictEqual(r.added, 1);
  assert(r.savedError && r.savedError.includes('401'), 'savedErrorに失敗理由が入ること');
  console.log('✓ テスト4: 保存API失敗時もいいね同期は継続');

  // ---- テスト6: 新保存APIが404のとき旧・受信箱APIにフォールバック ----
  // 旧APIは inboxItems(post_id) + posts(配列) の形式・cursorキーでページング
  resetStore({ userId: '111' });
  routes = {
    'reader/feed/profile/111': { items: [post(1)], nextCursor: null },
    'reader/saved': { __status: 404 },
    'inboxType=saved': url => {
      assert(url.includes('reader/posts'), '旧APIは/reader/postsを呼ぶこと');
      const p = post(7).post;
      p.id = 777;
      return { inboxItems: [{ post_id: 777 }, { post_id: 999 }], posts: [p], cursor: null };
    },
    '/api/v1/posts/': bodyRoute
  };
  r = await sync();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.savedError, null, 'フォールバック成功時はsavedErrorなし');
  assert.strictEqual(r.added, 2, 'いいね1件＋旧API経由の保存1件');
  const saved7 = store.likes.find(l => l.url.endsWith('post-7'));
  assert.deepStrictEqual(saved7.kinds, ['saved'], '旧API経由でもkinds=savedになること');
  console.log('✓ テスト6: 旧・受信箱APIへのフォールバック');

  // ---- テスト5: ID未設定はNO_USER_IDエラー ----
  resetStore({});
  r = await sync();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'NO_USER_ID');
  console.log('✓ テスト5: ID未設定エラー');

  console.log('\n全テストがパスしました');
  process.exit(0);
})().catch(e => { console.error('✗ テスト失敗:', e.message); process.exit(1); });
