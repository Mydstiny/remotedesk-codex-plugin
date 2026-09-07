import { fields, string, requireThat, Fault } from './errors.mjs';
export const workspaceTools = [
  {
    name: 'remotedesk_workspace_exec',
    description:
      'Run one shell command in /workspace in a project container. The controller must approve it once. Network and host files outside this project are inaccessible.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'remotedesk_workspace_read',
    description:
      'Read a UTF-8 file relative to /workspace inside a read-only project container, at most 128 KiB.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'remotedesk_question',
    description: 'Ask the paired controller a non-secret question.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
];
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function executeWorkspaceTool({
  executor,
  core,
  session,
  project,
  name,
  args,
  signal,
}) {
  if (name === 'remotedesk_workspace_exec') {
    fields(args, ['command'], ['command']);
    string(args.command, 64000);
    const answer = await core.ask(
      session.id,
      {
        kind: 'command',
        command: args.command,
        cwd: '/workspace',
        scope: 'Docker container; project read/write; no network; one command',
      },
      signal,
    );
    requireThat(answer.decision === 'accept', 'COMMAND_DENIED');
    return executor.run(project, args.command, { signal });
  }
  if (name === 'remotedesk_workspace_read') {
    fields(args, ['path'], ['path']);
    string(args.path, 1000);
    requireThat(!args.path.includes('\0'), 'PATH_INVALID');
    const program = `const fs=require('fs'),p=require('path');const f=p.resolve('/workspace',process.argv[1]);if(f!=='/workspace'&&!f.startsWith('/workspace/'))process.exit(13);const b=fs.readFileSync(f);if(b.length>131072)process.exit(14);process.stdout.write(b);`;
    return executor.run(project, ['node', '-e', program, args.path].map(quote).join(' '), {
      signal,
      readOnly: true,
    });
  }
  if (name === 'remotedesk_question') {
    fields(args, ['question'], ['question']);
    string(args.question, 4000);
    return core.ask(
      session.id,
      { kind: 'question', question: args.question, secret: false },
      signal,
    );
  }
  throw new Fault('TOOL_NOT_ALLOWED');
}
export function validateWorkspaceAnswer(request, answer) {
  if (request.kind === 'question') {
    fields(answer, ['text'], ['text']);
    string(answer.text, 16000);
  } else {
    fields(answer, ['decision'], ['decision']);
    requireThat(['accept', 'decline', 'cancel'].includes(answer.decision), 'APPROVAL_DECISION');
  }
}
export const projectDiff = (executor, project) =>
  executor.run(
    project,
    'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv --ignore-submodules=all -- .',
    { readOnly: true },
  );
