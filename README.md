# What's in my PC

PC에 저장된 문서의 **내용까지 검색**할 수 있는 데스크탑 검색 도구입니다.

파일명을 몰라도, 문서 안에 있는 문구로 찾을 수 있습니다.

---

## 주요 기능

- **HWP, PDF, Word, Excel** 등 문서 내용 기반 검색
- 파일명을 몰라도 **문서 안의 문구**로 검색 가능
- 한 번 분석해두면 앱을 껐다 켜도 **검색 데이터 유지**
- 신규/변경 파일만 자동 업데이트 (매번 전체 재파싱 불필요)
- 삭제된 파일은 동기화 시 자동으로 DB에서 제거
- **인터넷 연결 없이** 로컬에서만 동작 (보안 걱정 없음)

## 검색 우선순위

| 순위 | 기준 |
|------|------|
| 1 | 파일명 일치 |
| 2 | 문서 내용 정확한 구문 일치 |
| 3 | 파일명 일부 일치 |
| 4 | 문서 내용 단어별 일치 |
| 5 | 문서 내용 단어 중 하나라도 포함 |

---

## 기술 스택

- [Electron](https://www.electronjs.org/)
- [SQLite FTS5](https://www.sqlite.org/fts5.html) — 전문 검색 인덱스
- [kordoc](https://www.npmjs.com/package/kordoc) — HWP / PDF / DOCX 파싱
- [xlsx](https://www.npmjs.com/package/xlsx) — Excel 파싱

---

## 설치 및 실행

### 요구사항
- Node.js 18 이상
- Windows 10 / 11

### 실행 방법

```bash
npm install
npm run rebuild   # sqlite3 네이티브 모듈 빌드
npm start
```

### 배포용 exe 빌드

```bash
npm run build
```

`dist/win-unpacked/What's in my PC.exe` 생성됩니다.

> **참고**: DB와 로그는 exe 옆 `data/` 폴더에 저장됩니다.  
> exe를 용량이 넉넉한 드라이브(E: 등)에 두는 것을 권장합니다.

---

## 지원 파일 형식

`.hwp` `.hwpx` `.pdf` `.docx` `.xlsx` `.xls` `.txt` `.md`

> 스캔(이미지) PDF는 텍스트 인식 불가

---

## License

MIT
