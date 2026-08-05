# 뉴런소프트 면접 예약 시스템

후보자가 팀원을 골라 면접 일정을 예약하면, Jira 일정 등록 → 이력서/포트폴리오 AI 분석 →
채용 담당 메일 발송까지 자동으로 처리되는 정적 사이트 + Vercel 서버리스 함수 조합입니다.

- 후보자용 예약 페이지: `index.html`
- 어드민(팀원 공유 계정) 슬롯 관리 페이지: `admin.html`
- 서버 로직: `api/*.js` (Vercel Serverless Functions)
- 데이터: Supabase (`interview_slots` 테이블)

## 전체 흐름

### 1. 후보자 예약 (`index.html` → `api/upload-url.js`, `api/book-slot.js`)

1. 후보자가 면접관 아바타 선택 → 그 담당자의 예약 가능한 슬롯이 캘린더에 표시
2. 날짜·시간 선택 → 이름/이메일/연락처/포지션/희망연봉 입력, 이력서(필수)·포트폴리오(선택) 첨부
3. 파일은 `api/upload-url.js`가 발급한 서명 URL로 브라우저 → Supabase Storage에 **직접** 업로드
   (Vercel 함수의 요청 크기 제한을 피하기 위함)
4. 예약 확정은 `api/book-slot.js`가 처리 — 아래 4단계를 순서대로 실행하고,
   **뒤 세 단계는 실패해도 예약 자체(1단계)는 성공으로 응답**한다:
   1. Supabase `interview_slots` 슬롯을 `is_booked=true`로 업데이트 (service_role 키 사용 — 이유는 아래 "왜 service_role 키를 쓰는가" 참고)
   2. Jira `OPER` 프로젝트, `OPER-30`(채용 Epic) 하위에 면접 미팅 이슈 생성
   3. Claude API(`claude-sonnet-5`)로 이력서/포트폴리오 PDF를 분석해 채용 담당자용 요약 생성
      (Supabase Storage 공개 URL을 그대로 `document` 소스로 넘겨서 다운로드/base64 변환 없이 처리)
   4. Resend로 `newlearnsoft@gmail.com`에 예약 정보 + Jira 링크 + AI 분석 결과를 담은 알림 메일 발송

### 2. 어드민 슬롯 관리 (`admin.html`)

- Supabase Auth(이메일/비밀번호)로 로그인하는 팀 공유 계정
- 로그인 후 "오늘은 누구로 접속하나요?" 화면에서 본인(담당자) 선택 → 세션에 저장
- 담당자별로 슬롯 추가(캘린더에서 날짜 클릭 → 시작/종료 시간 입력) · 목록 조회 · 삭제
- 이 페이지는 Supabase Auth 세션으로 인증된 브라우저 클라이언트가 직접 Supabase를 호출 (서버 함수 안 거침)

### 3. 노아(대표) 일정 자동 동기화 (`api/sync-schedule.js`)

대표의 Jira 개인 일정(미팅/발표 이슈)과 예약 사이트 슬롯을 자동으로 맞춰준다 — **`interviewer: noah` 슬롯만** 대상.
다른 팀원 슬롯은 각자 `admin.html`에서 수동 관리.

- **트리거 2가지**: Jira Automation 웹훅(즉시, `x-sync-secret` 헤더) + Vercel Cron(`vercel.json`, 매일 00:00 UTC 안전망)
- **로직**: OPER 프로젝트의 미팅·발표 이슈 description에서 `YYYY-MM-DD (요일) HH:MM ~ HH:MM` 패턴을 파싱해 "바쁜 시간대" 목록 생성 → 평일 업무시간(10-12시, 13-18시, 1시간 단위) 중 바쁜 시간과 겹치는 미예약 슬롯은 삭제, 비어있는데 슬롯이 없는 시간은 새로 생성. **이미 예약된 슬롯은 절대 건드리지 않음.** 지난 날짜의 미예약 슬롯도 함께 정리.

## 폴더 구조

```
index.html          후보자 예약 페이지
admin.html           어드민 슬롯 관리 페이지
style.css            공통 스타일
assets/team/*.png    팀원 아바타 이미지 (노아/도치/말티/소호/제이)
api/
  book-slot.js        예약 확정 + Jira 이슈 생성 + AI 분석 + 메일 발송
  upload-url.js        이력서/포트폴리오 업로드용 서명 URL 발급
  sync-schedule.js      Jira ↔ 슬롯 자동 동기화 (cron + webhook)
vercel.json            cron 설정, book-slot 함수 timeout(60초) 설정
```

## 환경변수 (Vercel 프로젝트 Settings → Environment Variables)

| 변수명 | 사용처 | 설명 |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | book-slot, upload-url, sync-schedule | Supabase 서버 전용 키. RLS 우회용 (아래 설명 참고) |
| `JIRA_EMAIL` | book-slot, sync-schedule | Jira API 호출용 계정 이메일 |
| `JIRA_API_TOKEN` | book-slot, sync-schedule | Jira API 토큰 |
| `ANTHROPIC_API_KEY` | book-slot | Claude API로 이력서/포트폴리오 분석 |
| `RESEND_API_KEY` | book-slot | 예약 알림 메일 발송 |
| `RESEND_FROM_EMAIL` | book-slot | 메일 발신 주소. 예: `채용팀 <no-reply@newlearn-soft.com>` — 비워두면 Resend 테스트용 `onboarding@resend.dev`로 발송되며, 이 경우 Resend 가입 이메일로만 발송 가능 (도메인 인증 전 상태) |
| `CRON_SECRET` | sync-schedule | Vercel Cron 요청 인증 (`Authorization: Bearer ...`) |
| `SYNC_WEBHOOK_SECRET` | sync-schedule | Jira Automation 웹훅 인증 (`x-sync-secret` 헤더) |

`RESEND_FROM_EMAIL`이 가리키는 도메인은 [resend.com/domains](https://resend.com/domains)에서 DNS 인증(DKIM + SPF)이 완료돼 있어야 실제 수신자에게 발송된다. **환경변수를 바꾼 뒤에는 반드시 재배포해야 반영된다.**

## 왜 service_role 키를 쓰는가

브라우저의 anon key로 `interview_slots`를 직접 UPDATE하는 경로가 이 프로젝트의 Supabase RLS에서
원인 불명으로 계속 막혀서(정책·grant·트리거 전부 정상인데도 PostgREST 경유 요청만 거부됨),
예약 확정(`book-slot.js`)과 슬롯 자동 동기화(`sync-schedule.js`)는 service_role 키를 쓰는
서버 엔드포인트로 우회한다. INSERT/DELETE(어드민 슬롯 추가/삭제)는 Supabase Auth 세션으로 정상 동작하므로
`admin.html`은 그대로 브라우저에서 직접 호출.

## 로컬 개발 / 배포

```bash
vercel dev       # 로컬 실행
vercel deploy --prod   # 프로덕션 배포 (환경변수 변경 후에도 반드시 재실행)
```

## 알려진 제약 / TODO

- `book-slot.js`의 Jira 이슈 생성·AI 분석·메일 발송은 각각 실패해도 예약 자체를 실패 처리하지 않는다 — 응답 JSON의 `jiraError` / `analysisError` / `emailError` 필드로 실패 원인 확인 가능
- 이력서/포트폴리오는 Claude에 `document(url)` 소스로 전달되므로 Supabase Storage 버킷(`resumes`)이 공개 읽기(public read)여야 함
