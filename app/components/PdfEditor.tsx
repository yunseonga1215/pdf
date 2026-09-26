'use client';

import { PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type InkStroke = { color: string; size: number; points: Array<[number, number]> };
export type PdfMarkup = { notes: Record<number, string>; strokes: Record<number, InkStroke[]> };

type Props = {
  file: File;
  fileId: string;
  loadMarkup: (fileId: string) => Promise<PdfMarkup>;
  saveMarkup: (fileId: string, markup: PdfMarkup) => Promise<void>;
  onClose: () => void;
};

const blankMarkup = (): PdfMarkup => ({ notes: {}, strokes: {} });
const INK_COLORS = ['#202820', '#d94f46', '#3367c7', '#e09b23', '#7b4bb5'];

export default function PdfEditor({ file, fileId, loadMarkup, saveMarkup, onClose }: Props) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [markup, setMarkup] = useState<PdfMarkup>(blankMarkup);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [penColor, setPenColor] = useState(INK_COLORS[0]);
  const [penSize, setPenSize] = useState(0.004);
  const [penEnabled, setPenEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveLabel, setSaveLabel] = useState('불러오는 중');
  const [exporting, setExporting] = useState(false);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: { destroy: () => Promise<void>; promise: Promise<PDFDocumentProxy> } | null = null;
    async function loadDocument() {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const bytes = new Uint8Array(await file.arrayBuffer());
        loadingTask = pdfjs.getDocument({ data: bytes });
        const [pdf, savedMarkup] = await Promise.all([loadingTask.promise, loadMarkup(fileId)]);
        if (cancelled) return;
        setDocument(pdf);
        setPageCount(pdf.numPages);
        setMarkup({ ...blankMarkup(), ...savedMarkup });
        loadedRef.current = true;
        setLoading(false);
        setSaveLabel('자동 저장됨');
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'PDF를 열지 못했어요.');
          setLoading(false);
        }
      }
    }
    void loadDocument();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [file, fileId, loadMarkup]);

  useEffect(() => {
    if (!document || !pdfCanvasRef.current || !inkCanvasRef.current || !canvasWrapRef.current) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    async function renderPage() {
      try {
        const page = await document!.getPage(pageNumber);
        const unitViewport = page.getViewport({ scale: 1 });
        const availableWidth = canvasWrapRef.current?.clientWidth || unitViewport.width;
        const scale = Math.min(availableWidth / unitViewport.width, 1.8);
        const viewport = page.getViewport({ scale });
        const density = Math.min(window.devicePixelRatio || 1, 2);
        const pdfCanvas = pdfCanvasRef.current!;
        const inkCanvas = inkCanvasRef.current!;
        pdfCanvas.width = Math.ceil(viewport.width * density);
        pdfCanvas.height = Math.ceil(viewport.height * density);
        pdfCanvas.style.width = `${viewport.width}px`;
        pdfCanvas.style.height = `${viewport.height}px`;
        inkCanvas.width = pdfCanvas.width;
        inkCanvas.height = pdfCanvas.height;
        inkCanvas.style.width = pdfCanvas.style.width;
        inkCanvas.style.height = pdfCanvas.style.height;
        const context = pdfCanvas.getContext('2d');
        if (!context) throw new Error('페이지 캔버스를 만들지 못했어요.');
        renderTask = page.render({ canvas: pdfCanvas, canvasContext: context, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
        await renderTask.promise;
        if (!cancelled) setSaveLabel((current) => current === '저장 중…' ? current : '자동 저장됨');
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '페이지를 표시하지 못했어요.');
      }
    }
    void renderPage();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [document, pageNumber]);

  useEffect(() => {
    const canvas = inkCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const stroke of markup.strokes[pageNumber] || []) {
      if (!stroke.points.length) continue;
      context.beginPath();
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = Math.max(stroke.size * canvas.width, 2);
      const [firstX, firstY] = stroke.points[0];
      context.moveTo(firstX * canvas.width, firstY * canvas.height);
      if (stroke.points.length === 1) {
        context.lineTo(firstX * canvas.width + 0.01, firstY * canvas.height + 0.01);
      } else {
        stroke.points.slice(1).forEach(([x, y]) => context.lineTo(x * canvas.width, y * canvas.height));
      }
      context.stroke();
    }
  }, [markup.strokes, pageNumber, document]);

  useEffect(() => {
    if (!loadedRef.current) return;
    setSaveLabel('저장 중…');
    const timer = window.setTimeout(() => {
      void saveMarkup(fileId, markup).then(() => setSaveLabel('자동 저장됨')).catch(() => setSaveLabel('저장 실패 · 다시 입력해 보세요'));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [markup, fileId, saveMarkup]);

  const getNormalizedPoint = (event: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
  };

  const startStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!penEnabled || !document) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: InkStroke = { color: penColor, size: penSize, points: [getNormalizedPoint(event)] };
    setMarkup((current) => ({ ...current, strokes: { ...current.strokes, [pageNumber]: [...(current.strokes[pageNumber] || []), stroke] } }));
  };

  const continueStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!penEnabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    const point = getNormalizedPoint(event);
    setMarkup((current) => {
      const pageStrokes = [...(current.strokes[pageNumber] || [])];
      const last = pageStrokes[pageStrokes.length - 1];
      if (!last) return current;
      pageStrokes[pageStrokes.length - 1] = { ...last, points: [...last.points, point] };
      return { ...current, strokes: { ...current.strokes, [pageNumber]: pageStrokes } };
    });
  };

  const undoStroke = () => setMarkup((current) => ({
    ...current,
    strokes: { ...current.strokes, [pageNumber]: (current.strokes[pageNumber] || []).slice(0, -1) },
  }));

  const exportAnnotatedPdf = async () => {
    if (!document) return;
    setExporting(true);
    try {
      const { PDFDocument, rgb } = await import('pdf-lib');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const output = await PDFDocument.load(bytes);
      const pages = output.getPages();
      for (const [index, page] of pages.entries()) {
        const strokes = markup.strokes[index + 1] || [];
        const pageWidth = page.getWidth();
        const pageHeight = page.getHeight();
        for (const stroke of strokes) {
          const colorHex = stroke.color.replace('#', '');
          const color = rgb(parseInt(colorHex.slice(0, 2), 16) / 255, parseInt(colorHex.slice(2, 4), 16) / 255, parseInt(colorHex.slice(4, 6), 16) / 255);
          const thickness = Math.max(stroke.size * pageWidth, 1.2);
          if (stroke.points.length === 1) {
            const [x, y] = stroke.points[0];
            page.drawCircle({ x: x * pageWidth, y: (1 - y) * pageHeight, size: thickness / 2, color });
          }
          for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex++) {
            const [startX, startY] = stroke.points[pointIndex - 1];
            const [endX, endY] = stroke.points[pointIndex];
            page.drawLine({ start: { x: startX * pageWidth, y: (1 - startY) * pageHeight }, end: { x: endX * pageWidth, y: (1 - endY) * pageHeight }, thickness, color, opacity: 0.92 });
          }
        }
        const note = markup.notes[index + 1]?.trim();
        if (note) {
          const noteCanvas = window.document.createElement('canvas');
          noteCanvas.width = 1200;
          const noteContext = noteCanvas.getContext('2d');
          if (noteContext) {
            noteContext.font = '26px "Noto Sans KR", sans-serif';
            const lines: string[] = [];
            note.slice(0, 300).split('\n').forEach((paragraph) => {
              let line = '';
              for (const character of paragraph) {
                const candidate = line + character;
                if (line && noteContext.measureText(candidate).width > 1120) { lines.push(line); line = character; }
                else line = candidate;
              }
              lines.push(line);
            });
            const lineHeight = 36;
            const clippedLines = lines.slice(0, 8);
            noteCanvas.height = clippedLines.length * lineHeight + 34;
            noteContext.fillStyle = '#fff8df';
            noteContext.fillRect(0, 0, noteCanvas.width, noteCanvas.height);
            noteContext.fillStyle = '#4b4b3f';
            noteContext.font = '26px "Noto Sans KR", sans-serif';
            noteContext.textBaseline = 'top';
            clippedLines.forEach((line, lineIndex) => noteContext.fillText(line, 24, 17 + lineIndex * lineHeight));
            const encoded = noteCanvas.toDataURL('image/png').split(',')[1];
            const pngBytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
            const noteImage = await output.embedPng(pngBytes);
            const noteHeight = Math.min(noteCanvas.height * (pageWidth - 56) / noteCanvas.width, pageHeight - 24);
            page.drawImage(noteImage, { x: 28, y: Math.max(12, pageHeight - noteHeight - 20), width: pageWidth - 56, height: noteHeight });
          }
        }
      }
      const result = await output.save();
      const blobBytes = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([blobBytes], { type: 'application/pdf' }));
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${file.name.replace(/\.pdf$/i, '')}-필기본.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setError(cause instanceof Error ? `PDF를 내보내지 못했어요: ${cause.message}` : 'PDF를 내보내지 못했어요.');
    } finally {
      setExporting(false);
    }
  };

  const closeEditor = async () => {
    if (loadedRef.current) {
      setSaveLabel('저장 중…');
      try { await saveMarkup(fileId, markup); } catch { setSaveLabel('저장 실패'); return; }
    }
    onClose();
  };

  const currentPageStrokes = markup.strokes[pageNumber] || [];
  const currentNote = markup.notes[pageNumber] || '';

  return <div className="pdf-editor-backdrop">
    <section className="pdf-editor" role="dialog" aria-modal="true" aria-label={`${file.name} PDF 편집`}>
      <header className="pdf-editor-header"><div className="pdf-title"><strong title={file.name}>{file.name}</strong><span className={`autosave-status ${saveLabel.includes('실패') ? 'save-error' : ''}`}><i />{saveLabel}</span></div><button className="pdf-close" onClick={() => void closeEditor()} aria-label="편집 닫기">×</button></header>
      <div className="pdf-toolbar">
        <div className="page-controls"><button onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber <= 1 || loading}>‹</button><span>{pageNumber} / {pageCount || '—'}</span><button onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))} disabled={pageNumber >= pageCount || loading}>›</button></div>
        <div className="ink-tools"><button className={`tool-button ${penEnabled ? 'tool-active' : ''}`} onClick={() => setPenEnabled((enabled) => !enabled)} aria-pressed={penEnabled}><span className="pen-symbol">✎</span><span>필기</span></button><div className="ink-colors" aria-label="펜 색상">{INK_COLORS.map((color) => <button key={color} aria-label={`펜 색상 ${color}`} aria-pressed={penColor === color} className={penColor === color ? 'color-selected' : ''} style={{ '--ink-color': color } as React.CSSProperties} onClick={() => setPenColor(color)} />)}</div><select value={penSize} onChange={(event) => setPenSize(Number(event.target.value))} aria-label="펜 두께"><option value={0.0025}>얇게</option><option value={0.004}>보통</option><option value={0.007}>굵게</option></select><button className="undo-button" onClick={undoStroke} disabled={!currentPageStrokes.length}>되돌리기</button></div>
      </div>
      <div className="pdf-main">
        <div className="pdf-canvas-scroller" ref={canvasWrapRef}>
          {loading && <div className="pdf-loading"><span className="spinner" /> PDF 여는 중...</div>}
          {error && <div className="pdf-error">{error}</div>}
          <div className="pdf-page-shell" style={{ display: loading || error ? 'none' : 'block' }}>
            <canvas ref={pdfCanvasRef} className="pdf-page-canvas" />
            <canvas ref={inkCanvasRef} className={`ink-canvas ${penEnabled ? 'ink-enabled' : ''}`} onPointerDown={startStroke} onPointerMove={continueStroke} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
          </div>
        </div>
        <aside className="pdf-notes"><div className="notes-heading"><strong>페이지 메모</strong><span>현재 페이지에 자동 저장</span></div><textarea value={currentNote} onChange={(event) => setMarkup((current) => ({ ...current, notes: { ...current.notes, [pageNumber]: event.target.value } }))} placeholder="이 페이지의 메모를 적어 보세요…" /><div className="notes-bottom"><span>{currentPageStrokes.length}개 필기</span><button onClick={() => void exportAnnotatedPdf()} disabled={loading || exporting}>{exporting ? 'PDF 만드는 중…' : '필기 포함 PDF 저장'}</button></div></aside>
      </div>
    </section>
  </div>;
}
