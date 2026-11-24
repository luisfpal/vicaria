import { useEffect, useRef, useState } from "preact/hooks";
import { image } from "../core/read";

const urls = new Map<string, Promise<string | null>>();
export function imageUrl(book: string, path: string): Promise<string | null> {
  const k = book + "|" + path;
  if (!urls.has(k)) urls.set(k, image(book, path).then(b => (b ? URL.createObjectURL(b) : null)).catch(() => null));
  return urls.get(k)!;
}

const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

export function Cover(p: { id?: string; cover?: string | null; title: string; author: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!p.id || !p.cover || !ref.current) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); imageUrl(p.id!, p.cover!).then(setSrc); } }, { rootMargin: "400px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [p.id, p.cover]);
  return (
    <div ref={ref} class="cover" aria-hidden="true" style={{ background: `hsl(${hue(p.title + p.author)} 28% 32%)` }}>
      <strong>{p.title}</strong><em>{p.author}</em>
      {src && <img src={src} alt="" onLoad={e => (e.target as HTMLImageElement).classList.add("ok")} />}
    </div>
  );
}
