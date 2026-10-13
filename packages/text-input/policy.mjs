import { createHash } from 'node:crypto';
import { fields, identifier, requireThat, string } from '../bridge-core/lib/errors.mjs';
export const VERSION = 1;
export const PROTOCOLS = ['rdp', 'rustdesk', 'vnc', 'moonlight'];
export const fingerprint = value => createHash('sha256').update(value).digest('hex');
export function binding(value) {
  fields(value, ['id', 'protocol', 'connectionKey', 'desktopId', 'displayId', 'frame', 'captureKind', 'outputFrame', 'protocolSessionId', 'captureConfirmed'],
    ['id', 'protocol', 'connectionKey', 'desktopId', 'displayId', 'frame', 'captureKind', 'outputFrame', 'protocolSessionId', 'captureConfirmed']);
  identifier(value.id); requireThat(PROTOCOLS.includes(value.protocol), 'PROTOCOL_UNSUPPORTED');
  string(value.connectionKey, 64, /^[a-f0-9]{64}$/); string(value.desktopId, 160, /^[a-zA-Z0-9:._-]+$/);
  requireThat(Number.isSafeInteger(value.displayId) && value.displayId >= 0, 'DISPLAY_INVALID');
  fields(value.frame, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height']);
  requireThat(Object.values(value.frame).every(Number.isFinite) && value.frame.width > 0 && value.frame.height > 0 &&
    value.frame.width <= 32768 && value.frame.height <= 32768 &&
    Math.abs(value.frame.x) <= 65536 && Math.abs(value.frame.y) <= 65536, 'FRAME_INVALID');
  requireThat(typeof value.protocolSessionId === 'string' && (value.protocol === 'rdp' ? /^rdp:[0-9]{1,10}$/.test(value.protocolSessionId) : value.protocolSessionId === ''), 'PROTOCOL_SESSION_INVALID');
  requireThat(['monitor', 'desktop'].includes(value.captureKind), 'CAPTURE_KIND_UNSUPPORTED');
  fields(value.outputFrame, ['width', 'height'], ['width', 'height']);
  requireThat(Object.values(value.outputFrame).every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768) &&
    Math.abs(value.frame.width / value.frame.height - value.outputFrame.width / value.outputFrame.height) < 0.005, 'OUTPUT_FRAME_INVALID');
  requireThat(value.captureConfirmed === true, 'CAPTURE_ENROLLMENT_REQUIRED');
  return structuredClone(value);
}
export function rectangle(value, frame, outputFrame = frame) {
  if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite) ||
    value.width < 0 || value.height <= 0 || value.width > 32768 || value.height > 32768) return null;
  const x = Math.max(frame.x, value.x), y = Math.max(frame.y, value.y);
  const right = Math.min(frame.x + frame.width, value.x + Math.max(1, value.width));
  const bottom = Math.min(frame.y + frame.height, value.y + value.height);
  if (right <= x || bottom <= y) return null;
  const sx = outputFrame.width / frame.width, sy = outputFrame.height / frame.height;
  const px = (x - frame.x) * sx, py = (y - frame.y) * sy;
  return { x: px, y: py, width: Math.min(outputFrame.width - px, Math.max(1, (right - x) * sx)), height: (bottom - y) * sy };
}
export function metadata(raw, enrolled, salt) {
  const unavailable = reason => ({ available: false, reason, focus: false, geometry: false, target: null });
  if (!raw || raw.available !== true) return unavailable(['denied', 'unsupported', 'locked', 'unavailable'].includes(raw?.reason) ? raw.reason : 'unavailable');
  if (enrolled.protocol === 'rdp' && (!Number.isSafeInteger(raw.rdpSessionId) || 'rdp:' + raw.rdpSessionId !== enrolled.protocolSessionId)) return unavailable('protocol-session-mismatch');
  // Provider must run in the actual captured desktop. Client requests cannot supply or upgrade this assertion.
  if (raw.desktopId !== enrolled.desktopId || raw.coordinateUnit !== 'physicalPx') return unavailable('desktop-mismatch');
  const sameRect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]) && Math.abs(r[k] - enrolled.frame[k]) < 0.001);
  if (enrolled.captureKind === 'monitor' ? !Array.isArray(raw.captureRects) || raw.captureRects.length > 32 || !raw.captureRects.some(sameRect) :
    !sameRect(raw.desktopRect)) return unavailable('capture-mismatch');
  if (raw.displayId !== undefined && raw.displayId !== enrolled.displayId) return unavailable('display-mismatch');
  if (raw.focusKind === 'unknown') return unavailable('unsupported-control');
  if (!raw.editable || raw.readOnly || !raw.enabled || !raw.visible) {
    return { available: true, reason: 'no-editable-focus', focus: true, geometry: false, target: null };
  }
  if (typeof raw.focusToken !== 'string' || raw.focusToken.length === 0 || raw.focusToken.length > 512) return unavailable('unavailable');
  const controlRect = rectangle(raw.controlRect, enrolled.frame, enrolled.outputFrame), caretRect = rectangle(raw.caretRect, enrolled.frame, enrolled.outputFrame);
  if (!controlRect && !caretRect) return unavailable('outside-capture');
  return { available: true, reason: 'ready', focus: true, geometry: true, target: {
    focusToken: fingerprint(salt + ':' + raw.focusToken), editable: true, readOnly: false, enabled: true, visible: true,
    inputKind: raw.inputKind === 'password' ? 'password' : 'text', controlRect, caretRect
  } };
}
