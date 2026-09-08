// CommandLineToArgvW-compatible quoting, without cmd.exe or PowerShell evaluation.
export function quoteWindows(arg) {
  return (
    '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '"'
  );
}
