/** Syntax highlighting preserves the exact configuration text. */
export function NativeConfigPreview({ content }: { content: string }) {
  const tokens = content.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|#[^\n]*|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b|^[\w-]+(?=:))/gm);
  return <pre tabIndex={0} aria-label="配置预览" className="code-preview max-h-[60svh] overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"><code>{tokens.map((token, index) => {
    const color = /^".*:\s*$/.test(token) ? "text-blue-700 dark:text-blue-300" : token.startsWith('"') ? "text-emerald-700 dark:text-emerald-300" : token.startsWith("#") ? "text-muted-foreground" : /^(true|false|null|-?\d+(\.\d+)?)$/.test(token) ? "text-violet-700 dark:text-violet-300" : "";
    return <span key={index} className={color}>{token}</span>;
  })}</code></pre>;
}
