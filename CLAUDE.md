@AGENTS.md

<!-- ahrena:framework:start -->
The Ahrena Framework index lives in AGENTS.md, imported elsewhere in this file.
<!-- ahrena:framework:end -->

<!-- ahrena:agency:start -->
## Build work enters through the agency

Build work enters through a session that takes the role of the `athena` agent
(`ahrena-engineering-development:athena`, opened with `/issue-tl` on Claude Code):
the session reads her definition and is the tech lead of the issue until it ends.
She plans the issue, routes the concern, and delegates each layer to `iris`
(frontend), `apollo` (backend) or `clio` (data), running the develop→Argos loop
(at most three rounds) before each stacked pull request. Do not implement build
work directly. Where a session cannot take her role, call her as a subagent and
write what she returns for the person under `person-facing-text`, never pasting
her protocol block. Athena orchestrates; she does not write production code, pass
a review verdict, or apply a fix.
<!-- ahrena:agency:end -->
