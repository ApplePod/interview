// Jira "내 스케쥴"(OPER 프로젝트, 미팅·발표 이슈) 기준으로
// interview_slots 예약 가능 시간을 자동 동기화한다.
// 이 스케줄 소스는 대표(노아)의 Jira 일정이라, 자동으로 여는 슬롯은 interviewer: 'noah'로 태깅한다.
// 다른 팀원 슬롯은 admin.html에서 각자 담당자로 로그인해 수동으로 관리한다.
//
// 트리거 2가지:
//   1) Jira Automation 웹훅 (POST, 헤더 x-sync-secret) — 이슈 생성/수정/삭제 시 즉시
//   2) Vercel Cron (GET, Authorization: Bearer CRON_SECRET) — 하루 1회 안전망
//
// 로직:
//   - OPER 프로젝트의 미팅·발표 이슈에서 "YYYY-MM-DD (요일) HH:MM ~ HH:MM" 패턴을 파싱해
//     바쁜 시간대(busy block) 목록을 만든다.
//   - 지난 날짜의 미예약 슬롯은 정리한다.
//   - 앞으로 HORIZON_DAYS일 동안 평일 업무시간(점심 제외) 중 바쁜 시간과 겹치는
//     미예약 슬롯은 닫고(삭제), 비어있는데 슬롯이 없는 시간은 새로 연다(삽입).
//   - 이미 예약된(is_booked=true) 슬롯은 절대 건드리지 않는다.

const JIRA_BASE = 'https://newlearnsoft.atlassian.net';
const SUPABASE_URL = 'https://lnvaqdfhsewihveemhbm.supabase.co';
const STORAGE_BUCKET = 'resumes';
const ORPHAN_GRACE_MS = 3 * 60 * 60 * 1000; // 업로드만 하고 예약을 아직 안 끝냈을 수도 있으니 3시간은 봐준다

