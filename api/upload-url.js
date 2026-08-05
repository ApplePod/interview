// 후보자가 이력서/포트폴리오를 Supabase Storage에 "직접" 업로드할 수 있도록
// 서명된 업로드 URL을 발급해준다. 파일 자체는 Vercel 함수를 거치지 않고
// 브라우저 → Supabase로 바로 전송되므로, 서버리스 함수의 요청 크기 제한(수 MB)에
// 걸리지 않는다.

const SUPABASE_URL = 'https://lnvaqdfhsewihveemhbm.supabase.co';
const STORAGE_BUCKET = 'resumes';
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function safeFilename(filename) {
  return String(filename || 'file').replace(/[^\w.\-가-힣]/g, '_').slice(-120);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  try {
    const { slotId, kind, filename, size } = req.body || {};
    if (!slotId || !kind || !filename || (kind !== 'resume' && kind !== 'portfolio')) {
      res.status(400).json({ ok: false, error: 'slotId, kind(resume|portfolio), filename이 필요해요.' });
      return;
    }
    // 클라이언트가 보낸 값이라 완전한 방어선은 아니지만(속여서 보낼 수 있음), 정상적인
    // 클라이언트가 실수로 크기 제한을 우회하는 경우는 여기서 바로 걸러진다.
    // 진짜 방어선은 Supabase Storage 버킷 자체의 파일 크기 제한이다.
    if (typeof size === 'number' && size > MAX_FILE_BYTES) {
      res.status(413).json({ ok: false, error: '파일은 10MB 이하로 올려주세요.' });
      return;
    }

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // 존재하지 않거나 이미 예약된 슬롯 앞으로 업로드 URL을 발급해주지 않는다
    // (임의 slotId로 스토리지에 파일을 계속 올리는 남용을 막기 위함)
    const slotCheckResp = await fetch(
      `${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${encodeURIComponent(slotId)}&is_booked=eq.false&select=id`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!slotCheckResp.ok) {
      res.status(502).json({ ok: false, error: `슬롯 확인 실패: ${slotCheckResp.status} ${await slotCheckResp.text()}` });
      return;
    }
    const slotCheckData = await slotCheckResp.json();
    if (!slotCheckData || slotCheckData.length === 0) {
      res.status(404).json({ ok: false, error: '존재하지 않거나 이미 예약된 슬롯이에요.' });
      return;
    }

    const path = `${slotId}/${kind}-${Date.now()}-${safeFilename(filename)}`;

    const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${STORAGE_BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!resp.ok) {
      res.status(502).json({ ok: false, error: `signed url 발급 실패: ${resp.status} ${await resp.text()}` });
      return;
    }

    const { url } = await resp.json();
    res.status(200).json({
      ok: true,
      uploadUrl: `${SUPABASE_URL}/storage/v1${url}`,
      publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
