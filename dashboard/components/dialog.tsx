"use client";
import { useEffect, useRef, useId } from "react";
import Icon from "./icons";
export default function Dialog({ title, subtitle, children, onClose, wide = false, busy = false }: { title: string; subtitle?: string; children: React.ReactNode; onClose: () => void; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? "modal-wide" : ""}`} aria-labelledby={heading} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal-content"><div className="modal-head"><div><p className="eyebrow">FIELDLINK / MANAGEMENT</p><h2 id={heading}>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div><button type="button" className="icon-button" aria-label="창 닫기" onClick={onClose} disabled={busy}><Icon name="x"/></button></div>{children}</div>
  </dialog>;
}
