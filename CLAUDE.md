@AGENTS.md

<!-- ahrena:framework:start -->
The Ahrena Framework index lives in AGENTS.md, imported elsewhere in this file.
<!-- ahrena:framework:end -->

<!-- ahrena:agency:start -->
## Build work enters through the agency

Build work enters through the `athena` agent. She plans the issue, routes the
concern, and delegates each layer to `iris` (frontend), `apollo` (backend) or
`clio` (data), running the develop→Argos loop (at most three rounds) before each
stacked pull request. Do not implement build work directly — delegate to the
agency. Athena orchestrates; she does not write production code, pass a review
verdict, or apply a fix.
<!-- ahrena:agency:end -->
