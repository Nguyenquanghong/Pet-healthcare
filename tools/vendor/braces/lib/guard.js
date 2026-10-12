'use strict';
// Local P6 guard; upstream 3.0.3 has no released fix for GHSA-vfj7-8cjw-p6xm.
// Validate without recursion before entering any recursive AST walker.
const fail = () => { throw new SyntaxError('Brace nesting exceeds the supported build limit'); };
const guard = ast => {
  const pending = [{node: ast, depth: 0}]; const visited = new WeakSet(); let count = 0;
  while (pending.length) {
    const {node, depth} = pending.pop();
    if (depth > 64 || ++count > 100000) fail();
    if (!node || typeof node !== 'object') continue;
    if (visited.has(node)) fail(); visited.add(node);
    if (node.nodes) {
      if (!Array.isArray(node.nodes)) fail();
      for (const child of node.nodes) pending.push({node: child, depth: depth + 1});
    }
  }
};
guard.pattern = input => {
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\\') { i++; continue; }
    if (input[i] === '{' && ++depth > 62) fail();
    if (input[i] === '}') depth = Math.max(0, depth - 1);
  }
};
module.exports = guard;
