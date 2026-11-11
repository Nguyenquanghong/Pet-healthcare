# Local build dependency guard

Base: upstream braces 3.0.3 from the existing lockfile. Original JS and LICENSE
are preserved, except for guard calls in parse/compile/expand/stringify.
[Advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) lists no published
patch. This local version is not an upstream release or a claim that npm's
advisory database has changed.

Reject pattern nesting above 62 and AST depth above 64, cycles/shared node graphs
and traversals above 100,000 nodes, using an iterative validator before recursive
walkers. This intentionally restricts excessive build glob patterns. The normal
Tailwind/build patterns and the regression suite must still pass. Do not process
untrusted ASTs/patterns as an application feature. Replace this override with a
reviewed upstream fix when one exists.
