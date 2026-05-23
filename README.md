# Unwrap

서비스 분석용 Chrome Extension. 한 탭의 사용 흐름을 **세션 단위**로 기록해서 QA 테스트 생성 / 사이트 재구축의 원본 자산을 만든다.

전체 설계는 [DESIGN.md](./DESIGN.md) 참고. 이 문서는 **M1 (네트워크 + 스크린샷 캡처)** 사용법.

## M1 기능 범위

- 네비게이션 / SPA URL 변경 캡처
- HTTP 요청·응답 메타 + 응답 본문 (CDP `Network.*` 사용)
- 탭 변경/네비게이션마다 뷰포트 스크린샷
- 인증 상태(localStorage / sessionStorage / cookies) 수동 캡처
- 세션 목록, 삭제, **HAR / JSON 내보내기**
- 민감 헤더(Authorization/Cookie 등) 자동 마스킹

이후 M2(사용자 액션 레코딩), M3(DOM/AX/coverage), M4(LLM 테스트 생성 + replay 검증)로 확장.

## 빌드

```bash
npm install
npm run build
```

빌드 산출물은 `dist/`.

## Chrome에 설치

1. Chrome → `chrome://extensions`
2. 우상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** → `dist/` 폴더 선택
4. 툴바 아이콘 클릭 → 사이드 패널 오픈

## 사용

1. 분석할 탭을 활성화
2. 사이드 패널 → **● Start recording**
   - 해당 탭에 `chrome.debugger`가 attach 되고 "DevTools가 이 탭을 디버깅 중입니다" 배너가 노출됨 (정상)
3. 사이트를 평소처럼 사용 (클릭, 폼 입력, 페이지 이동)
4. 로그인 상태 같은 인증 컨텍스트가 필요하면 **Capture storage** 클릭
5. 끝나면 **■ Stop recording**
6. **Export HAR** (네트워크 분석/도구 호환) 또는 **Export JSON** (raw 캡처 + 메타데이터)

## 개발

```bash
npm run dev        # Vite + @crxjs HMR
npm run typecheck
```

`npm run dev` 후 `dist/`를 unpacked로 설치하면 코드 변경 시 자동 재로드된다 (background는 수동 reload 필요할 수 있음).

## 알려진 제약

- `chrome.debugger` attach 배너는 우회 불가 (Chrome 정책).
- 풀페이지 스크린샷, 콘솔, exception 캡처는 M2에서 추가.
- 응답 본문은 5MB 이상 / image·video·audio·font 는 저장 생략 (`src/shared/redact.ts:shouldCaptureResponseBody`).
- IndexedDB 쿼터를 초과하면 캡처 실패 — 긴 세션은 분할 권장.

## 디렉토리

```
src/
├── background/      service worker: 세션 관리, debugger 제어, export
├── content/         content script (M1은 placeholder)
├── sidepanel/       React UI (start/stop, 세션 목록)
├── shared/          이벤트 스키마, IndexedDB, 민감정보 마스킹
└── manifest.config.ts
```
