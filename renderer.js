const { ipcRenderer, clipboard, shell } = require("electron");

// --- 폴더 목록 (localStorage 영속, 하드코딩 없음) ---
let targetDirs = [];
try {
  const saved = localStorage.getItem("wimp_targetDirs");
  if (saved) targetDirs = JSON.parse(saved);
} catch(e) { targetDirs = []; }

function saveTargetDirs() {
  localStorage.setItem("wimp_targetDirs", JSON.stringify(targetDirs));
}

// --- 온보딩 배너 표시/숨김 ---
function updateOnboarding() {
  document.getElementById("onboarding").style.display = targetDirs.length === 0 ? "block" : "none";
}

// --- 폴더 목록 렌더링 ---
function renderFolderList() {
  const ul = document.getElementById("folderList");
  ul.innerHTML = "";
  if (targetDirs.length === 0) {
    ul.innerHTML = `<li style="color:#94a3b8; font-size:0.88rem; padding:8px 4px; border:none; background:none;">
      아직 추가된 폴더가 없습니다. 위 버튼으로 폴더를 추가하세요.
    </li>`;
  } else {
    targetDirs.forEach((dir, idx) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.innerText = dir;
      const rm = document.createElement("button");
      rm.innerText = "✖";
      rm.title = "폴더 제거";
      rm.onclick = () => {
        targetDirs.splice(idx, 1);
        saveTargetDirs();
        renderFolderList();
        updateOnboarding();
      };
      li.appendChild(span);
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }
  updateOnboarding();
}

renderFolderList();

// --- 폴더 추가 ---
document.getElementById("addFolderBtn").addEventListener("click", async () => {
  const paths = await ipcRenderer.invoke("select-dirs");
  if (paths && paths.length > 0) {
    let changed = false;
    paths.forEach(p => {
      if (!targetDirs.includes(p)) { targetDirs.push(p); changed = true; }
    });
    if (changed) { saveTargetDirs(); renderFolderList(); }
  }
});

// --- 동기화 ---
function setSyncing(active) {
  document.getElementById("syncBtn").disabled = active;
  document.getElementById("forceSyncBtn").disabled = active;
}

document.getElementById("syncBtn").addEventListener("click", () => {
  if (targetDirs.length === 0) {
    setStatus("먼저 검색할 폴더를 추가해주세요.", "warn");
    return;
  }
  setStatus("동기화 중...");
  setSyncing(true);
  ipcRenderer.send("start-sync", targetDirs);
});

document.getElementById("forceSyncBtn").addEventListener("click", () => {
  if (targetDirs.length === 0) {
    setStatus("먼저 검색할 폴더를 추가해주세요.", "warn");
    return;
  }
  if (!confirm("기존 분석 데이터를 모두 삭제하고 처음부터 다시 분석합니다.\n시간이 걸릴 수 있습니다. 계속하시겠습니까?")) return;
  setStatus("전체 재파싱 시작...");
  setSyncing(true);
  ipcRenderer.send("start-force-sync", targetDirs);
});

ipcRenderer.on("sync-progress", (event, { current, total, fileName }) => {
  const pct = Math.round((current / total) * 100);
  setStatus(`분석 중 ${pct}% (${current}/${total}) — ${fileName}`);
});

ipcRenderer.on("sync-complete", (event, status) => {
  setSyncing(false);
  if (status === "success") setStatus("동기화 완료! 검색하실 수 있습니다.");
  else setStatus("오류 발생: " + status, "error");
});

// --- 검색 ---
async function performSearch() {
  const query = document.getElementById("searchBox").value.trim();
  if (!query) {
    document.getElementById("results").innerHTML = "";
    setStatus("");
    return;
  }
  if (targetDirs.length === 0) {
    setStatus("검색할 폴더를 먼저 추가하고 동기화해주세요.", "warn");
    return;
  }
  setStatus("검색 중...");
  try {
    const data = await ipcRenderer.invoke("search-docs", { query, targetDirs });
    renderResults(data.hits, query);
    setStatus(data.hits.length > 0
      ? `검색 결과 ${data.hits.length}건`
      : "검색 결과가 없습니다. 다른 검색어를 입력해보세요.");
  } catch(err) {
    setStatus("오류: 검색 중 문제가 발생했습니다.", "error");
  }
}

document.getElementById("searchSubmitBtn").addEventListener("click", performSearch);
document.getElementById("searchBox").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); performSearch(); }
});

// --- 결과 렌더링 ---
function renderResults(hits, query) {
  const container = document.getElementById("results");
  container.innerHTML = "";

  if (hits.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9.172 9.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <p>검색 결과가 없습니다.<br>다른 검색어를 입력해보세요.</p>
      </div>`;
    return;
  }

  hits.forEach(hit => {
    const div = document.createElement("div");
    div.className = "result-item";

    // 경로 행
    const pathRow = document.createElement("div");
    pathRow.className = "path-row";
    const pathSpan = document.createElement("span");
    pathSpan.innerText = hit.path || "경로 알 수 없음";
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-copy";
    copyBtn.innerText = "경로 복사";
    copyBtn.onclick = () => {
      clipboard.writeText(hit.path);
      copyBtn.innerText = "복사됨!";
      setTimeout(() => { copyBtn.innerText = "경로 복사"; }, 1500);
    };
    // 파일 열기 버튼
    const openBtn = document.createElement("button");
    openBtn.className = "btn-open";
    openBtn.innerText = "파일 열기";
    openBtn.onclick = () => {
      shell.openPath(hit.path).then(err => {
        if (err) {
          openBtn.innerText = "열기 실패";
          openBtn.style.background = "#fee2e2";
          setTimeout(() => { openBtn.innerText = "파일 열기"; openBtn.style.background = ""; }, 2000);
        }
      });
    };

    pathRow.appendChild(pathSpan);
    pathRow.appendChild(openBtn);
    pathRow.appendChild(copyBtn);

    // 내용 미리보기
    const snippet = document.createElement("div");
    snippet.className = "snippet";
    const raw = (hit._formatted && hit._formatted.content) ? hit._formatted.content : "";
    snippet.innerHTML = raw || `<span style="color:#94a3b8">(내용 미리보기 없음)</span>`;

    div.appendChild(pathRow);
    div.appendChild(snippet);
    container.appendChild(div);
  });
}

// --- 상태 메시지 ---
function setStatus(msg, type) {
  const el = document.getElementById("statusTxt");
  el.innerText = msg;
  el.style.color = type === "error" ? "#ef4444" : type === "warn" ? "#f59e0b" : "#f59e0b";
}
