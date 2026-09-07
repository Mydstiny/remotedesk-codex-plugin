export class Fault extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const requireThat = (condition, code = 'INVALID_REQUEST') => {
  if (!condition) throw new Fault(code);
};
export const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function fields(value, allowed, required = []) {
  requireThat(
    object(value) &&
      Object.keys(value).every((k) => allowed.includes(k)) &&
      required.every((k) => Object.hasOwn(value, k)),
  );
}
export function string(value, max = 200, pattern) {
  requireThat(
    typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value) <= max &&
      (!pattern || pattern.test(value)),
  );
  return value;
}
export const identifier = (value) => string(value, 100, /^[A-Za-z0-9_-]+$/);
