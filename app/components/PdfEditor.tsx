'use client';

import { PointerEvent, RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type InkStroke = { color: string; size: number; opacity?: number; penStyle?: PenStyle; points: Array<[number, number]> };
export type PdfMarkup = { notes: Record<number, string>; strokes: Record<number, InkStroke[]> };
type PageSize = { width: number; height: number };
type Tool = 'pen' | 'eraser' | 'highlighter';
type PenStyle = 'ballpoint' | 'pencil' | 'brush';
type EraserMode = 'partial' | 'stroke';
type ViewMode = 'viewer' | 'write';
type SearchBox = { left: number; top: number; width: number; height: number };
type SearchUnit = { text: string; box?: SearchBox; fontFamily?: string; direction?: string };
type SearchHit = { pageNumber: number; boxes?: SearchBox[]; excerpt: string };
type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

type SearchCharacterPosition = { character: string; start: number; end: number };

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
  searchBoxes?: SearchBox[];
  scrollRoot: RefObject<HTMLDivElement | null>;
  onActivate: (pageNumber: number) => void;
  onDraw: (pageNumber: number, point: [number, number], begin: boolean) => void;
  onErase: (pageNumber: number, point: [number, number]) => void;
};

const blankMarkup = (): PdfMarkup => ({ notes: {}, strokes: {} });
const INK_COLORS = ['#202820', '#d94f46', '#3367c7', '#e09b23', '#7b4bb5'];
const HIGHLIGHTER_COLORS = ['#ffe45e', '#ff78a8', '#62b7ff', '#70d99a'];

function drawStrokes(canvas: HTMLCanvasElement, strokes: InkStroke[]) {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  strokes.forEach((stroke) => {
    if (!stroke.points.length) return;
    const style = stroke.penStyle || 'ballpoint';
    const widthScale = style === 'brush' ? 1.65 : style === 'pencil' ? 0.78 : 1;
    const defaultOpacity = style === 'pencil' ? 0.62 : style === 'brush' ? 0.86 : 1;
    context.beginPath();
    context.globalAlpha = stroke.opacity ?? defaultOpacity;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = Math.max(stroke.size * canvas.width * widthScale, 2);
    const [x, y] = stroke.points[0];
    context.moveTo(x * canvas.width, y * canvas.height);
    stroke.points.slice(1).forEach(([pointX, pointY]) => context.lineTo(pointX * canvas.width, pointY * canvas.height));
    if (stroke.points.length === 1) context.lineTo(x * canvas.width + 0.01, y * canvas.height + 0.01);
    context.stroke();
  });
  context.globalAlpha = 1;
}

