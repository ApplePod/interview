// 후보자 예약 처리를 서버에서 대신 해준다.
// 브라우저의 anon key로 직접 interview_slots를 UPDATE하는 경로가 이 프로젝트의
// Supabase RLS에서 원인 불명으로 계속 막혀서(정책·grant·트리거 전부 정상인데도
// PostgREST 경유 요청만 거부됨), service_role 키를 쓰는 서버 엔드포인트로 우회한다.
//
// 예약이 성공하면 Jira OPER-30(채용) 아래에 면접 미팅 이슈도 자동 생성한다.
// Jira 생성이 실패해도 예약 자체는 이미 완료된 것이므로 후보자에게는 실패로 보이지 않게 한다.

const SUPABASE_URL = 'https://lnvaqdfhsewihveemhbm.supabase.co';
const JIRA_BASE = 'https://newlearnsoft.atlassian.net';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const TEAM_NAMES = { noah: '노아', dochi: '도치', malti: '말티', soho: '소호', jay: '제이' };

function fmtDateTimeRange(slot) {
  const d = new Date(slot.slot_date + 'T00:00:00');
  const weekday = WEEKDAYS[d.getDay()];
  const start = slot.start_time.slice(0, 5);
  const end = slot.end_time.slice(0, 5);
  return `${slot.slot_date} (${weekday}) ${start} ~ ${end}`;
}

