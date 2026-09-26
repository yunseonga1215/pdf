'use client';

import { PointerEvent, RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type InkStroke = { color: string; size: number; points: Array<[number, number]> };
export type PdfMarkup = { notes: Record<number, string>; strokes: Record<number, InkStroke[]> };
type PageSize = { width: number; height: number };
type Tool = 'pen' | 'eraser';
type ViewMode = 'viewer' | 'write';

type EditorProps = {
  file: File;
  fileId: string;
  loadMarkup: (fileId: string) => Promise<PdfMarkup>;
  saveMarkup: (fileId: string, markup: PdfMarkup) => Promise<void>;
  onClose: () => void;
};

type PageProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  pageSize: PageSize;
  width: number;
  strokes: InkStroke[];
  tool: Tool;
  penColor: string;
  penSize: number;
  mode: ViewMode;
  scrollRoot: RefObject<HTMLDivElement | null>;
  onActivate: (pageNumber: number) => void;
  onDraw: (pageNumber: number, point: [number, number], begin: boolean) => void;
  onErase: (pageNumber: number, point: [number, number]) => void;
};

const blankMarkup = (): PdfMarkup => ({ notes: {}, strokes: {} });
const INK_COLORS = ['#202820', '#d94f46', '#3367c7', '#e09b23', '#7b4bb5'];

