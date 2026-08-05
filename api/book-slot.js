// 후보자 예약 처리를 서버에서 대신 해준다.
// 브라우저의 anon key로 직접 interview_slots를 UPDATE하는 경로가 이 프로젝트의
// Supabase RLS에서 원인 불명으로 계속 막혀서(정책·grant·트리거 전부 정상인데도
// PostgREST 경유 요청만 거부됨), service_role 키를 쓰는 서버 엔드포인트로 우회한다.
//
// 예약이 성공하면 Jira OPER-30(채용) 아래에 면접 미팅 이슈도 자동 생성한다.
// Jira 생성이 실패해도 예약 자체는 이미 완료된 것이므로 후보자에게는 실패로 보이지 않게 한다.
//
// Jira 생성 + Claude 분석 + 메일 발송(담당자용/후보자용) 4가지는 다 합치면 10~20초씩 걸릴 수 있어서,
// 후보자를 그동안 기다리게 하지 않으려고 예약 확정(Supabase 업데이트)만 끝나면 바로 응답하고
// 나머지는 waitUntil로 응답 이후 백그라운드에서 마저 처리한다.

const crypto = require('crypto');
const { waitUntil } = require('@vercel/functions');

const SUPABASE_URL = 'https://lnvaqdfhsewihveemhbm.supabase.co';
const JIRA_BASE = 'https://newlearnsoft.atlassian.net';
const SITE_BASE = 'https://interview.newlearn-soft.com';
const STORAGE_BUCKET = 'resumes';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const TEAM_NAMES = { noah: '노아', dochi: '도치', malti: '말티', soho: '소호', jay: '제이' };
const TEAM_PHONES = { noah: '01068893386' };
const INTERVIEW_LOCATION = '서울 관악구 봉천로 545 창업센터 관악';
const MAX_LENGTHS = { name: 100, position: 100, salary: 50, phone: 30 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// resumeUrl/portfolioUrl은 클라이언트가 보내는 값이라, 실제로 "이번 슬롯용으로
// api/upload-url.js가 발급해준 경로"인지 확인 없이 그대로 믿으면 안 된다.
// 검증 없이 신뢰하면 다른 슬롯(다른 사람)의 업로드 URL이나 완전히 외부 URL을
// 이력서인 것처럼 제출해도 그대로 통과돼버린다.
function isOwnedFileUrl(url, slotId) {
  if (typeof url !== 'string') return false;
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${slotId}/`;
  return url.startsWith(prefix);
}

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

  const html = `
    <div style="font-family: -apple-system, sans-serif; line-height: 1.6; color: #222;">
      <h2>새 면접 예약: ${escapeHtml(candidate.name)}</h2>
      <p>
        <strong>일시:</strong> ${escapeHtml(dateTimeLine)}<br/>
        <strong>담당자:</strong> ${escapeHtml(interviewerName)}
      </p>
      <p>
        <strong>이름:</strong> ${escapeHtml(candidate.name)}<br/>
        <strong>이메일:</strong> ${escapeHtml(candidate.email || '-')}<br/>
        <strong>연락처:</strong> ${escapeHtml(candidate.phone || '-')}<br/>
        <strong>지원 포지션:</strong> ${escapeHtml(candidate.position || '미정')}<br/>
        <strong>희망연봉:</strong> ${escapeHtml(candidate.salary || '-')}<br/>
        <strong>이력서:</strong> ${candidate.resumeUrl ? `<a href="${candidate.resumeUrl}">보기</a>` : '-'}<br/>
        <strong>포트폴리오:</strong> ${candidate.portfolioUrl ? `<a href="${candidate.portfolioUrl}">보기</a>` : '-'}${jiraLink ? `<br/><strong>Jira:</strong> <a href="${jiraLink}">${jiraIssueKey}</a>` : ''}
      </p>
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

// 후보자 본인에게 예약 확인 + 취소/변경 링크를 보낸다.
// 링크의 token은 book-slot에서 새로 발급한 무작위 값이라 추측으로 남의 예약을 건드릴 수 없다.
async function sendCandidateConfirmationEmail(slot, candidate, cancelToken) {
  const interviewerName = TEAM_NAMES[slot.interviewer] || slot.interviewer || '미정';
  const interviewerPhone = TEAM_PHONES[slot.interviewer] || null;
  const dateTimeLine = fmtDateTimeRange(slot);
  const manageLink = `${SITE_BASE}/manage.html?token=${encodeURIComponent(cancelToken)}`;

  const html = `
    <div style="font-family: -apple-system, sans-serif; line-height: 1.6; color: #222;">
      <h2>면접 예약이 확정되었어요</h2>
      <p>
        <strong>${escapeHtml(interviewerName)}</strong>님과 <strong>${escapeHtml(dateTimeLine)}</strong>에 뵙겠습니다.
      </p>
      <p>
        📍 <strong>면접 장소:</strong> ${escapeHtml(INTERVIEW_LOCATION)}<br/>
        ${interviewerPhone ? `☎️ <strong>도착하시면 연락주세요:</strong> ${escapeHtml(interviewerPhone)} (${escapeHtml(interviewerName)})` : ''}
      </p>
      <p>일정을 취소하거나 다른 시간으로 변경하고 싶으시면 아래 링크를 이용해주세요.</p>
      <p><a href="${manageLink}" style="display:inline-block; padding:10px 18px; background:#111; color:#fff; text-decoration:none; border-radius:6px;">예약 확인 / 취소·변경하기</a></p>
      <p style="color:#888; font-size:13px;">이 링크는 본인만 사용할 수 있는 개인 링크이니 다른 사람과 공유하지 말아주세요.</p>
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
      to: [candidate.email],
      subject: `[뉴런소프트] 면접 예약 확인 (${dateTimeLine})`,
      html,
    }),
  });

  if (!resp.ok) {
    throw new Error(`resend send (candidate) failed: ${resp.status} ${await resp.text()}`);
  }
}

// Jira 이슈 키는 예약 확정 이후에야 알 수 있어서, 만들어진 뒤 슬롯 행에 별도로 채워 넣는다.
// 나중에 후보자가 취소할 때 이 이슈에 "취소됨" 코멘트를 남기기 위해 필요하다.
async function saveSlotMeta(slotId, fields) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${encodeURIComponent(slotId)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
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
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ ok: false, error: '이메일 형식이 올바르지 않아요.' });
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
    for (const [field, max] of Object.entries(MAX_LENGTHS)) {
      const value = { name, position, salary, phone }[field];
      if (value && String(value).length > max) {
        res.status(400).json({ ok: false, error: `입력값이 너무 길어요 (${field} 최대 ${max}자).` });
        return;
      }
    }
    if (!isOwnedFileUrl(resumeUrl, slotId) || (portfolioUrl && !isOwnedFileUrl(portfolioUrl, slotId))) {
      res.status(400).json({ ok: false, error: '유효하지 않은 파일 URL이에요. 파일을 다시 첨부해주세요.' });
      return;
    }

    const cancelToken = crypto.randomBytes(24).toString('hex');
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
          cancel_token: cancelToken,
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

    // 예약 자체는 여기서 이미 끝났다. Jira 생성·AI 분석·메일 발송(담당자/후보자)은
    // 후보자를 더 기다리게 하지 않도록 응답을 먼저 보내고 나서 백그라운드로 처리한다.
    res.status(200).json({ ok: true, slot });
    waitUntil(processBookingSideEffects(slotId, slot, candidate, cancelToken));
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};

async function processBookingSideEffects(slotId, slot, candidate, cancelToken) {
  let jiraIssueKey = null;
  try {
    const jiraIssue = await createJiraInterviewIssue(slot, candidate);
    jiraIssueKey = jiraIssue.key;
    await saveSlotMeta(slotId, { jira_issue_key: jiraIssueKey }).catch(() => {});
  } catch (err) {
    console.error('jira create failed:', err);
  }

  let analysis = null;
  try {
    analysis = await analyzeCandidateDocuments(candidate);
  } catch (err) {
    console.error('resume analysis failed:', err);
  }

  try {
    await sendBookingNotificationEmail(slot, candidate, analysis, jiraIssueKey);
  } catch (err) {
    console.error('admin notification email failed:', err);
  }

  try {
    await sendCandidateConfirmationEmail(slot, candidate, cancelToken);
  } catch (err) {
    console.error('candidate confirmation email failed:', err);
  }
}
