# RoomRelay agent instructions

Read `agent_handoff.md` and `build_status.md` first. This starts as a documentation-only repository. Scope and invariants are in `docs/PRD.md`; read specialized documents for your task instead of loading the entire spec into a small context window.

## Implementation rules

- Claim a task in `build_status.md` when implementation is requested. Update it with actual evidence, commit, checks and next step; do not present plans/mocks as implemented integrations.
- Fetch current documentation with Context7 before library, SDK, API, CLI or cloud-specific implementation: resolve the library ID first, select the relevant primary match, then query. If no relevant result exists, use current primary vendor docs and record the fallback.
- Prefix shell commands with `rtk`. For unsupported filtering, use `rtk proxy <command>`. On Windows, use native PowerShell or Python through `rtk proxy` if Unix utilities are unavailable; do not repeatedly invoke unavailable `ls`/Unix tools.
- Keep file operations inside the intended checkout, inspect Git state before changes, and never recursively move/delete computed Windows paths without confirming the absolute target. Avoid nested-shell interpolation of private values.
- Prefer the smallest complete vertical slice. Preserve callers, validation, error handling, accessibility, privacy and financial/spatial correctness. Nontrivial money, geometry, security and pipeline logic needs meaningful tests.
- Do not commit real credentials, raw/private captures or exact addresses. Add only consented/licensed public assets using a narrow allowlist; configuration templates contain placeholders.
- Detection boxes, rendered images and model text are not metric fit evidence. PayPal browser approval is not capture confirmation. Preserve these invariants even in a demo.
- Sandbox is the default. Live money, public private-media publication and production marketplace operation require their documented gates and explicit scope.
- Use stable PRD/task/test IDs in updates. Resolve spec contradictions explicitly and update canonical contracts rather than creating competing notes.

No application has been built merely because these instructions or planned directories exist.