function PdfPageView({ pdf, pageNumber, pageSize, width, strokes, tool, penColor, penSize, mode, scrollRoot, onActivate, onDraw, onErase }: PageProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const height = width * pageSize.height / pageSize.width;

  useEffect(() => {
    const shell = shellRef.current;
    const root = scrollRoot.current;
    if (!shell || !root) return;
    if (!('IntersectionObserver' in window)) { setNearViewport(true); return; }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        setNearViewport(entry.isIntersecting);
      });
    }, { root, rootMargin: '900px 0px', threshold: [0, 0.55, 1] });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [pageNumber, scrollRoot, onActivate]);

  useEffect(() => {
    if (!nearViewport || !pdfCanvasRef.current || !inkCanvasRef.current) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    async function render() {
      try {
        const page = await pdf.getPage(pageNumber);
        const scale = width / pageSize.width;
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
        if (!context) throw new Error('PDF 페이지를 표시할 캔버스를 만들지 못했어요.');
        task = page.render({ canvas: pdfCanvas, canvasContext: context, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
        await task.promise;
        if (!cancelled) drawInk(inkCanvas, strokes);
      } catch (cause) {
        if (!cancelled) console.error(`PDF ${pageNumber} 페이지 렌더링 오류`, cause);
      }
    }
    const drawInk = (canvas: HTMLCanvasElement, pageStrokes: InkStroke[]) => {
      const context = canvas.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      pageStrokes.forEach((stroke) => {
        if (!stroke.points.length) return;
        context.beginPath();
        context.strokeStyle = stroke.color;
        context.fillStyle = stroke.color;
        context.lineWidth = Math.max(stroke.size * canvas.width, 2);
        const [x, y] = stroke.points[0];
        context.moveTo(x * canvas.width, y * canvas.height);
        stroke.points.slice(1).forEach(([pointX, pointY]) => context.lineTo(pointX * canvas.width, pointY * canvas.height));
        if (stroke.points.length === 1) context.lineTo(x * canvas.width + 0.01, y * canvas.height + 0.01);
        context.stroke();
      });
    };
    void render();
    return () => {
      cancelled = true;
      task?.cancel();
      if (pdfCanvasRef.current) { pdfCanvasRef.current.width = 0; pdfCanvasRef.current.height = 0; }
      if (inkCanvasRef.current) { inkCanvasRef.current.width = 0; inkCanvasRef.current.height = 0; }
    };
  }, [pdf, pageNumber, pageSize, width, nearViewport]);

  useEffect(() => {
    if (!nearViewport || !inkCanvasRef.current) return;
    const canvas = inkCanvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    strokes.forEach((stroke) => {
      if (!stroke.points.length) return;
      context.beginPath();
      context.strokeStyle = stroke.color;
      context.lineWidth = Math.max(stroke.size * canvas.width, 2);
      const [x, y] = stroke.points[0];
      context.moveTo(x * canvas.width, y * canvas.height);
      stroke.points.slice(1).forEach(([pointX, pointY]) => context.lineTo(pointX * canvas.width, pointY * canvas.height));
      if (stroke.points.length === 1) context.lineTo(x * canvas.width + 0.01, y * canvas.height + 0.01);
      context.stroke();
    });
  }, [strokes, nearViewport]);

  const pointFor = (event: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
  };
  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'write') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onActivate(pageNumber);
    const point = pointFor(event);
    if (tool === 'eraser') onErase(pageNumber, point);
    else onDraw(pageNumber, point, true);
  };
  const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'write') return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    const point = pointFor(event);
    if (tool === 'eraser') onErase(pageNumber, point);
    else onDraw(pageNumber, point, false);
  };

  return <div id={`pdf-page-${pageNumber}`} ref={shellRef} className="pdf-page-shell" style={{ width, height }} onPointerDown={() => onActivate(pageNumber)}>
    <canvas ref={pdfCanvasRef} className="pdf-page-canvas" />
    <canvas ref={inkCanvasRef} className={`ink-canvas ${mode === 'write' ? 'ink-enabled' : 'viewer-mode'} ${tool === 'eraser' && mode === 'write' ? 'eraser-enabled' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
  </div>;
}

export default function PdfEditor({ file, fileId, loadMarkup, saveMarkup, onClose }: EditorProps) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [markup, setMarkup] = useState<PdfMarkup>(blankMarkup);
  const [pageNumber, setPageNumber] = useState(1);
  const [penColor, setPenColor] = useState(INK_COLORS[0]);
  const [penSize, setPenSize] = useState(0.004);
  const [tool, setTool] = useState<Tool>('pen');
  const [viewMode, setViewMode] = useState<ViewMode>('viewer');
  const [screenLocked, setScreenLocked] = useState(false);
  const [notesVisible, setNotesVisible] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveLabel, setSaveLabel] = useState('불러오는 중');
  const [exporting, setExporting] = useState(false);
  const [viewerWidth, setViewerWidth] = useState(800);
  const scrollRef = useRef<HTMLDivElement>(null);
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
        const sizes = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
          const page = await pdf.getPage(index + 1);
          const viewport = page.getViewport({ scale: 1 });
          return { width: viewport.width, height: viewport.height };
        }));
        if (cancelled) return;
        setDocument(pdf);
        setPageSizes(sizes);
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
    return () => { cancelled = true; if (loadingTask) void loadingTask.destroy(); };
  }, [file, fileId, loadMarkup]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const update = () => setViewerWidth(Math.max(260, root.clientWidth - 24));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, [document]);

  useEffect(() => {
    if (!loadedRef.current) return;
    setSaveLabel('저장 중…');
    const timer = window.setTimeout(() => {
      void saveMarkup(fileId, markup).then(() => setSaveLabel('자동 저장됨')).catch(() => setSaveLabel('저장 실패 · 다시 입력해 보세요'));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [markup, fileId, saveMarkup]);

  const setActivePage = useCallback((nextPage: number) => setPageNumber(nextPage), []);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !document) return;
    let frame = 0;
    const updatePage = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rootBounds = root.getBoundingClientRect();
        const centerY = rootBounds.top + rootBounds.height / 2;
        let closestPage = 1;
        let closestDistance = Number.POSITIVE_INFINITY;
        root.querySelectorAll<HTMLElement>('.pdf-page-shell[id^="pdf-page-"]').forEach((page) => {
          const bounds = page.getBoundingClientRect();
          const distance = centerY < bounds.top ? bounds.top - centerY : centerY > bounds.bottom ? centerY - bounds.bottom : 0;
          if (distance < closestDistance) {
            closestDistance = distance;
            closestPage = Number(page.id.slice('pdf-page-'.length));
          }
        });
        if (closestPage >= 1 && closestPage <= pageSizes.length) setPageNumber(closestPage);
      });
    };
    root.addEventListener('scroll', updatePage, { passive: true });
    window.addEventListener('resize', updatePage);
    updatePage();
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('scroll', updatePage);
      window.removeEventListener('resize', updatePage);
    };
  }, [document, pageSizes.length]);
  const pointDistance = (left: [number, number], right: [number, number]) => Math.hypot(left[0] - right[0], left[1] - right[1]);
  const drawPoint = (targetPage: number, point: [number, number], begin: boolean) => {
    setMarkup((current) => {
      const pageStrokes = [...(current.strokes[targetPage] || [])];
      if (begin) pageStrokes.push({ color: penColor, size: penSize, points: [point] });
      else if (pageStrokes.length) {
        const last = pageStrokes[pageStrokes.length - 1];
        pageStrokes[pageStrokes.length - 1] = { ...last, points: [...last.points, point] };
      }
      return { ...current, strokes: { ...current.strokes, [targetPage]: pageStrokes } };
    });
  };
  const eraseAt = (targetPage: number, point: [number, number]) => {
    const radius = 0.018;
    setMarkup((current) => {
      const nextStrokes: InkStroke[] = [];
      (current.strokes[targetPage] || []).forEach((stroke) => {
        let segment: Array<[number, number]> = [];
        const keepSegment = () => {
          if (segment.length) nextStrokes.push({ ...stroke, points: segment });
          segment = [];
        };
        stroke.points.forEach((strokePoint) => {
          if (pointDistance(strokePoint, point) < radius) keepSegment();
          else segment.push(strokePoint);
        });
        keepSegment();
      });
      return { ...current, strokes: { ...current.strokes, [targetPage]: nextStrokes } };
    });
  };

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
          const hex = stroke.color.replace('#', '');
          const color = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
          const thickness = Math.max(stroke.size * pageWidth, 1.2);
          if (stroke.points.length === 1) {
            const [x, y] = stroke.points[0];
            page.drawCircle({ x: x * pageWidth, y: (1 - y) * pageHeight, size: thickness / 2, color });
          }
          for (let i = 1; i < stroke.points.length; i++) {
            const [x1, y1] = stroke.points[i - 1];
            const [x2, y2] = stroke.points[i];
            page.drawLine({ start: { x: x1 * pageWidth, y: (1 - y1) * pageHeight }, end: { x: x2 * pageWidth, y: (1 - y2) * pageHeight }, thickness, color, opacity: 0.92 });
          }
        }
        const note = markup.notes[index + 1]?.trim();
        if (note) {
          const canvas = window.document.createElement('canvas');
          canvas.width = 1200;
          const context = canvas.getContext('2d');
          if (context) {
            context.font = '26px "Noto Sans KR", sans-serif';
            const lines: string[] = [];
            note.slice(0, 300).split('\n').forEach((paragraph) => {
              let line = '';
              for (const character of paragraph) {
                if (line && context.measureText(line + character).width > 1120) { lines.push(line); line = character; }
                else line += character;
              }
              lines.push(line);
            });
            const shownLines = lines.slice(0, 8);
            canvas.height = shownLines.length * 36 + 34;
            context.fillStyle = '#fff8df';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#4b4b3f';
            context.textBaseline = 'top';
            context.font = '26px "Noto Sans KR", sans-serif';
            shownLines.forEach((line, lineIndex) => context.fillText(line, 24, 17 + lineIndex * 36));
            const png = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (char) => char.charCodeAt(0));
            const noteImage = await output.embedPng(png);
            const height = Math.min(canvas.height * (pageWidth - 56) / canvas.width, pageHeight - 24);
            page.drawImage(noteImage, { x: 28, y: Math.max(12, pageHeight - height - 20), width: pageWidth - 56, height });
          }
        }
      }
      const result = await output.save();
      const buffer = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${file.name.replace(/\.pdf$/i, '')}-필기본.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setError(cause instanceof Error ? `PDF를 저장하지 못했어요: ${cause.message}` : 'PDF를 저장하지 못했어요.');
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
  const pageWidth = Math.min(viewerWidth, 920);

  return <div className="pdf-editor-backdrop">
    <section className="pdf-editor" role="dialog" aria-modal="true" aria-label={`${file.name} PDF 편집`}>
      <header className="pdf-editor-header"><div className="pdf-title"><strong title={file.name}>{file.name}</strong><span className={`autosave-status ${saveLabel.includes('실패') ? 'save-error' : ''}`}><i />{saveLabel}</span></div><button className="pdf-close" onClick={() => void closeEditor()} aria-label="편집 닫기">×</button></header>
      <div className={`pdf-toolbar ${viewMode === 'write' ? 'write-mode-toolbar' : ''}`}>
        <div className="mode-switch" role="group" aria-label="문서 보기 모드"><button className={viewMode === 'viewer' ? 'mode-selected' : ''} aria-pressed={viewMode === 'viewer'} onClick={() => setViewMode('viewer')}>일반 뷰어</button><button className={viewMode === 'write' ? 'mode-selected' : ''} aria-pressed={viewMode === 'write'} onClick={() => { setViewMode('write'); setTool('pen'); }}>필기 모드</button></div>
        {viewMode === 'write' && <div className="write-tools-scroll"><div className="ink-tools"><button className={`tool-button eraser-tool ${tool === 'eraser' ? 'tool-active' : ''}`} onClick={() => setTool('eraser')} aria-pressed={tool === 'eraser'}><span>▱</span><span>지우개</span></button><div className="ink-colors" aria-label="펜 색상">{INK_COLORS.map((color) => <button key={color} aria-label={`펜 색상 ${color}`} aria-pressed={penColor === color} className={penColor === color ? 'color-selected' : ''} style={{ '--ink-color': color } as React.CSSProperties} onClick={() => { setPenColor(color); setTool('pen'); }} />)}</div><select value={penSize} onChange={(event) => { setPenSize(Number(event.target.value)); setTool('pen'); }} aria-label="펜 두께"><option value={0.0025}>얇게</option><option value={0.004}>보통</option><option value={0.007}>굵게</option></select><button className={`tool-button screen-lock-button ${screenLocked ? 'tool-active' : ''}`} onClick={() => setScreenLocked((current) => !current)} aria-pressed={screenLocked}><span>{screenLocked ? '🔒' : '🔓'}</span><span>{screenLocked ? '잠금 해제' : '화면 잠금'}</span></button></div></div>}
        <div className="toolbar-actions"><span className="page-indicator">{pageNumber} / {pageSizes.length || '—'}</span><button className="notes-toggle" onClick={() => setNotesVisible((visible) => !visible)} aria-expanded={notesVisible}>{notesVisible ? '메모 숨기기' : '메모 보기'}</button></div>
      </div>
      <div className={`pdf-main ${notesVisible ? '' : 'notes-hidden'}`}>
        <div className={`pdf-canvas-scroller ${screenLocked ? 'screen-locked' : ''}`} ref={scrollRef}>
          {loading && <div className="pdf-loading"><span className="spinner" /> PDF 여는 중...</div>}
          {error && <div className="pdf-error">{error}</div>}
          {!loading && !error && document && <div className="pdf-page-list">{pageSizes.map((size, index) => <PdfPageView key={index + 1} pdf={document} pageNumber={index + 1} pageSize={size} width={pageWidth} strokes={markup.strokes[index + 1] || []} tool={tool} penColor={penColor} penSize={penSize} mode={viewMode} scrollRoot={scrollRef} onActivate={setActivePage} onDraw={drawPoint} onErase={eraseAt} />)}</div>}
        </div>
        {notesVisible && <aside className="pdf-notes"><div className="notes-heading"><strong>페이지별 메모</strong><span>{pageNumber}페이지 · 입력 즉시 자동 저장</span></div><textarea value={currentNote} onChange={(event) => setMarkup((current) => ({ ...current, notes: { ...current.notes, [pageNumber]: event.target.value } }))} placeholder="이 페이지의 메모를 적어 보세요…" /><div className="notes-bottom"><span>{currentPageStrokes.length}개 필기 · {screenLocked ? '화면 고정됨' : '세로 스크롤 가능'}</span><button onClick={() => void exportAnnotatedPdf()} disabled={loading || exporting}>{exporting ? 'PDF 만드는 중…' : '필기 포함 PDF 저장'}</button></div></aside>}
      </div>
    </section>
  </div>;
}