const WORK_BLOCKS = [
  ['10:00', '12:00'],
  ['13:00', '18:00'],
];
const SLOT_MINUTES = 60;
const HORIZON_DAYS = 28;
const INTERVIEWER = 'noah';

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const busyBlocks = await fetchJiraBusyBlocks();
    const result = await reconcile(busyBlocks);
    const orphanResult = await cleanupOrphanedUploads().catch((err) => ({ error: String(err && err.message || err) }));
    res.status(200).json({
      ok: true,
      busyBlocks: busyBlocks.length,
      closed: result.toDelete.length,
      opened: result.toInsert.length,
      cleanedUpPast: result.cleanedUp,
      orphanCleanup: orphanResult,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};

// 이력서/포트폴리오 파일은 업로드된 뒤 예약을 끝까지 안 마치면(폼 중간에 이탈 등)
// 스토리지에 영원히 남는다. 슬롯별 폴더를 훑어서, 예약과 연결되지 않은 채
// 일정 시간이 지난 파일은 지운다.
async function listBucketPrefix(prefix) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${STORAGE_BUCKET}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!resp.ok) throw new Error(`storage list failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function deleteStoragePrefixes(prefixes) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes }),
  });
}

async function cleanupOrphanedUploads() {
  const now = Date.now();
  const topLevel = await listBucketPrefix('');
  // Supabase Storage list: 폴더는 id가 없고 실제 파일만 id/metadata를 가진다.
  const slotFolders = topLevel.filter((entry) => !entry.id).map((entry) => entry.name);

  let checkedFolders = 0;
  let deletedFolders = 0;
  let deletedFiles = 0;

  for (const slotId of slotFolders) {
    checkedFolders++;
    const files = await listBucketPrefix(`${slotId}/`);
    if (!files || files.length === 0) continue;

    const newestMs = Math.max(...files.map((f) => new Date((f.created_at || f.updated_at || 0)).getTime()));
    if (now - newestMs < ORPHAN_GRACE_MS) continue; // 아직 예약 진행 중일 수 있으니 유예

    const rows = await sbFetch(
      `/interview_slots?id=eq.${encodeURIComponent(slotId)}&select=id,is_booked,resume_url,portfolio_url`
    );
    const row = rows && rows[0];
    const stillReferenced = row && row.is_booked && (
      (row.resume_url || '').includes(`/${slotId}/`) || (row.portfolio_url || '').includes(`/${slotId}/`)
    );
    if (stillReferenced) continue;

    await deleteStoragePrefixes(files.map((f) => `${slotId}/${f.name}`));
    deletedFolders++;
    deletedFiles += files.length;
  }

  return { checkedFolders, deletedFolders, deletedFiles };
}

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] || '';
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;

  const webhookSecret = process.env.SYNC_WEBHOOK_SECRET;
  const provided = req.headers['x-sync-secret'];
  if (webhookSecret && provided === webhookSecret) return true;

  return false;
}

async function fetchJiraBusyBlocks() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  const jql = 'project = OPER AND issuetype in (미팅, 발표)';
  const url = `${JIRA_BASE}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description&expand=renderedFields&maxResults=200`;

  const resp = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Jira search failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();

  const blocks = [];
  for (const issue of data.issues || []) {
    const html = (issue.renderedFields && issue.renderedFields.description) || '';
    const text = stripHtml(html);
    const m = text.match(/(\d{4}-\d{2}-\d{2})\s*\([^)]*\)\s*(\d{2}:\d{2})\s*\\?~\s*(\d{2}:\d{2})/);
    if (m) {
      blocks.push({ date: m[1], start: m[2], end: m[3], issueKey: issue.key });
    }
  }
  return blocks;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function generateFreeSlots(busyBlocks) {
  const today = new Date();
  const slots = [];
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    const ds = dateStr(d);
    const dayBusy = busyBlocks.filter((b) => b.date === ds);

    for (const [blockStart, blockEnd] of WORK_BLOCKS) {
      let cursor = blockStart;
      while (cursor < blockEnd) {
        const end = addMinutes(cursor, SLOT_MINUTES);
        if (end > blockEnd) break;
        const isBusy = dayBusy.some((b) => overlaps(cursor, end, b.start, b.end));
        if (!isBusy) slots.push({ slot_date: ds, start_time: cursor, end_time: end, interviewer: INTERVIEWER });
        cursor = end;
      }
    }
  }
  return slots;
}

async function sbFetch(path, opts = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
  });
  if (!resp.ok) {
    throw new Error(`Supabase ${opts.method || 'GET'} ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  if (resp.status === 204) return null;
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function reconcile(busyBlocks) {
  const today = dateStr(new Date());
  const horizonEnd = dateStr(new Date(Date.now() + HORIZON_DAYS * 86400000));

  // 1. 지난 날짜의 미예약 슬롯 정리 (담당자 무관, 예약된 건 기록으로 남김)
  const cleanedUp = await sbFetch(
    `/interview_slots?slot_date=lt.${today}&is_booked=eq.false`,
    { method: 'DELETE' }
  );

  // 2. 노아 담당 미예약 슬롯 조회 (지평선 내) — 다른 팀원 슬롯은 이 잡이 건드리지 않는다
  const current = (await sbFetch(
    `/interview_slots?slot_date=gte.${today}&slot_date=lte.${horizonEnd}&is_booked=eq.false&interviewer=eq.${INTERVIEWER}&select=id,slot_date,start_time,end_time`
  )) || [];

  // 3. 바쁜 시간과 겹치는 슬롯 → 닫기(삭제)
  const toDelete = current.filter((s) =>
    busyBlocks.some(
      (b) => b.date === s.slot_date && overlaps(s.start_time.slice(0, 5), s.end_time.slice(0, 5), b.start, b.end)
    )
  );
  if (toDelete.length) {
    const ids = toDelete.map((s) => s.id).join(',');
    await sbFetch(`/interview_slots?id=in.(${ids})`, { method: 'DELETE' });
  }

  // 4. 비어있는데 슬롯이 없는 시간 → 열기(삽입)
  const remaining = new Set(
    current.filter((s) => !toDelete.includes(s)).map((s) => `${s.slot_date}_${s.start_time.slice(0, 5)}`)
  );
  const desiredFree = generateFreeSlots(busyBlocks);
  const toInsert = desiredFree.filter((s) => !remaining.has(`${s.slot_date}_${s.start_time}`));
  if (toInsert.length) {
    await sbFetch(`/interview_slots`, { method: 'POST', body: JSON.stringify(toInsert) });
  }

  return { toDelete, toInsert, cleanedUp: (cleanedUp || []).length };
}