function normalizeSearchText(text: string) {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function findSearchHits(units: SearchUnit[], query: string, pageNumber: number): SearchHit[] {
  const normalizedQuery = normalizeSearchText(query).replace(/\s/g, '');
  if (!normalizedQuery) return [];
  const measureCanvas = window.document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  const characters: string[] = [];
  const characterUnits: number[] = [];
  const characterOffsets: number[] = [];
  const unitPositions: SearchCharacterPosition[][] = [];
  const unitAdvances: number[] = [];
  units.forEach((unit, unitIndex) => {
    if (measureContext) measureContext.font = `100px ${unit.fontFamily || 'sans-serif'}`;
    const originalCharacters = Array.from(unit.text);
    const individualWidths = originalCharacters.map((character) => measureContext?.measureText(character).width || 1);
    const rawWidth = individualWidths.reduce((sum, width) => sum + width, 0) || 1;
    const measuredWidth = measureContext?.measureText(unit.text).width || rawWidth;
    const widthScale = measuredWidth / rawWidth;
    const positions: SearchCharacterPosition[] = [];
    let cursor = 0;
    originalCharacters.forEach((originalCharacter, originalIndex) => {
      const advance = individualWidths[originalIndex] * widthScale;
      const normalizedCharacters = Array.from(originalCharacter.normalize('NFKC').toLocaleLowerCase());
      if (!/^\s+$/u.test(originalCharacter)) {
        normalizedCharacters.forEach((character) => {
          const characterAdvance = advance / Math.max(1, normalizedCharacters.length);
          positions.push({ character, start: cursor, end: cursor + characterAdvance });
          characters.push(character);
          characterUnits.push(unitIndex);
          characterOffsets.push(positions.length - 1);
          cursor += characterAdvance;
        });
      } else {
        cursor += advance;
      }
    });
    unitPositions[unitIndex] = positions;
    unitAdvances[unitIndex] = cursor;
  });
  const searchableText = characters.join('');
  const matches: SearchHit[] = [];
  let fromIndex = 0;
  while (fromIndex <= searchableText.length - normalizedQuery.length) {
    const matchIndex = searchableText.indexOf(normalizedQuery, fromIndex);
    if (matchIndex < 0) break;
    const matchEnd = matchIndex + normalizedQuery.length;
    const matchedOffsets = new Map<number, number[]>();
    for (let index = matchIndex; index < matchEnd; index += 1) {
      const unitIndex = characterUnits[index];
      const offsets = matchedOffsets.get(unitIndex) || [];
      offsets.push(characterOffsets[index]);
      matchedOffsets.set(unitIndex, offsets);
    }
    const boxes = [...matchedOffsets.entries()].flatMap(([unitIndex, offsets]) => {
      const unit = units[unitIndex];
      if (!unit.box) return [];
      const from = Math.min(...offsets);
      const to = Math.max(...offsets);
      const positions = unitPositions[unitIndex];
      const totalAdvance = unitAdvances[unitIndex];
      const startAdvance = positions[from]?.start ?? 0;
      const endAdvance = positions[to]?.end ?? totalAdvance;
      const isRtl = unit.direction === 'rtl';
      const leftAdvance = isRtl ? totalAdvance - endAdvance : startAdvance;
      const left = unit.box.left + unit.box.width * leftAdvance / totalAdvance;
      return [{ ...unit.box, left, width: unit.box.width * (endAdvance - startAdvance) / totalAdvance }];
    });
    matches.push({ pageNumber, boxes, excerpt: searchableText.slice(Math.max(0, matchIndex - 18), Math.min(searchableText.length, matchEnd + 18)) });
    fromIndex = matchIndex + 1;
  }
  return matches;
}

function parseHocrWords(hocr: string | null, width: number, height: number): SearchUnit[] {
  if (!hocr) return [];
  const parsed = new DOMParser().parseFromString(hocr, 'text/html');
  return Array.from(parsed.querySelectorAll('.ocrx_word')).flatMap((element) => {
    const text = element.textContent?.trim() || '';
    const bbox = element.getAttribute('title')?.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!text || !bbox) return [];
    const x0 = Number(bbox[1]);
    const y0 = Number(bbox[2]);
    const x1 = Number(bbox[3]);
    const y1 = Number(bbox[4]);
    return [{
      text,
      box: { left: x0 / width, top: y0 / height, width: (x1 - x0) / width, height: (y1 - y0) / height },
    }];
  });
}

