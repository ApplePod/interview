// 면접이 아닌 이유(개인 일정·외부 미팅·휴가·행사 참석 등)로 팀원 슬롯을 막을 때 쓰는 엔드포인트.
// book-slot.js(후보자 예약 전용 — Jira 면접 이슈·이력서 분석·이메일 발송까지 같이 실행)와는 별개로,
// "그 시간대 슬롯만 닫는다"는 최소 동작만 한다. service_role 키를 써서 RLS를 우회한다
// (anon key로는 이 테이블에 쓰기 자체가 막혀 있음 — README "왜 service_role 키를 쓰나요?" 참고).
//
// 트리거: POST, 헤더 x-block-secret (BLOCK_SLOT_SECRET 환경변수와 일치해야 함)
// 바디: { slot_date, start_time, end_time, interviewer, jira_issue_key, label }

const SUPABASE_URL = 'https://lnvaqdfhsewihveemhbm.supabase.co';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const { slot_date, start_time, end_time, interviewer, jira_issue_key, label } = req.body || {};
  if (!slot_date || !start_time || !end_time || !interviewer) {
    res.status(400).json({ ok: false, error: 'slot_date, start_time, end_time, interviewer는 필수' });
    return;
  }

  try {
    const st = start_time.length === 5 ? `${start_time}:00` : start_time;
    const et = end_time.length === 5 ? `${end_time}:00` : end_time;

    const existing = (await sbFetch(
      `/interview_slots?slot_date=eq.${slot_date}&interviewer=eq.${interviewer}&is_booked=eq.false&start_time=gte.${st}&start_time=lt.${et}&select=id,start_time,end_time`
    )) || [];

    const closed = [];
    for (const slot of existing) {
      await sbFetch(`/interview_slots?id=eq.${slot.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          is_booked: true,
          candidate_name: label || '[내부일정]',
          jira_issue_key: jira_issue_key || null,
          booked_at: new Date().toISOString(),
        }),
      });
      closed.push(slot.id);
    }

    let created = null;
    if (existing.length === 0) {
      const inserted = await sbFetch('/interview_slots', {
        method: 'POST',
        body: JSON.stringify([{
          slot_date,
          start_time: st,
          end_time: et,
          interviewer,
          is_booked: true,
          candidate_name: label || '[내부일정]',
          jira_issue_key: jira_issue_key || null,
          booked_at: new Date().toISOString(),
        }]),
      });
      created = (inserted || []).map((r) => r.id);
    }

    res.status(200).json({ ok: true, closed, created });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};

function isAuthorized(req) {
  const secret = process.env.BLOCK_SLOT_SECRET;
  const provided = req.headers['x-block-secret'];
  return Boolean(secret) && provided === secret;
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
