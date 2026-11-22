// 악보 서재: PDF 원본과 정보(이름, 마지막 쪽, 최근 연 시각, 미리보기)를 이 기기의 브라우저 저장소(IndexedDB)에만 보관한다.
// 서버로 보내는 것은 없다.

const DB_NAME = 'scoreturner';
const DB_VER = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('scores')) db.createObjectStore('scores', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** stores 의 각 저장소로 fn(저장소들...) 을 한 번의 트랜잭션에서 실행. fn 이 돌려준 요청의 결과를 돌려준다 */
async function run(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const names = Array.isArray(stores) ? stores : [stores];
    const t = db.transaction(names, mode);
    let result;
    const req = fn(...names.map((n) => t.objectStore(n)));
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export const listScores = () => run('scores', 'readonly', (s) => s.getAll()).then((r) => r || []);
export const getScore = (id) => run('scores', 'readonly', (s) => s.get(id));
export const putScore = (meta) => run('scores', 'readwrite', (s) => s.put(meta));
export const getFile = (id) => run('files', 'readonly', (s) => s.get(id)).then((r) => r && r.blob);

export async function updateScore(id, patch) {
  const m = await getScore(id);
  if (!m) return null;
  Object.assign(m, patch);
  await putScore(m);
  return m;
}

/** PDF 파일을 서재에 넣는다. 같은 이름·크기가 이미 있으면 null */
export async function addScore(file) {
  const name = file.name.replace(/\.pdf$/i, '');
  const all = await listScores();
  if (all.some((m) => m.name === name && m.size === file.size)) return null;
  const id = newId();
  const meta = { id, name, size: file.size, added: Date.now(), opened: 0, page: 1, pages: 0, thumb: null };
  await run(['files', 'scores'], 'readwrite', (f, s) => {
    f.put({ id, blob: file });
    s.put(meta);
  });
  return meta;
}

export async function deleteScore(id) {
  await run(['files', 'scores'], 'readwrite', (f, s) => {
    f.delete(id);
    s.delete(id);
  });
  // 이 악보의 인식 결과 등 캐시도 지움
  const keys = await run('cache', 'readonly', (c) => c.getAllKeys());
  const mine = (keys || []).filter((k) => String(k).startsWith(id + ':'));
  if (mine.length) await run('cache', 'readwrite', (c) => { mine.forEach((k) => c.delete(k)); });
}

export const getCache = (key) => run('cache', 'readonly', (c) => c.get(key)).then((r) => r && r.value);
export const putCache = (key, value) => run('cache', 'readwrite', (c) => c.put({ key, value }));

/** 브라우저가 저장소를 함부로 지우지 않게 요청 (홈 화면 앱이면 대개 허용) */
export async function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* 무시 */ }
  return false;
}