function addOlderBrowserPromiseSupport() {
  type WithResolvers<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };
  const promiseConstructor = Promise as PromiseConstructor & { withResolvers?: <T>() => WithResolvers<T> };
  if (!promiseConstructor.withResolvers) {
    Object.defineProperty(Promise, 'withResolvers', {
      configurable: true,
      value: <T,>(): WithResolvers<T> => {
        let resolve!: WithResolvers<T>['resolve'];
        let reject!: WithResolvers<T>['reject'];
        const promise = new Promise<T>((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        return { promise, resolve, reject };
      },
    });
  }
}

function PdfPageView({ pdf, pageNumber, pageSize, width, strokes, tool, penColor, penSize, mode, searchBoxes, scrollRoot, onActivate, onDraw, onErase }: PageProps) {
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
        if (!cancelled) drawStrokes(inkCanvas, strokes);
      } catch (cause) {
        if (!cancelled) console.error(`PDF ${pageNumber} 페이지 렌더링 오류`, cause);
      }
    }
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
    drawStrokes(canvas, strokes);
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
    {searchBoxes?.map((box, index) => <div key={index} className="pdf-search-highlight" style={{ left: `${box.left * 100}%`, top: `${box.top * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} aria-hidden="true" />)}
  </div>;
}

export default function PdfEditor({ file, fileId, loadMarkup, saveMarkup, onClose }: EditorProps) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [markup, setMarkup] = useState<PdfMarkup>(blankMarkup);
  const [pageNumber, setPageNumber] = useState(1);
  const [penColor, setPenColor] = useState(INK_COLORS[0]);
  const [highlighterColor, setHighlighterColor] = useState(HIGHLIGHTER_COLORS[0]);
  const [penSize, setPenSize] = useState(0.004);
  const [penStyle, setPenStyle] = useState<PenStyle>('ballpoint');
  const [highlighterSize, setHighlighterSize] = useState(0.022);
  const [tool, setTool] = useState<Tool>('pen');
  const [eraserMode, setEraserMode] = useState<EraserMode>('partial');
  const [viewMode, setViewMode] = useState<ViewMode>('viewer');
  const [screenLocked, setScreenLocked] = useState(false);
  const [notesVisible, setNotesVisible] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState({ done: 0, total: 0 });
  const [searchStatus, setSearchStatus] = useState('');
  const [saveLabel, setSaveLabel] = useState('불러오는 중');
  const [exporting, setExporting] = useState(false);
  const [viewerWidth, setViewerWidth] = useState(800);
  const [zoomScale, setZoomScale] = useState(1);
  const [pinchZoomScale, setPinchZoomScale] = useState<number | null>(null);
  const [pinchOrigin, setPinchOrigin] = useState<{ x: number; y: number } | null>(null);
  const [zoomControlsOpen, setZoomControlsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomScaleRef = useRef(1);
  const viewModeRef = useRef<ViewMode>('viewer');
  const pinchZoomRef = useRef<number | null>(null);
  const zoomControlsTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const ocrWorkerRef = useRef<OcrWorker | null>(null);
  const searchUnitCacheRef = useRef(new Map<number, SearchUnit[]>());
  const searchRunRef = useRef(0);
  zoomScaleRef.current = zoomScale;
  viewModeRef.current = viewMode;

  const revealZoomControls = useCallback((duration = 2600) => {
    setZoomControlsOpen(true);
    if (zoomControlsTimerRef.current !== null) window.clearTimeout(zoomControlsTimerRef.current);
    zoomControlsTimerRef.current = window.setTimeout(() => setZoomControlsOpen(false), duration);
  }, []);

  useEffect(() => () => {
    searchRunRef.current += 1;
    if (zoomControlsTimerRef.current !== null) window.clearTimeout(zoomControlsTimerRef.current);
    if (ocrWorkerRef.current) void ocrWorkerRef.current.terminate();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: { destroy: () => Promise<void>; promise: Promise<PDFDocumentProxy> } | null = null;
    async function loadDocument() {
      try {
        addOlderBrowserPromiseSupport();
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs?v=${pdfjs.version}`;
        const bytes = new Uint8Array(await file.arrayBuffer());
        loadingTask = pdfjs.getDocument({ data: bytes });
        const savedMarkupPromise = loadMarkup(fileId).catch((cause) => {
          console.warn('PDF 메모를 불러오지 못해 빈 메모로 엽니다.', cause);
          return blankMarkup();
        });
        const [pdf, savedMarkup] = await Promise.all([loadingTask.promise, savedMarkupPromise]);
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
    const root = scrollRef.current;
    if (!root) return;
    let pinchStart: { distance: number; scale: number } | null = null;
    const touchDistance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const startPinch = (event: TouchEvent) => {
      if (viewModeRef.current !== 'viewer' || event.touches.length < 2) return;
      event.preventDefault();
      revealZoomControls();
      pinchStart = { distance: Math.max(1, touchDistance(event.touches)), scale: zoomScaleRef.current };
      const pageList = root.querySelector<HTMLElement>('.pdf-page-list');
      if (pageList) {
        const bounds = pageList.getBoundingClientRect();
        const midpointX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
        const midpointY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        setPinchOrigin({ x: midpointX - bounds.left, y: midpointY - bounds.top });
      }
      pinchZoomRef.current = zoomScaleRef.current;
      setPinchZoomScale(zoomScaleRef.current);
    };
    const movePinch = (event: TouchEvent) => {
      if (!pinchStart || event.touches.length < 2) return;
      event.preventDefault();
      revealZoomControls();
      const nextScale = Math.min(3, Math.max(0.5, pinchStart.scale * touchDistance(event.touches) / pinchStart.distance));
      pinchZoomRef.current = nextScale;
      setPinchZoomScale(nextScale);
    };
    const finishPinch = () => {
      if (!pinchStart) return;
      const nextScale = pinchZoomRef.current ?? zoomScaleRef.current;
      pinchStart = null;
      pinchZoomRef.current = null;
      zoomScaleRef.current = nextScale;
      setZoomScale(nextScale);
      setPinchZoomScale(null);
      setPinchOrigin(null);
      revealZoomControls();
    };
    root.addEventListener('touchstart', startPinch, { passive: false });
    root.addEventListener('touchmove', movePinch, { passive: false });
    root.addEventListener('touchend', finishPinch);
    root.addEventListener('touchcancel', finishPinch);
    return () => {
      root.removeEventListener('touchstart', startPinch);
      root.removeEventListener('touchmove', movePinch);
      root.removeEventListener('touchend', finishPinch);
      root.removeEventListener('touchcancel', finishPinch);
    };
  }, [revealZoomControls]);

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

  const getOcrWorker = async () => {
    if (ocrWorkerRef.current) return ocrWorkerRef.current;
    setSearchStatus('한국어·영어 OCR 엔진을 준비하는 중…');
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('kor+eng', 1, {
      logger: (message) => {
        if (message.status) setSearchStatus(`OCR 준비 중 · ${message.status}${message.progress > 0 ? ` ${Math.round(message.progress * 100)}%` : ''}`);
      },
    });
    ocrWorkerRef.current = worker;
    return worker;
  };

  const getSearchUnits = async (targetPage: number): Promise<SearchUnit[]> => {
    const cached = searchUnitCacheRef.current.get(targetPage);
    if (cached) return cached;
    if (!document) return [];
    const page = await document.getPage(targetPage);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const textItems = textContent.items.filter((item): item is { str: string; dir: string; transform: number[]; width: number; height: number; fontName: string; hasEOL: boolean } => 'str' in item && typeof item.str === 'string');
    const readableText = textItems.map((item) => item.str).join('').trim();
    let units: SearchUnit[];

    if (readableText.length >= 16) {
      units = textItems.filter((item) => item.str.trim()).map((item) => {
        const x = Number(item.transform[4] || 0);
        const y = Number(item.transform[5] || 0);
        const first = viewport.convertToViewportPoint(x, y);
        const second = viewport.convertToViewportPoint(x + item.width, y + item.height);
        const left = Math.max(0, Math.min(first[0], second[0]) / viewport.width);
        const top = Math.max(0, Math.min(first[1], second[1]) / viewport.height);
        const right = Math.min(1, Math.max(first[0], second[0]) / viewport.width);
        const bottom = Math.min(1, Math.max(first[1], second[1]) / viewport.height);
        return { text: item.str, direction: item.dir, fontFamily: textContent.styles[item.fontName]?.fontFamily, box: { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) } };
      });
    } else {
      const worker = await getOcrWorker();
      const maxPixels = 2_500_000;
      const scale = Math.min(2, 1600 / viewport.width, Math.sqrt(maxPixels / (viewport.width * viewport.height)));
      const ocrViewport = page.getViewport({ scale });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(ocrViewport.width);
      canvas.height = Math.ceil(ocrViewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('OCR용 페이지 이미지를 준비하지 못했어요.');
      await page.render({ canvas, canvasContext: context, viewport: ocrViewport }).promise;
      try {
        const recognized = await worker.recognize(canvas, {}, { hocr: true });
        units = parseHocrWords(recognized.data.hocr, canvas.width, canvas.height);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    searchUnitCacheRef.current.set(targetPage, units);
    return units;
  };

  const scrollToSearchHit = (hit: SearchHit) => {
    const root = scrollRef.current;
    const pageElement = window.document.getElementById(`pdf-page-${hit.pageNumber}`);
    if (!root || !pageElement) return;
    const rootBounds = root.getBoundingClientRect();
    const pageBounds = pageElement.getBoundingClientRect();
    const hitTop = hit.boxes?.length ? Math.min(...hit.boxes.map((box) => box.top)) : 0.5;
    const hitBottom = hit.boxes?.length ? Math.max(...hit.boxes.map((box) => box.top + box.height)) : 0.5;
    const hitCenter = pageBounds.top + ((hitTop + hitBottom) / 2) * pageBounds.height;
    root.scrollBy({ top: hitCenter - (rootBounds.top + root.clientHeight / 2), behavior: 'smooth' });
    setPageNumber(hit.pageNumber);
  };

  const goToSearchHit = (index: number, hits = searchHits) => {
    if (!hits.length) return;
    const nextIndex = (index + hits.length) % hits.length;
    setActiveSearchIndex(nextIndex);
    scrollToSearchHit(hits[nextIndex]);
  };

  const searchDocument = async () => {
    const query = searchQuery.trim();
    if (!document || !query || searching) return;
    const runId = ++searchRunRef.current;
    setSearching(true);
    setSearchHits([]);
    setActiveSearchIndex(-1);
    setSearchProgress({ done: 0, total: pageSizes.length });
    setSearchStatus('문서에서 검색 중…');
    const found: SearchHit[] = [];
    try {
      for (let targetPage = 1; targetPage <= pageSizes.length; targetPage++) {
        if (runId !== searchRunRef.current) return;
        setSearchProgress({ done: targetPage - 1, total: pageSizes.length });
        setSearchStatus(`${targetPage} / ${pageSizes.length}페이지 검색 중…`);
        const units = await getSearchUnits(targetPage);
        found.push(...findSearchHits(units, query, targetPage));
      }
      if (runId !== searchRunRef.current) return;
      setSearchHits(found);
      setSearchStatus(found.length ? `${found.length}곳을 찾았어요.` : '일치하는 내용을 찾지 못했어요.');
      setSearchProgress({ done: pageSizes.length, total: pageSizes.length });
      if (found.length) {
        setActiveSearchIndex(0);
        window.setTimeout(() => scrollToSearchHit(found[0]), 0);
      }
    } catch (cause) {
      if (runId === searchRunRef.current) {
        setSearchStatus(cause instanceof Error ? `검색하지 못했어요: ${cause.message}` : '검색 중 문제가 생겼어요.');
      }
    } finally {
      if (runId === searchRunRef.current) setSearching(false);
    }
  };

  const pointDistance = (left: [number, number], right: [number, number]) => Math.hypot(left[0] - right[0], left[1] - right[1]);
  const drawPoint = (targetPage: number, point: [number, number], begin: boolean) => {
    setMarkup((current) => {
      const pageStrokes = [...(current.strokes[targetPage] || [])];
      if (begin) pageStrokes.push({ color: tool === 'highlighter' ? highlighterColor : penColor, size: tool === 'highlighter' ? highlighterSize : penSize, opacity: tool === 'highlighter' ? 0.34 : undefined, penStyle: tool === 'pen' ? penStyle : undefined, points: [point] });
      else if (pageStrokes.length) {
        const last = pageStrokes[pageStrokes.length - 1];
        pageStrokes[pageStrokes.length - 1] = { ...last, points: [...last.points, point] };
      }
      return { ...current, strokes: { ...current.strokes, [targetPage]: pageStrokes } };
    });
  };
  const eraseAt = (targetPage: number, point: [number, number]) => {
    const radius = 0.018;
    const pointSegmentDistance = (target: [number, number], start: [number, number], end: [number, number]) => {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) return pointDistance(target, start);
      const projection = Math.max(0, Math.min(1, ((target[0] - start[0]) * dx + (target[1] - start[1]) * dy) / lengthSquared));
      return pointDistance(target, [start[0] + projection * dx, start[1] + projection * dy]);
    };
    setMarkup((current) => {
      const nextStrokes: InkStroke[] = [];
      (current.strokes[targetPage] || []).forEach((stroke) => {
        if (eraserMode === 'stroke') {
          const hit = stroke.points.length === 1
            ? pointDistance(stroke.points[0], point) < radius
            : stroke.points.slice(1).some((end, index) => pointSegmentDistance(point, stroke.points[index], end) < radius);
          if (!hit) nextStrokes.push(stroke);
          return;
        }
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
            page.drawCircle({ x: x * pageWidth, y: (1 - y) * pageHeight, size: thickness / 2, color, opacity: stroke.opacity ?? 1 });
          }
          for (let i = 1; i < stroke.points.length; i++) {
            const [x1, y1] = stroke.points[i - 1];
            const [x2, y2] = stroke.points[i];
            page.drawLine({ start: { x: x1 * pageWidth, y: (1 - y1) * pageHeight }, end: { x: x2 * pageWidth, y: (1 - y2) * pageHeight }, thickness, color, opacity: stroke.opacity ?? 0.92 });
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
  const pageWidth = Math.min(viewerWidth, 920) * zoomScale;
  const shownZoomScale = pinchZoomScale ?? zoomScale;
  const adjustZoom = (amount: number) => { revealZoomControls(); setZoomScale((current) => Math.min(3, Math.max(0.5, Math.round((current + amount) * 100) / 100))); };
  const fitPageToScreen = () => { revealZoomControls(); setZoomScale(1); setPinchZoomScale(null); setPinchOrigin(null); scrollRef.current?.scrollTo({ left: 0, behavior: 'smooth' }); };
  const activeInkSize = tool === 'highlighter' ? highlighterSize : penSize;

  return <div className="pdf-editor-backdrop">
    <section className="pdf-editor" role="dialog" aria-modal="true" aria-label={`${file.name} PDF 편집`}>
      <header className="pdf-editor-header"><div className="pdf-title"><strong title={file.name}>{file.name}</strong><span className={`autosave-status ${saveLabel.includes('실패') ? 'save-error' : ''}`}><i />{saveLabel}</span></div><button className="pdf-close" onClick={() => void closeEditor()} aria-label="편집 닫기">×</button></header>
      <div className={`pdf-toolbar ${viewMode === 'write' ? 'write-mode-toolbar' : ''}`}>
        <div className="mode-switch" role="group" aria-label="문서 보기 모드"><button className={viewMode === 'viewer' ? 'mode-selected' : ''} aria-pressed={viewMode === 'viewer'} onClick={() => setViewMode('viewer')}>일반 뷰어</button><button className={viewMode === 'write' ? 'mode-selected' : ''} aria-pressed={viewMode === 'write'} onClick={() => { setViewMode('write'); setTool('pen'); }}>필기 모드</button></div>
        {viewMode === 'write' && <div className="write-tools-scroll"><div className="ink-tools">
          <button className={`tool-button ${tool === 'pen' ? 'tool-active' : ''}`} onClick={() => setTool('pen')} aria-pressed={tool === 'pen'}><span className="pen-symbol">✎</span><span>펜</span></button>
          <button className={`tool-button ${tool === 'highlighter' ? 'tool-active' : ''}`} onClick={() => setTool('highlighter')} aria-pressed={tool === 'highlighter'}><span className="highlighter-symbol">▰</span><span>형광펜</span></button>
          <button className={`tool-button eraser-tool ${tool === 'eraser' ? 'tool-active' : ''}`} onClick={() => setTool('eraser')} aria-pressed={tool === 'eraser'}><span>▱</span><span>지우개</span></button>
          {tool === 'eraser' && <select className="eraser-mode-select" value={eraserMode} onChange={(event) => setEraserMode(event.target.value as EraserMode)} aria-label="지우개 방식"><option value="partial">부분 지우개</option><option value="stroke">획 전체 지우개</option></select>}
          {tool === 'pen' && <select className="pen-style-select" value={penStyle} onChange={(event) => setPenStyle(event.target.value as PenStyle)} aria-label="펜 종류"><option value="ballpoint">볼펜</option><option value="pencil">연필</option><option value="brush">붓펜</option></select>}
          <div className="ink-colors" aria-label={tool === 'highlighter' ? '형광펜 색상' : '펜 색상'}>{(tool === 'highlighter' ? HIGHLIGHTER_COLORS : INK_COLORS).map((color) => { const selected = tool === 'highlighter' ? highlighterColor === color : penColor === color; return <button key={color} aria-label={`${tool === 'highlighter' ? '형광펜' : '펜'} 색상 ${color}`} aria-pressed={selected} className={selected ? 'color-selected' : ''} style={{ '--ink-color': color } as React.CSSProperties} onClick={() => { if (tool === 'highlighter') { setHighlighterColor(color); setTool('highlighter'); } else { setPenColor(color); setTool('pen'); } }} />; })}</div>
          {tool !== 'eraser' && <label className="pen-size-control"><span>굵기</span><input type="range" min={tool === 'highlighter' ? 8 : 1} max={tool === 'highlighter' ? 40 : 16} step="1" value={Math.round(activeInkSize * 1000)} onChange={(event) => { const nextSize = Number(event.target.value) / 1000; if (tool === 'highlighter') setHighlighterSize(nextSize); else setPenSize(nextSize); }} aria-label={`${tool === 'highlighter' ? '형광펜' : '펜'} 굵기`} /><output>{Math.round(activeInkSize * 1000)}</output></label>}
          <button className={`tool-button screen-lock-button ${screenLocked ? 'tool-active' : ''}`} onClick={() => setScreenLocked((current) => !current)} aria-pressed={screenLocked}><span>{screenLocked ? '🔒' : '🔓'}</span><span>{screenLocked ? '잠금 해제' : '화면 잠금'}</span></button>
        </div></div>}
        <div className="toolbar-actions"><span className="page-indicator">{pageNumber} / {pageSizes.length || '—'}</span><button className="search-toggle" onClick={() => setSearchOpen((open) => !open)} aria-expanded={searchOpen}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4.2 4.2" /></svg><span>찾기</span></button><button className="notes-toggle" onClick={() => setNotesVisible((visible) => !visible)} aria-expanded={notesVisible}>{notesVisible ? '메모 숨기기' : '메모 보기'}</button></div>
      </div>
      {searchOpen && <div className="pdf-search-bar" role="search">
        <div className="pdf-search-input"><input value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearchHits([]); setActiveSearchIndex(-1); setSearchStatus(''); }} onKeyDown={(event) => { if (event.key === 'Enter') void searchDocument(); }} placeholder="PDF에서 단어 또는 문장 찾기" aria-label="PDF에서 검색" disabled={searching} /><button onClick={() => void searchDocument()} disabled={loading || searching || !searchQuery.trim()}>{searching ? '검색 중…' : '검색'}</button></div>
        <div className="pdf-search-results"><span role="status">{searching ? `${searchStatus} (${searchProgress.done}/${searchProgress.total})` : searchHits.length && activeSearchIndex >= 0 ? `전체 ${searchHits.length}곳 · ${activeSearchIndex + 1}/${searchHits.length} · ${searchHits[activeSearchIndex].pageNumber}페이지` : searchStatus || '검색어를 입력하세요'}</span><div><button onClick={() => goToSearchHit(activeSearchIndex - 1)} disabled={!searchHits.length || searching}>이전</button><button onClick={() => goToSearchHit(activeSearchIndex + 1)} disabled={!searchHits.length || searching}>다음</button></div></div>
        <small className="pdf-search-help">이미지 페이지는 이 기기에서 OCR 검색해요. 처음에는 OCR 언어 데이터 다운로드가 필요해요.</small>
      </div>}
      <div className={`pdf-main ${notesVisible ? '' : 'notes-hidden'}`}>
        <div className={`pdf-canvas-scroller ${screenLocked ? 'screen-locked' : ''} ${zoomScale > 1 ? 'zoomed' : ''}`} ref={scrollRef}>
          <div className="pdf-zoom-controls" role="group" aria-label="PDF 확대/축소">
            {zoomControlsOpen ? <>
              <button onClick={() => adjustZoom(-0.25)} disabled={loading || zoomScale <= 0.5} aria-label="축소" title="축소">−</button>
              <span aria-live="polite">{Math.round(shownZoomScale * 100)}%</span>
              <button onClick={() => adjustZoom(0.25)} disabled={loading || zoomScale >= 3} aria-label="확대" title="확대">+</button>
              <button className="zoom-fit-button" onClick={fitPageToScreen} disabled={loading || (zoomScale === 1 && pinchZoomScale === null)} aria-label="화면 맞춤">맞춤</button>
            </> : <button className="zoom-level-toggle" onClick={() => revealZoomControls()} aria-label={`확대 도구 열기, 현재 ${Math.round(zoomScale * 100)}%`} aria-expanded={zoomControlsOpen} title="확대/축소 도구">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4.2 4.2M10.8 7.8v6M7.8 10.8h6" /></svg><span>{Math.round(zoomScale * 100)}%</span>
            </button>}
          </div>
          {loading && <div className="pdf-loading"><span className="spinner" /> PDF 여는 중...</div>}
          {error && <div className="pdf-error">{error}</div>}
          {!loading && !error && document && <div className="pdf-page-list" style={{ width: `${Math.max(100, zoomScale * 100)}%`, transform: pinchZoomScale === null ? undefined : `scale(${pinchZoomScale / zoomScale})`, transformOrigin: pinchOrigin ? `${pinchOrigin.x}px ${pinchOrigin.y}px` : 'top center' }}>{pageSizes.map((size, index) => { const activeHit = activeSearchIndex >= 0 ? searchHits[activeSearchIndex] : null; return <PdfPageView key={index + 1} pdf={document} pageNumber={index + 1} pageSize={size} width={pageWidth} strokes={markup.strokes[index + 1] || []} tool={tool} penColor={penColor} penSize={penSize} mode={viewMode} searchBoxes={activeHit?.pageNumber === index + 1 ? activeHit.boxes : undefined} scrollRoot={scrollRef} onActivate={setActivePage} onDraw={drawPoint} onErase={eraseAt} />; })}</div>}
        </div>
        {notesVisible && <aside className="pdf-notes"><div className="notes-heading"><strong>페이지별 메모</strong><span>{pageNumber}페이지 · 입력 즉시 자동 저장</span></div><textarea value={currentNote} onChange={(event) => setMarkup((current) => ({ ...current, notes: { ...current.notes, [pageNumber]: event.target.value } }))} placeholder="이 페이지의 메모를 적어 보세요…" /><div className="notes-bottom"><span>{currentPageStrokes.length}개 필기 · {screenLocked ? '화면 고정됨' : '세로 스크롤 가능'}</span><button onClick={() => void exportAnnotatedPdf()} disabled={loading || exporting}>{exporting ? 'PDF 만드는 중…' : '필기 포함 PDF 저장'}</button></div></aside>}
      </div>
    </section>
  </div>;
}
