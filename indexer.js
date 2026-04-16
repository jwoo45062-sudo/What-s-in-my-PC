const fs = require('fs');
const path = require('path');
const util = require('util');
const XLSX = require('xlsx');

const electron = require('electron');
const app = electron.app || electron.remote?.app;
// exe 옆 data 폴더 (main.js와 동일 경로 사용)
const userDataPath = app
  ? path.join(path.dirname(app.getPath('exe')), 'data')
  : path.join(require('os').homedir(), '.whats-in-my-pc');

if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });

const logStream = fs.createWriteStream(path.join(userDataPath, "app.log"), { flags: "a" });
function log(level, ...args) {
  const msg = `[${level}] ${util.format(...args)}\n`;
  logStream.write(msg);
  process.stdout.write(msg);
}

const VALID_EXTS = ['.txt', '.md', '.pdf', '.hwp', '.docx', '.hwpx', '.xlsx', '.xls'];
const EXCLUDED_DIRS = [
  'appdata', 'node_modules', '$recycle.bin',
  'system volume information', 'windows',
  'program files', 'program files (x86)', '.git'
];

function getAllFiles(dirPath, result = []) {
  try {
    const name = path.basename(dirPath).toLowerCase();
    if (EXCLUDED_DIRS.includes(name) || name.startsWith('.')) return result;
    for (const file of fs.readdirSync(dirPath)) {
      const full = path.join(dirPath, file);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) getAllFiles(full, result);
        else if (VALID_EXTS.includes(path.extname(file).toLowerCase())) result.push(full);
      } catch(e) {}
    }
  } catch(e) {}
  return result;
}

function cleanMarkdown(text) {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]{3,}$/gm, '')
    .replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.txt' || ext === '.md') {
      return await fs.promises.readFile(filePath, 'utf8');
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const wb = XLSX.readFile(filePath);
      return wb.SheetNames.map(sn => XLSX.utils.sheet_to_csv(wb.Sheets[sn])).join("\n");
    }
    const { parse } = await import('kordoc');
    const buf = await fs.promises.readFile(filePath);
    const result = await parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (result?.success && result.markdown) return cleanMarkdown(result.markdown);
    return "";
  } catch(err) {
    log("WARN", `파싱 실패: ${path.basename(filePath)} - ${err.message}`);
    return "";
  }
}

function makeId(filePath) {
  return Buffer.from(filePath).toString('base64').replace(/[^a-zA-Z0-9-_]/g, '');
}

async function syncDocuments(db, forceAll, targetDirectories, onProgress) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    log("INFO", `Sync started... (forceAll: ${forceAll})`);

    const targets = Array.isArray(targetDirectories) ? targetDirectories : [targetDirectories];

    let validFiles = [];
    targets.forEach(t => {
      try {
        const stat = fs.statSync(t);
        if (stat.isDirectory()) validFiles = validFiles.concat(getAllFiles(t));
        else if (VALID_EXTS.includes(path.extname(t).toLowerCase())) validFiles.push(t);
      } catch(e) {}
    });
    log("INFO", `대상 파일 수: ${validFiles.length}개`);

    function run(existingMap) {
      // 삭제된 파일 DB에서 제거
      const validFileIds = new Set(validFiles.map(f => makeId(f)));
      const deletedIds = [...existingMap.keys()].filter(id => !validFileIds.has(id));
      if (deletedIds.length > 0) {
        log("INFO", `삭제된 파일 ${deletedIds.length}개 DB에서 제거`);
        db.serialize(() => {
          db.run("BEGIN TRANSACTION");
          deletedIds.forEach(id => {
            db.run("DELETE FROM documents WHERE id = ?", [id]);
            db.run("DELETE FROM documents_fts WHERE doc_id = ?", [id]);
          });
          db.run("COMMIT");
        });
      }

      const toProcess = validFiles.filter(f => {
        try {
          const id = makeId(f);
          const mtime = fs.statSync(f).mtime.getTime();
          return existingMap.get(id) !== mtime;
        } catch(e) { return false; }
      }).map(f => ({
        filePath: f,
        id: makeId(f),
        mtime: fs.statSync(f).mtime.getTime(),
        rootPath: targets.find(t => {
          try { return fs.statSync(t).isDirectory() && f.startsWith(t); } catch(e) { return false; }
        }) || path.dirname(f)
      }));

      log("INFO", `신규/변경 파일: ${toProcess.length}개`);

      if (toProcess.length === 0) {
        log("INFO", "변경사항 없음. 동기화 완료.");
        saveSyncLog(startTime, 0, 0);
        return resolve();
      }

      const CONCURRENCY = 5;
      let done = 0;

      (async () => {
        for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
          const chunk = toProcess.slice(i, i + CONCURRENCY);
          const results = await Promise.all(chunk.map(async f => {
            log("INFO", `파싱 중: ${path.basename(f.filePath)}`);
            return { ...f, content: await extractText(f.filePath) };
          }));

          await new Promise((res, rej) => {
            db.serialize(() => {
              db.run("BEGIN TRANSACTION");
              for (const doc of results) {
                if (!doc) continue;
                const content = doc.content || "";
                db.run("INSERT OR REPLACE INTO documents (id, path, content, mtime, root) VALUES (?,?,?,?,?)",
                  [doc.id, doc.filePath, content, doc.mtime, doc.rootPath]);
                db.run("DELETE FROM documents_fts WHERE doc_id = ?", [doc.id]);
                if (content) {
                  db.run("INSERT INTO documents_fts (doc_id, path, content) VALUES (?,?,?)",
                    [doc.id, doc.filePath, content]);
                }
              }
              db.run("COMMIT", err => err ? rej(err) : res());
            });
          });

          done += chunk.length;
          if (onProgress) onProgress(done, toProcess.length, path.basename(chunk[chunk.length-1].filePath));
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        log("INFO", `동기화 완료 (${elapsed}s)`);
        saveSyncLog(startTime, toProcess.length, parseFloat(elapsed));
        resolve();
      })().catch(reject);
    }

    if (forceAll) {
      db.serialize(() => {
        db.run("DELETE FROM documents");
        db.run("DELETE FROM documents_fts");
        db.run("", () => { log("INFO", "DB 초기화 완료."); run(new Map()); });
      });
    } else {
      db.all("SELECT id, mtime FROM documents", [], (err, rows) => {
        if (err) return reject(err);
        const map = new Map(rows.map(r => [r.id, r.mtime]));
        run(map);
      });
    }
  });
}

function saveSyncLog(startTime, fileCount, elapsed) {
  try {
    const logPath = path.join(userDataPath, "sync_log.txt");
    const dateStr = new Date(startTime).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    fs.appendFileSync(logPath, `[${dateStr}] 파싱: ${fileCount}개 / 소요: ${elapsed}초\n`, 'utf8');
  } catch(e) {}
}

module.exports = { syncDocuments };
