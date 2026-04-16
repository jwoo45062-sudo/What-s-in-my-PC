const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const util = require("util");
const sqlite3 = require('sqlite3').verbose();

// --- 중복 실행 방지 ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); return; }

// exe 옆 data 폴더에 저장 (C드라이브 용량 걱정 없이 exe 위치 따라감)
const dataDir = path.join(path.dirname(app.getPath('exe')), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const logPath = path.join(dataDir, "app.log");
const logFile = fs.createWriteStream(logPath, { flags: "a" });
console.log = function(...args) { logFile.write("[INFO] " + util.format(...args) + "\n"); };
console.error = function(...args) { logFile.write("[ERR] " + util.format(...args) + "\n"); };

const dbPath = path.join(dataDir, 'index.db');
const db = new sqlite3.Database(dbPath);

// --- DB 초기화 ---
db.serialize(() => {
  db.run("PRAGMA journal_mode=WAL");
  db.run(`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, path TEXT, content TEXT, mtime INTEGER, root TEXT
  )`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    doc_id, path, content, tokenize="unicode61 remove_diacritics 0"
  )`);
});

const { syncDocuments } = require("./indexer");

let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 820,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile("index.html");
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  db.close();
  if (process.platform !== "darwin") app.quit();
});

// DB 쿼리를 Promise로 래핑
function dbAll(query, params) {
  return new Promise((resolve) => {
    db.all(query, params, (err, rows) => {
      if (err) { console.error("query error:", err.message); resolve([]); }
      else resolve(rows || []);
    });
  });
}

// --- 검색 핸들러 (5단계 우선순위, 병렬 실행) ---
ipcMain.handle("search-docs", async (event, { query, targetDirs }) => {
  try {
    const sanitizedQuery = query
      .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!sanitizedQuery) return { hits: [] };

    const t = Date.now();
    console.log(`Searching: [${sanitizedQuery}]`);

    // 경로 필터
    const normalizedDirs = (targetDirs || []).map(d => path.normalize(d).toLowerCase());
    function matchesDir(filePath) {
      if (normalizedDirs.length === 0) return true;
      const norm = path.normalize(filePath).toLowerCase();
      return normalizedDirs.some(d => {
        const base = d.endsWith(path.sep) ? d : d + path.sep;
        return norm.startsWith(base) || norm === d;
      });
    }

    const words = sanitizedQuery.split(/\s+/).filter(w => w.length > 0);

    const ftsQ = `
      SELECT d.id, d.path, d.root, d.mtime,
        snippet(documents_fts, 2, '<em>', '</em>', '...', 20) as snippet
      FROM documents_fts
      JOIN documents d ON documents_fts.doc_id = d.id
      WHERE documents_fts MATCH ?
      ORDER BY rank LIMIT 50
    `;

    // 5개 쿼리 병렬 실행
    const [r1, r2, r3, r4, r5] = await Promise.all([
      // 1순위: 파일명 전체 일치
      dbAll(`SELECT id, path, root, mtime, '' as snippet FROM documents
             WHERE replace(replace(replace(replace(replace(
               lower(path),'.hwp',''),'.pdf',''),'.docx',''),'.xlsx',''),'.hwpx','')
             LIKE lower(?) LIMIT 20`, [`%${sanitizedQuery}%`]),
      // 2순위: 내용 정확한 구문 일치
      dbAll(ftsQ, [`"${sanitizedQuery}"`]),
      // 3순위: 파일명 단어별 일치
      dbAll(`SELECT id, path, root, mtime, '' as snippet FROM documents
             WHERE ${words.map(() => `lower(path) LIKE lower(?)`).join(" AND ")}
             LIMIT 20`, words.map(w => `%${w}%`)),
      // 4순위: 내용 단어별 AND prefix
      dbAll(ftsQ, [words.map(w => `${w}*`).join(" ")]),
      // 5순위: 내용 단어 OR prefix
      words.length > 1 ? dbAll(ftsQ, [words.map(w => `${w}*`).join(" OR ")]) : Promise.resolve([])
    ]);

    // 우선순위 순서대로 중복 제거하며 합치기
    const seenIds = new Set();
    const allHits = [];
    [[r1, ""], [r2, ""], [r3, ""], [r4, ""], [r5, ""]].forEach(([rows, fallback]) => {
      (rows || []).forEach(r => {
        if (!seenIds.has(r.id) && matchesDir(r.path)) {
          seenIds.add(r.id);
          allHits.push({
            id: r.id, path: r.path, root: r.root, mtime: r.mtime,
            _formatted: { content: r.snippet || fallback, path: r.path }
          });
        }
      });
    });

    console.log(`검색 결과: ${allHits.length}건 (${Date.now() - t}ms)`);
    return { hits: allHits };

  } catch (err) {
    console.error("Search error:", err);
    return { hits: [] };
  }
});

// --- 폴더 선택 ---
ipcMain.handle("select-dirs", async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "검색할 폴더 선택",
    properties: ["openDirectory", "multiSelections"]
  });
  return result.filePaths;
});

// --- 동기화 (신규/변경 파일만) ---
ipcMain.on("start-sync", async (event, targetPaths) => {
  try {
    await syncDocuments(db, false, targetPaths, (current, total, fileName) => {
      event.reply("sync-progress", { current, total, fileName });
    });
    event.reply("sync-complete", "success");
  } catch (err) {
    console.error("Sync error:", err);
    event.reply("sync-complete", "error: " + err.message);
  }
});

// --- 전체 재파싱 (DB 초기화 후 재동기화) ---
ipcMain.on("start-force-sync", async (event, targetPaths) => {
  try {
    await syncDocuments(db, true, targetPaths, (current, total, fileName) => {
      event.reply("sync-progress", { current, total, fileName });
    });
    event.reply("sync-complete", "success");
  } catch (err) {
    console.error("Force sync error:", err);
    event.reply("sync-complete", "error: " + err.message);
  }
});