async function createJiraInterviewIssue(slot, candidate) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const interviewerName = TEAM_NAMES[slot.interviewer] || slot.interviewer || '미정';
  const dateTimeLine = fmtDateTimeRange(slot);

  const description = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '일시' }] },
      { type: 'paragraph', content: [{ type: 'text', text: dateTimeLine }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '후보자' }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `이름: ${candidate.name}` }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `담당자: ${interviewerName}` }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `포지션: ${candidate.position || '미정'}` }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `희망연봉: ${candidate.salary || '-'}` }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `연락처: ${candidate.phone || candidate.email || '-'}` }] }] },
          {
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: candidate.resumeUrl
                ? [{ type: 'text', text: '이력서', marks: [{ type: 'link', attrs: { href: candidate.resumeUrl } }] }]
                : [{ type: 'text', text: '이력서: -' }],
            }],
          },
          {
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: candidate.portfolioUrl
                ? [{ type: 'text', text: '포트폴리오', marks: [{ type: 'link', attrs: { href: candidate.portfolioUrl } }] }]
                : [{ type: 'text', text: '포트폴리오: -' }],
            }],
          },
        ],
      },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '결과' }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '면접 후 작성' }] }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '다음 액션' }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '면접 후 작성' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: '(예약 사이트에서 자동 등록됨)' }] },
    ],
  };

  const body = {
    fields: {
      project: { key: 'OPER' },
      issuetype: { id: '10152' },
      summary: `${candidate.name} 면접`,
      description,
      parent: { key: 'OPER-30' },
      duedate: slot.slot_date,
      customfield_10015: slot.slot_date,
      assignee: { id: '712020:e06ecd82-5f42-4941-8734-43d5f178fd56' },
    },
  };

  const resp = await fetch(`${JIRA_BASE}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`jira create failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const RESEND_API_URL = 'https://api.resend.com/emails';
const NOTIFY_EMAIL = 'newlearnsoft@gmail.com';
const STORAGE_BUCKET = 'resumes';

function storagePathFromPublicUrl(url) {
  const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
  const idx = (url || '').indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}

// 파일은 이미 업로드됐는데 그 사이 다른 사람이 슬롯을 먼저 예약해버려서
// 예약 자체가 실패하는 경우, 업로드된 이력서/포트폴리오가 스토리지에 고아로 남지 않도록 정리한다.
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function isPdfUrl(url) {
  return /\.pdf(\?|#|$)/i.test(url || '');
}

// 이력서/포트폴리오 PDF는 Supabase Storage의 공개 URL이라 다운로드해서 base64로
// 바꿀 필요 없이 Claude API의 document(url) 소스로 바로 넘긴다.
// Claude document 분석은 PDF만 지원하므로, 업로드 폼이 허용하는 .doc/.docx/.hwp 등은
// 여기서 걸러내고 분석을 생략한다 (억지로 넘기면 Claude가 알 수 없는 형식 에러를 뱉는다).
async function analyzeCandidateDocuments(candidate) {
  const documentBlocks = [];
  if (candidate.resumeUrl && isPdfUrl(candidate.resumeUrl)) {
    documentBlocks.push({ type: 'document', source: { type: 'url', url: candidate.resumeUrl } });
  }
  if (candidate.portfolioUrl && isPdfUrl(candidate.portfolioUrl)) {
    documentBlocks.push({ type: 'document', source: { type: 'url', url: candidate.portfolioUrl } });
  }
  if (documentBlocks.length === 0) {
    if (candidate.resumeUrl && !isPdfUrl(candidate.resumeUrl)) {
      throw new Error('이력서가 PDF 형식이 아니라 AI 분석을 생략했습니다 (PDF만 지원).');
    }
    return null;
  }

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      output_config: { effort: 'medium' },
      messages: [
        {
          role: 'user',
          content: [
            ...documentBlocks,
            {
              type: 'text',
              text: [
                `아래는 "${candidate.name}"님이 "${candidate.position || '미정 포지션'}"에 지원하며 제출한 이력서${candidate.portfolioUrl ? '와 포트폴리오' : ''}입니다.`,
                '채용 담당자가 면접 전에 1분 안에 훑어볼 수 있도록 다음 항목으로 한국어 요약을 작성해줘. 각 항목명은 줄 맨 앞에 그대로 쓰고, 마크다운 헤더(#)는 쓰지 마:',
                '핵심 경력/스킬 요약 (2~3줄)',
                '강점',
                '우려되거나 면접에서 확인이 필요한 부분',
                '종합 인상 (한 줄)',
                '문서에 실제로 적힌 내용만 근거로 작성하고, 과장하거나 추측하지 마.',
              ].join('\n'),
            },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`anthropic analysis failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  if (data.stop_reason === 'refusal') return null;
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text : null;
}

async function sendBookingNotificationEmail(slot, candidate, analysis, jiraIssueKey) {
  const interviewerName = TEAM_NAMES[slot.interviewer] || slot.interviewer || '미정';
  const dateTimeLine = fmtDateTimeRange(slot);
  const jiraLink = jiraIssueKey ? `${JIRA_BASE}/browse/${jiraIssueKey}` : null;

  const links = [
    candidate.resumeUrl ? `<a href="${candidate.resumeUrl}">이력서 보기</a>` : null,
    candidate.portfolioUrl ? `<a href="${candidate.portfolioUrl}">포트폴리오 보기</a>` : null,
    jiraLink ? `<a href="${jiraLink}">Jira 이슈 (${jiraIssueKey})</a>` : null,
  ].filter(Boolean).join(' · ');

  const html = `
    <div style="font-family: -apple-system, sans-serif; line-height: 1.6; color: #222;">
      <h2>새 면접 예약: ${escapeHtml(candidate.name)}</h2>
      <p>
        <strong>일시:</strong> ${escapeHtml(dateTimeLine)}<br/>
        <strong>담당자:</strong> ${escapeHtml(interviewerName)}<br/>
        <strong>포지션:</strong> ${escapeHtml(candidate.position || '미정')}<br/>
        <strong>희망연봉:</strong> ${escapeHtml(candidate.salary || '-')}<br/>
        <strong>연락처:</strong> ${escapeHtml(candidate.phone || candidate.email || '-')}
      </p>
      <p>${links}</p>
      ${analysis
        ? `<h3>AI 이력서/포트폴리오 분석</h3>
           <div style="white-space: pre-wrap; background:#f6f6f6; padding:16px; border-radius:8px;">${escapeHtml(analysis)}</div>`
        : '<p><em>AI 분석은 생성되지 않았습니다.</em></p>'}
    </div>
  `;

  const resp = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'NewLearnSoft 채용 <onboarding@resend.dev>',
      to: [NOTIFY_EMAIL],
      subject: `[면접예약] ${candidate.name} · ${candidate.position || '포지션 미정'}`,
      html,
    }),
  });

  if (!resp.ok) {
    throw new Error(`resend send failed: ${resp.status} ${await resp.text()}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  try {
    const { slotId, name, email, phone, position, salary, resumeUrl, portfolioUrl } = req.body || {};

    if (!slotId || !name || !email) {
      res.status(400).json({ ok: false, error: '필수 정보가 누락됐어요 (slotId, name, email 필요).' });
      return;
    }
    if (!salary) {
      res.status(400).json({ ok: false, error: '희망연봉을 입력해주세요.' });
      return;
    }
    if (!resumeUrl) {
      res.status(400).json({ ok: false, error: '이력서 파일을 첨부해주세요.' });
      return;
    }

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${encodeURIComponent(slotId)}&is_booked=eq.false`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          is_booked: true,
          candidate_name: name,
          candidate_email: email,
          candidate_phone: phone || null,
          position: position || null,
          desired_salary: salary,
          resume_url: resumeUrl,
          portfolio_url: portfolioUrl || null,
          booked_at: new Date().toISOString(),
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      res.status(502).json({ ok: false, error: `supabase update failed: ${resp.status} ${text}` });
      return;
    }

    const data = await resp.json();
    if (!data || data.length === 0) {
      // 이미 다른 사람이 먼저 예약함 (is_booked=false 조건에 안 걸림)
      // 이미 업로드된 파일은 고아로 남지 않게 정리 (실패해도 예약 실패 응답 자체는 그대로 내려줌)
      await deleteUploadedFiles([resumeUrl, portfolioUrl]).catch(() => {});
      res.status(409).json({ ok: false, error: 'already_booked' });
      return;
    }

    const slot = data[0];
    const candidate = { name, email, phone, position, salary, resumeUrl, portfolioUrl };

    let jiraIssueKey = null;
    let jiraError = null;
    try {
      const jiraIssue = await createJiraInterviewIssue(slot, candidate);
      jiraIssueKey = jiraIssue.key;
    } catch (err) {
      // 예약 자체는 이미 끝났으니 Jira 실패로 후보자 예약을 실패 처리하지 않는다.
      jiraError = String((err && err.message) || err);
    }

    // 이력서/포트폴리오 AI 분석과 알림 메일도 같은 이유로 실패해도 예약 응답은 성공으로 내려준다.
    let analysis = null;
    let analysisError = null;
    try {
      analysis = await analyzeCandidateDocuments(candidate);
    } catch (err) {
      analysisError = String((err && err.message) || err);
    }

    let emailSent = false;
    let emailError = null;
    try {
      await sendBookingNotificationEmail(slot, candidate, analysis, jiraIssueKey);
      emailSent = true;
    } catch (err) {
      emailError = String((err && err.message) || err);
    }

    res.status(200).json({ ok: true, slot, jiraIssueKey, jiraError, analysis, analysisError, emailSent, emailError });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
