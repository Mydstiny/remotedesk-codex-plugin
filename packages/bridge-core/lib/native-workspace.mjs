// Native commands inherit ordinary OS paths, not ambient credentials or
// executable/configuration injection variables. Provider authentication stays
// in the host's native engine process and is not copied into command tools.
export function nativeEnvironment() {
  const allowed = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => allowed.has(k.toUpperCase())),
  );
}
