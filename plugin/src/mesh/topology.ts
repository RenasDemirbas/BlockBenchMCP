// Mesh connectivity helpers shared by deformers, weight smoothing and falloff.

/** Edge neighbours of every vertex. */
export function vertexNeighbours(mesh: any): Map<string, Set<string>> {
  const nb = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!nb.has(a)) nb.set(a, new Set());
    nb.get(a)!.add(b);
  };
  for (const fkey in mesh.faces) {
    const vs: string[] = mesh.faces[fkey].getSortedVertices();
    vs.forEach((k, i) => {
      const n = vs[(i + 1) % vs.length];
      link(k, n); link(n, k);
    });
  }
  return nb;
}
