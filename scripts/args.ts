/** Tiny `--key value` / `--flag` argument parser for the scripts. */
export function parseArgs(argv: string[] = process.argv.slice(2)): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out.set(key, "true");
    else {
      out.set(key, next);
      i++;
    }
  }
  return out;
}

export const numArg = (args: Map<string, string>, key: string, fallback: number): number => {
  const v = args.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
};
