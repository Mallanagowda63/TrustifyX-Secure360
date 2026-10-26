import type { ReactNode } from "react";

/** Inline **bold** and `code`; everything else is plain text (no HTML is ever injected). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith("**") ? (
        <strong key={i++} className="text-ink">
          {tok.slice(2, -2)}
        </strong>
      ) : (
        <code key={i++} className="rounded bg-navy-950 px-1 py-0.5 text-[0.85em]">
          {tok.slice(1, -1)}
        </code>
      ),
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Minimal Markdown-ish renderer for AI answers: headings, bullet/numbered lists, code blocks, paragraphs. */
export function AiText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let para: string[] = [];
  let k = 0;

  const flushPara = () => {
    if (para.length) blocks.push(<p key={k++}>{inline(para.join(" "))}</p>);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, j) => <li key={j}>{inline(it)}</li>);
      blocks.push(list.ordered ? <ol key={k++} className="list-decimal space-y-1 pl-5">{items}</ol> : <ul key={k++} className="list-disc space-y-1 pl-5">{items}</ul>);
    }
    list = null;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (code) {
        blocks.push(
          <pre key={k++} className="overflow-x-auto rounded-md border border-navy-700 bg-navy-950 p-3 text-xs">
            {code.join("\n")}
          </pre>,
        );
        code = null;
      } else {
        flushPara();
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) {
      flushPara();
      flushList();
      blocks.push(<h4 key={k++} className="mt-1 font-semibold text-ink">{inline(h[1])}</h4>);
    } else if (bullet || num) {
      flushPara();
      const ordered = Boolean(num);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? num)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  if (code) blocks.push(<pre key={k++} className="overflow-x-auto rounded-md bg-navy-950 p-3 text-xs">{(code as string[]).join("\n")}</pre>);
  flushPara();
  flushList();
  return <div className="space-y-2 text-sm leading-relaxed text-ink-muted">{blocks}</div>;
}
