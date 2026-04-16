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

// --- 검색 핸들러 (4단계 우선순위) ---
ipcMain.handle("search-docs", async (event, { query, targetDirs }) => {
  return new Promise((resolve) => {
    try {
      const sanitizedQuery = query
        .replace(/[^\w\sㄱ-ㅎ가-힣]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!sanitizedQuery) return resolve({ hits: [] });

      console.log(`Searching: [${sanitizedQuery}], dirs: ${JSON.stringify(targetDirs)}`);

      // JS에서 경로 prefix 필터링 (경로 구분자 차이 무관)
      const normalizedDirs = (targetDirs || []).map(d => path.normalize(d).toLowerCase());
      function matchesDir(filePath) {
        if (normalizedDirs.length === 0) return true;
        const norm = path.normalize(filePath).toLowerCase();
        return normalizedDirs.some(d => {
          const base = d.endsWith(path.sep) ? d : d + path.sep;
          return norm.startsWith(base) || norm === d;
        });
      }

      const seenIds = new Set();
      const allHits = [];
      function addHits(rows, snippetFallback) {
        (rows || []).forEach(r => {
          if (!seenIds.has(r.id) && matchesDir(r.path)) {
            seenIds.add(r.id);
            allHits.push({
              id: r.id, path: r.path, root: r.root, mtime: r.mtime,
              _formatted: { content: r.snippet || snippetFallback || "", path: r.path }
            });
          }
        });
      }

      const ftsQ = `
        SELECT d.id, d.path, d.root, d.mtime,
          snippet(documents_fts, 2, '<em>', '</em>', '...', 20) as snippet
        FROM documents_fts
        JOIN documents d ON documents_fts.doc_id = d.id
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT 50
      `;

      const words = sanitizedQuery.split(/\s+/).filter(w => w.length > 0);
      const fileName = path.basename; // 파일명만 추출용

      // 1순위: 파일명 정확히 일치 (확장자 제외한 파일명에 검색어 전체 포함)
      db.all(`SELECT id, path, root, mtime, '' as snippet FROM documents
              WHERE replace(replace(replace(replace(replace(
                lower(path), '.hwp',''), '.pdf',''), '.docx',''), '.xlsx',''), '.hwpx','')
                LIKE lower(?) ESCAPE '!'
              LIMIT 20`,
        [`%${sanitizedQuery}%`], (err1, rows1) => {
        if (err1) console.error("q1 error:", err1.message);
        addHits(rows1, "");

        // 2순위: 내용 정확한 구문 일치
        db.all(ftsQ, [`"${sanitizedQuery}"`], (err2, rows2) => {
          if (err2) console.error("q2 error:", err2.message);
          addHits(rows2 || []);

          // 3순위: 파일명 일부 일치 (단어별 prefix)
          db.all(`SELECT id, path, root, mtime, '' as snippet FROM documents
                  WHERE ${words.map(() => `lower(path) LIKE lower(?)`).join(" AND ")}
                  LIMIT 20`,
            words.map(w => `%${w}%`), (err3, rows3) => {
            if (err3) console.error("q3 error:", err3.message);
            addHits(rows3 || [], "");

            // 4순위: 내용 일부 일치 (단어별 AND prefix)
            db.all(ftsQ, [words.map(w => `${w}*`).join(" ")], (err4, rows4) => {
              if (err4) console.error("q4 error:", err4.message);
              addHits(rows4 || []);

              // 5순위: 내용 하나라도 포함 (OR)
              if (words.length > 1) {
                db.all(ftsQ, [words.map(w => `${w}*`).join(" OR ")], (err5, rows5) => {
                  if (err5) console.error("q5 error:", err5.message);
                  addHits(rows5 || []);
                  console.log(`검색 결과: ${allHits.length}건`);
                  resolve({ hits: allHits });
                });
              } else {
                console.log(`검색 결과: ${allHits.length}건`);
                resolve({ hits: allHits });
              }
            });
          });
        });
      });

    } catch (err) {
      console.error("Search error:", err);
      resolve({ hits: [] });
    }
  });
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
