// 메트로놈과 마이크가 함께 쓰는 AudioContext 하나
let ctx = null;
let recording = false;

function setSession() {
  // 아이패드 오디오 세션: 마이크를 쓰는 동안은 play-and-record, 아니면 무음 모드에서도 소리 나는 playback (사파리 17+)
  try { if (navigator.audioSession) navigator.audioSession.type = recording ? 'play-and-record' : 'playback'; } catch (e) { /* 무시 */ }
}

/**
 * create=false: 없으면 만들지 않음
 * record=true/false: 마이크를 쓰기 시작·끝낼 때
 */
export function audioContext({ create = true, record } = {}) {
  if (record !== undefined && record !== recording) { recording = record; setSession(); }
  if (!ctx && create) {
    const AC = window.AudioContext || window.webkitAudioContext;
    setSession();
    ctx = new AC();
  }
  if (ctx && create && ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
}
