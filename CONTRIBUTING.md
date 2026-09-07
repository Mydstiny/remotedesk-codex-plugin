# Contributing

Use one task branch and an independently reviewed PR. Run npm test, syntax checks, npm pack and the fixed native runtime/wire tests. CI uses Windows/macOS/Linux and Node 22/24/26; model fixtures use only isolated local responses. Do not use user credentials or unrelated sessions as test fixtures.

Native lifecycle or permission changes require regression coverage for cancellation, ownership, authorization changes and unknown outcomes. Update compatibility, protocol, provenance and notices when upstream contracts or bundled dependencies change. Never infer device acceptance from code or fixture tests.
