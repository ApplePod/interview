// 후보자가 이메일로 받은 개인 링크(cancel_token)로 본인 예약을 확인하거나 취소할 수 있게 해준다.
// 토큰은 book-slot.js가 예약 확정 시 무작위로 발급하므로, 추측으로 남의 예약을 건드릴 수 없다.
// "변경"은 별도 화면을 만드는 대신 취소 후 같은 담당자로 예약 페이지에 다시 진입시키는 방식으로 처리한다.

const SUPABASE_URL = 'https://lnvaqdfhsewihveemhbm.supabase.co';
const JIRA_BASE = 'https://newlearnsoft.atlassian.net';
const RESEND_API_URL = 'https://api.resend.com/emails';
const NOTIFY_EMAIL = 'newlearnsoft@gmail.com';
const STORAGE_BUCKET = 'resumes';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const TEAM_NAMES = { noah: '노아', dochi: '도치', malti: '말티', soho: '소호', jay: '제이' };

function fmtDateTimeRange(slot) {
  const d = new Date(slot.slot_date + 'T00:00:00');
  const weekday = WEEKDAYS[d.getDay()];
  const start = slot.start_time.slice(0, 5);
  const end = slot.end_time.slice(0, 5);
  return `${slot.slot_date} (${weekday}) ${start} ~ ${end}`;
}

function storagePathFromPublicUrl(url) {
  const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
  const idx = (url || '').indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}

async function deleteUploadedFiles(urls) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prefixes = urls.filter(Boolean).map(storagePathFromPublicUrl).filter(Boolean);
  if (prefixes.length === 0) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes }),
  });
}

async function findSlotByToken(token, { onlyBooked } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const filter = onlyBooked ? `&is_booked=eq.true` : '';
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/interview_slots?cancel_token=eq.${encodeURIComponent(token)}${filter}&select=*`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!resp.ok) throw new Error(`supabase select failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data && data[0] ? data[0] : null;
}

// 취소되면 해당 면접 이슈는 더 이상 필요 없으니 Jira에서 아예 지운다.
// 이미 지워진 상태(404)는 에러로 취급하지 않는다 — 중복 취소 요청 등으로 재시도돼도 안전하게.
async function deleteJiraIssue(issueKey) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const resp = await fetch(`${JIRA_BASE}/rest/api/3/issue/${issueKey}`, {
    method: 'DELETE',
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`jira delete failed: ${resp.status} ${await resp.text()}`);
  }
}

async function notifyCancelEmail(slot) {
  const interviewerName = TEAM_NAMES[slot.interviewer] || slot.interviewer || '미정';
  const html = `
    <div style="font-family: -apple-system, sans-serif; line-height: 1.6; color: #222;">
      <h2>면접 예약 취소: ${slot.candidate_name || '지원자'}</h2>
      <p><strong>${interviewerName}</strong>님과 <strong>${fmtDateTimeRange(slot)}</strong>에 예정됐던 면접이
      후보자에 의해 취소됐어요.${slot.jira_issue_key ? ` (연결된 Jira 이슈 ${slot.jira_issue_key}도 함께 정리됨)` : ''}</p>
    </div>
  `;
  const resp = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'NewLearnSoft 채용 <onboarding@resend.dev>',
      to: [NOTIFY_EMAIL],
      subject: `[면접취소] ${slot.candidate_name || '지원자'} · ${fmtDateTimeRange(slot)}`,
      html,
    }),
  });
  if (!resp.ok) throw new Error(`resend send (cancel notice) failed: ${resp.status} ${await resp.text()}`);
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const token = (req.query && req.query.token) || '';
      if (!token) { res.status(400).json({ ok: false, error: 'token이 필요해요.' }); return; }

      const slot = await findSlotByToken(token, { onlyBooked: true });
      if (!slot) { res.status(404).json({ ok: false, error: 'not_found' }); return; }

      res.status(200).json({
        ok: true,
        slot: {
          slot_date: slot.slot_date,
          start_time: slot.start_time,
          end_time: slot.end_time,
          interviewer: slot.interviewer,
          interviewerName: TEAM_NAMES[slot.interviewer] || slot.interviewer || '미정',
          candidate_name: slot.candidate_name,
        },
      });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }

    const { token, action } = req.body || {};
    if (!token || action !== 'cancel') {
      res.status(400).json({ ok: false, error: 'token과 action(cancel)이 필요해요.' });
      return;
    }

    const slot = await findSlotByToken(token, { onlyBooked: true });
    if (!slot) { res.status(404).json({ ok: false, error: 'not_found' }); return; }

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const patchResp = await fetch(
      `${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${encodeURIComponent(slot.id)}`,
      {
        method: 'PATCH',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_booked: false,
          candidate_name: null,
          candidate_email: null,
          candidate_phone: null,
          position: null,
          desired_salary: null,
          resume_url: null,
          portfolio_url: null,
          booked_at: null,
          cancel_token: null,
        }),
      }
    );
    if (!patchResp.ok) {
      res.status(502).json({ ok: false, error: `취소 처리 실패: ${patchResp.status} ${await patchResp.text()}` });
      return;
    }

    await deleteUploadedFiles([slot.resume_url, slot.portfolio_url]).catch(() => {});
    if (slot.jira_issue_key) {
      await deleteJiraIssue(slot.jira_issue_key).catch(() => {});
    }
    await notifyCancelEmail(slot).catch(() => {});

    res.status(200).json({ ok: true, interviewer: slot.interviewer });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
