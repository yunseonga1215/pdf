'use client';

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { PdfMarkup } from './components/PdfEditor';

const PdfEditor = dynamic(() => import('./components/PdfEditor'), { ssr: false });

type Folder = { id: string; name: string; createdAt: number; color?: string };
type LibraryFile = { id: string; folderId: string; file: File; savedAt: number };
type DestinationMode = 'existing' | 'new';

const DB_NAME = 'dama-file-library';
const DB_VERSION = 2;
const FOLDERS = 'folders';
const FILES = 'files';
const MARKUP_PREFIX = '__pdf_markup__:';

function openLibrary(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction!;
      const folderStore = db.objectStoreNames.contains(FOLDERS)
        ? transaction.objectStore(FOLDERS)
        : db.createObjectStore(FOLDERS, { keyPath: 'id' });
      const hadFiles = db.objectStoreNames.contains(FILES);
      const fileStore = hadFiles ? transaction.objectStore(FILES) : db.createObjectStore(FILES, { keyPath: 'id' });
      if (hadFiles) {
        const oldFiles = fileStore.getAll();
        oldFiles.onsuccess = () => {
          const records = oldFiles.result as Array<{ id: string; file: File; savedAt?: number; folderId?: string }>;
          if (!records.length) return;
          const folderId = 'imported-files-folder';
          folderStore.put({ id: folderId, name: '내 파일', createdAt: Date.now() } satisfies Folder);
          records.forEach((record) => fileStore.put({ ...record, folderId: record.folderId || folderId }));
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function loadPdfMarkup(fileId: string): Promise<PdfMarkup> {
  return openLibrary().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(FOLDERS, 'readonly');
    const request = transaction.objectStore(FOLDERS).get(`${MARKUP_PREFIX}${fileId}`);
    request.onsuccess = () => resolve(request.result?.markup || { notes: {}, strokes: {} });
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  }));
}

function savePdfMarkup(fileId: string, markup: PdfMarkup): Promise<void> {
  return openLibrary().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(FOLDERS, 'readwrite');
    transaction.objectStore(FOLDERS).put({ id: `${MARKUP_PREFIX}${fileId}`, markup, updatedAt: Date.now() });
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    transaction.onabort = () => { db.close(); reject(transaction.error); };
  }));
}

function loadLibrary(): Promise<{ folders: Folder[]; files: LibraryFile[] }> {
  return openLibrary().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction([FOLDERS, FILES], 'readonly');
    const folderRequest = transaction.objectStore(FOLDERS).getAll();
    const fileRequest = transaction.objectStore(FILES).getAll();
    transaction.oncomplete = () => {
      resolve({
        folders: (folderRequest.result as Folder[]).filter((folder) => !folder.id.startsWith(MARKUP_PREFIX)).sort((a, b) => b.createdAt - a.createdAt),
        files: (fileRequest.result as LibraryFile[]).sort((a, b) => b.savedAt - a.savedAt),
      });
      db.close();
    };
    transaction.onerror = () => { reject(transaction.error); db.close(); };
  }));
}

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

function FileGlyph({ name }: { name: string }) {
  const ext = name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE';
  return <div className="file-glyph"><span>{ext}</span><i /></div>;
}

export default function Home() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [activeFolderId, setActiveFolderId] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [destinationMode, setDestinationMode] = useState<DestinationMode>('new');
  const [destinationFolderId, setDestinationFolderId] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creatingFolderOnly, setCreatingFolderOnly] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [pdfEditingFile, setPdfEditingFile] = useState<{ id: string; file: File } | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [openFolderMenu, setOpenFolderMenu] = useState('');
  const [renameFolder, setRenameFolder] = useState<Folder | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [folderToDelete, setFolderToDelete] = useState<Folder | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeFolder = folders.find((folder) => folder.id === activeFolderId);
  const visibleFiles = useMemo(() => libraryFiles.filter((file) => file.folderId === activeFolderId), [libraryFiles, activeFolderId]);
  const folderCounts = useMemo(() => {
    const counts = new Map<string, { count: number; size: number }>();
    libraryFiles.forEach(({ folderId, file }) => {
      const current = counts.get(folderId) || { count: 0, size: 0 };
      counts.set(folderId, { count: current.count + 1, size: current.size + file.size });
    });
    return counts;
  }, [libraryFiles]);

  const refreshLibrary = useCallback(async (preferredFolderId?: string) => {
    const result = await loadLibrary();
    setFolders(result.folders);
    setLibraryFiles(result.files);
    setActiveFolderId((current) => {
      if (preferredFolderId && result.folders.some((folder) => folder.id === preferredFolderId)) return preferredFolderId;
      if (current && result.folders.some((folder) => folder.id === current)) return current;
      return result.folders[0]?.id || '';
    });
  }, []);

  useEffect(() => {
    refreshLibrary().catch(() => setMessage('브라우저 보관함을 열지 못했어요. 브라우저의 저장 공간을 확인해 주세요.'))
      .finally(() => setReady(true));
  }, [refreshLibrary]);

  useEffect(() => {
    if (!previewFile) {
      setPreviewUrl('');
      setPreviewText('');
      return;
    }
    const url = URL.createObjectURL(previewFile);
    setPreviewUrl(url);
    const extension = previewFile.name.split('.').pop()?.toLowerCase();
    const isText = previewFile.type.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'log', 'xml'].includes(extension || '');
    if (isText) previewFile.text().then(setPreviewText).catch(() => setPreviewText('텍스트 미리보기를 불러오지 못했어요.'));
    return () => URL.revokeObjectURL(url);
  }, [previewFile]);

  const showDestinationDialog = (files: File[]) => {
    if (!files.length) return;
    setPendingFiles(files);
    setCreatingFolderOnly(false);
    setDestinationMode(folders.length ? 'existing' : 'new');
    setDestinationFolderId(activeFolderId || folders[0]?.id || '');
    setNewFolderName('');
    setDialogOpen(true);
  };

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    if (list.length) showDestinationDialog(list);
  // Dialog inputs are opened from this page; use the current folder list for destination choices.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, activeFolderId]);

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const startCreateFolder = () => {
    setPendingFiles([]);
    setCreatingFolderOnly(true);
    setDestinationMode('new');
    setNewFolderName('');
    setDialogOpen(true);
  };

  const saveIntoFolder = async () => {
    const trimmedName = newFolderName.trim();
    if (destinationMode === 'new' && !trimmedName) {
      setMessage('새 폴더 이름을 입력해 주세요.');
      return;
    }
    if (destinationMode === 'new' && folders.some((folder) => folder.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase())) {
      setMessage('같은 이름의 폴더가 있어요. 다른 이름을 입력해 주세요.');
      return;
    }
    if (destinationMode === 'existing' && !destinationFolderId) {
      setMessage('파일을 넣을 폴더를 선택해 주세요.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const db = await openLibrary();
      const transaction = db.transaction([FOLDERS, FILES], 'readwrite');
      const folderId = destinationMode === 'new' ? crypto.randomUUID() : destinationFolderId;
      if (destinationMode === 'new') {
        transaction.objectStore(FOLDERS).put({ id: folderId, name: trimmedName, createdAt: Date.now() } satisfies Folder);
      }
      pendingFiles.forEach((file) => {
        transaction.objectStore(FILES).put({ id: crypto.randomUUID(), folderId, file, savedAt: Date.now() } satisfies LibraryFile);
      });
      transaction.oncomplete = async () => {
        db.close();
        setDialogOpen(false);
        setPendingFiles([]);
        setCreatingFolderOnly(false);
        await refreshLibrary(folderId);
        setBusy(false);
      };
      transaction.onerror = () => {
        db.close();
        setBusy(false);
        setMessage('저장 공간이 부족하거나 파일을 저장하지 못했어요.');
      };
      transaction.onabort = () => {
        db.close();
        setBusy(false);
        setMessage('저장을 완료하지 못했어요. 다시 시도해 주세요.');
      };
    } catch {
      setBusy(false);
      setMessage('브라우저에 파일을 저장하지 못했어요. 저장 공간을 확인해 주세요.');
    }
  };

  const deleteFile = async (id: string) => {
    const db = await openLibrary();
    const transaction = db.transaction([FILES, FOLDERS], 'readwrite');
    transaction.objectStore(FILES).delete(id);
    transaction.objectStore(FOLDERS).delete(`${MARKUP_PREFIX}${id}`);
    transaction.oncomplete = () => { db.close(); void refreshLibrary(activeFolderId); };
    transaction.onerror = () => { db.close(); setMessage('파일을 삭제하지 못했어요.'); };
  };

  const deleteFolder = async (folder: Folder) => {
    const db = await openLibrary();
    const transaction = db.transaction([FOLDERS, FILES], 'readwrite');
    const fileStore = transaction.objectStore(FILES);
    const request = fileStore.getAll();
    request.onsuccess = () => {
      (request.result as LibraryFile[]).filter((file) => file.folderId === folder.id).forEach((file) => {
        fileStore.delete(file.id);
        transaction.objectStore(FOLDERS).delete(`${MARKUP_PREFIX}${file.id}`);
      });
      transaction.objectStore(FOLDERS).delete(folder.id);
    };
    transaction.oncomplete = () => { db.close(); void refreshLibrary(); };
    transaction.onerror = () => { db.close(); setMessage('폴더를 삭제하지 못했어요.'); };
  };

  const openFile = (file: File) => setPreviewFile(file);

  const handleOpenFile = (id: string, file: File) => {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      setPdfEditingFile({ id, file });
      return;
    }
    openFile(file);
  };

  const updateFolder = async (folderId: string, update: Partial<Folder>) => {
    const db = await openLibrary();
    const transaction = db.transaction(FOLDERS, 'readwrite');
    const store = transaction.objectStore(FOLDERS);
    const request = store.get(folderId);
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, ...update }); };
    transaction.oncomplete = () => { db.close(); setOpenFolderMenu(''); void refreshLibrary(activeFolderId); };
    transaction.onerror = () => { db.close(); setMessage('폴더를 변경하지 못했어요.'); };
  };

  const confirmRenameFolder = async () => {
    const name = renameValue.trim();
    if (!renameFolder || !name) return;
    if (folders.some((folder) => folder.id !== renameFolder.id && folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setMessage('같은 이름의 폴더가 있어요. 다른 이름을 입력해 주세요.');
      return;
    }
    await updateFolder(renameFolder.id, { name });
    setRenameFolder(null);
  };

  const downloadPreviewFile = () => {
    if (!previewFile || !previewUrl) return;
    const anchor = document.createElement('a');
    anchor.href = previewUrl;
    anchor.download = previewFile.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const sharePreviewFile = async () => {
    if (!previewFile || !navigator.share || !navigator.canShare?.({ files: [previewFile] })) {
      downloadPreviewFile();
      return;
    }
    try {
      await navigator.share({ files: [previewFile], title: previewFile.name });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      downloadPreviewFile();
    }
  };

  const previewExtension = previewFile?.name.split('.').pop()?.toLowerCase();
  const previewType = previewFile?.type || '';
  const isImagePreview = !!previewFile && (previewType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(previewExtension || ''));
  const isPdfPreview = !!previewFile && (previewType === 'application/pdf' || previewExtension === 'pdf');
  const isVideoPreview = !!previewFile && previewType.startsWith('video/');
  const isAudioPreview = !!previewFile && previewType.startsWith('audio/');
  const isTextPreview = !!previewFile && (previewType.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'log', 'xml'].includes(previewExtension || ''));

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="담아 홈"><span className="brand-mark"><i /><i /><i /></span><span>담아</span></a>
        <div className="topbar-note"><span className="secure-dot" /> 파일은 이 기기에만 저장돼요</div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span className="eyebrow-star">✳</span> YOUR PRIVATE FILE LIBRARY</div>
        <h1>파일을 담고,<br /><span>폴더별로 정리해요.</span></h1>
        <p className="hero-copy">파일을 올리고 폴더를 선택해 보관하세요.<br className="desktop-break" /> 이 브라우저 안에 저장되어 언제든 다시 열 수 있어요.</p>
      </section>

      <section className="workspace" aria-label="파일 및 폴더 보관함">
        <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <input ref={inputRef} className="visually-hidden" type="file" multiple onChange={onInput} />
          <div className="upload-illustration"><div className="upload-cloud"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M15.5 34.5h-2a8.5 8.5 0 0 1-.2-17 12 12 0 0 1 23.2 3.8 6.8 6.8 0 0 1-1.3 13.2h-2.7"/><path d="M24 38V24m0 0-5.2 5.2M24 24l5.2 5.2"/></svg></div><span className="spark spark-one">✦</span><span className="spark spark-two">✳</span></div>
          <h2>파일을 여기에 놓으세요</h2>
          <p>또는 <button className="text-button" onClick={() => inputRef.current?.click()}>파일 찾아보기</button></p>
          <span className="drop-hint">파일을 추가한 다음 저장할 폴더를 고를 수 있어요</span>
        </div>

        <div className="section-heading"><div><h2>내 폴더</h2><span>{folders.length}개</span></div><button className="new-folder-button" onClick={startCreateFolder}><span>＋</span> 새 폴더</button></div>
        {folders.length ? <div className="folder-grid">{folders.map((folder) => {
          const stats = folderCounts.get(folder.id) || { count: 0, size: 0 };
          return <div className={`folder-card ${activeFolderId === folder.id ? 'selected' : ''}`} key={folder.id} style={{ '--folder-tint': folder.color || '#819176' } as React.CSSProperties}>
            <button className="folder-card-main" onClick={() => setActiveFolderId(folder.id)} aria-pressed={activeFolderId === folder.id}>
              <span className="folder-card-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.8A1.8 1.8 0 0 1 5.3 5h4l1.9 2h7.5a1.8 1.8 0 0 1 1.8 1.8v9.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M3.8 9.1h16.4"/></svg></span>
              <span className="folder-card-name" title={folder.name}>{folder.name}</span>
              <span className="folder-card-meta">{stats.count}개 파일 · {formatSize(stats.size)}</span>
            </button><div className="folder-menu-wrap"><button className="folder-delete" aria-label={`${folder.name} 폴더 옵션`} aria-expanded={openFolderMenu === folder.id || openFolderMenu === `color:${folder.id}`} onClick={() => setOpenFolderMenu((current) => current === folder.id || current === `color:${folder.id}` ? '' : folder.id)}>···</button>{(openFolderMenu === folder.id || openFolderMenu === `color:${folder.id}`) && <div className="folder-menu"><button onClick={() => { setRenameFolder(folder); setRenameValue(folder.name); setOpenFolderMenu(''); }}>이름 변경</button><button onClick={() => setOpenFolderMenu(`color:${folder.id}`)}>색깔 변경 <span style={{ color: folder.color || '#819176' }}>●</span></button>{openFolderMenu === `color:${folder.id}` && <div className="folder-color-menu">{['#819176','#d18a58','#6489b3','#aa789e','#d0a83f','#77808e'].map((color) => <button key={color} aria-label={`폴더 색상 ${color}`} style={{ background: color }} onClick={() => void updateFolder(folder.id, { color })} />)}</div>}<button className="danger-menu-item" onClick={() => { setFolderToDelete(folder); setOpenFolderMenu(''); }}>모두 삭제</button></div>}</div>
          </div>;
        })}</div> : <div className="empty-folders"><span className="empty-folder-icon">▱</span><strong>아직 폴더가 없어요</strong><span>파일을 추가하고 새 폴더 이름을 입력하거나<br />위의 ‘새 폴더’ 버튼으로 먼저 만들어 보세요.</span></div>}

        {activeFolder && <div className="library-section">
          <div className="file-section-head"><div><h2>{activeFolder.name}</h2><span>{visibleFiles.length}개 파일 · {formatSize(visibleFiles.reduce((sum, item) => sum + item.file.size, 0))}</span></div><button className="add-more-button" onClick={() => inputRef.current?.click()}>＋ 파일 추가</button></div>
          {visibleFiles.length ? <ul className="file-list">{visibleFiles.map(({ id, file }) => <li className="file-item" key={id}><FileGlyph name={file.name} /><div className="file-meta"><strong title={file.name}>{file.name}</strong><span>{formatSize(file.size)}</span></div><button className="open-file-button" onClick={() => handleOpenFile(id, file)}>열기</button><button className="remove-button" aria-label={`${file.name} 삭제`} onClick={() => void deleteFile(id)}>×</button></li>)}</ul> : <div className="empty-files">이 폴더는 비어 있어요. 파일을 추가해 보세요.</div>}
        </div>}

        {message && <p className="message-note" role="status">{message}<button onClick={() => setMessage('')} aria-label="안내 닫기">×</button></p>}
        {!ready && <p className="loading-note"><span className="spinner" /> 보관함을 불러오는 중...</p>}
        <p className="privacy-note"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 13 3.5v3.7c0 3.2-2 5.7-5 7.1-3-1.4-5-3.9-5-7.1V3.5z"/><path d="m5.8 7.6 1.5 1.5 3-3.1"/></svg>파일과 폴더는 이 기기의 브라우저에 보관돼요. 외부로 전송되지 않아요.</p>
      </section>

      <footer className="footer"><span>필요한 만큼 담고, 원하는 폴더에 보관하세요.</span><span>담아 <b>·</b> 내 파일은 내 곁에</span></footer>

      {dialogOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDialogOpen(false); }}>
        <section className="destination-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <button className="dialog-close" onClick={() => setDialogOpen(false)} aria-label="닫기" disabled={busy}>×</button>
          <span className="dialog-kicker">{creatingFolderOnly ? 'NEW FOLDER' : 'SAVE FILES'}</span>
          <h2 id="dialog-title">{creatingFolderOnly ? '새 폴더 이름을 정해 주세요.' : '파일을 어디에 담을까요?'}</h2>
          {!creatingFolderOnly && <p className="dialog-caption">파일 {pendingFiles.length}개 · {formatSize(pendingFiles.reduce((sum, file) => sum + file.size, 0))}</p>}
          {!creatingFolderOnly && folders.length > 0 && <>
            <label className={`destination-choice ${destinationMode === 'existing' ? 'active' : ''}`}><input type="radio" name="destination" checked={destinationMode === 'existing'} onChange={() => setDestinationMode('existing')} /><span><strong>기존 폴더에 저장</strong><small>만들어 둔 폴더 중에서 선택해요.</small></span></label>
            {destinationMode === 'existing' && <select className="folder-select" value={destinationFolderId} onChange={(event) => setDestinationFolderId(event.target.value)} aria-label="저장할 기존 폴더">{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}
          </>}
          {!creatingFolderOnly && <label className={`destination-choice ${destinationMode === 'new' ? 'active' : ''}`}><input type="radio" name="destination" checked={destinationMode === 'new'} onChange={() => setDestinationMode('new')} /><span><strong>새 폴더 만들기</strong><small>새 폴더를 만들고 파일을 담아요.</small></span></label>}
          {(creatingFolderOnly || destinationMode === 'new') && <label className="folder-name-field"><span>폴더 이름</span><input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="예: 여행 사진" maxLength={60} onKeyDown={(event) => { if (event.key === 'Enter' && !busy) void saveIntoFolder(); }} /></label>}
          <div className="dialog-actions"><button className="cancel-button" onClick={() => setDialogOpen(false)} disabled={busy}>취소</button><button className="confirm-button" onClick={() => void saveIntoFolder()} disabled={busy || !ready}>{busy ? <><span className="spinner" /> 저장 중...</> : creatingFolderOnly ? '폴더 만들기' : destinationMode === 'new' ? '폴더 만들고 저장' : '선택한 폴더에 저장'}</button></div>
        </section>
      </div>}

      {previewFile && <div className="preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewFile(null); }}>
        <section className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
          <header className="preview-header"><div><h2 id="preview-title" title={previewFile.name}>{previewFile.name}</h2><span>{formatSize(previewFile.size)}</span></div><button className="dialog-close" onClick={() => setPreviewFile(null)} aria-label="미리보기 닫기">×</button></header>
          <div className="preview-content">
            {isImagePreview && <img src={previewUrl} alt={previewFile.name} />}
            {isPdfPreview && <iframe src={previewUrl} title={`${previewFile.name} 미리보기`} />}
            {isVideoPreview && <video src={previewUrl} controls playsInline />}
            {isAudioPreview && <audio src={previewUrl} controls />}
            {isTextPreview && <pre>{previewText || '미리보기를 불러오는 중...'}</pre>}
            {!isImagePreview && !isPdfPreview && !isVideoPreview && !isAudioPreview && !isTextPreview && <div className="unsupported-preview"><FileGlyph name={previewFile.name} /><strong>이 파일 형식은 브라우저에서 미리 볼 수 없어요.</strong><span>파일을 기기에 내려받아 지원하는 앱에서 열어 주세요.</span></div>}
          </div>
          <footer className="preview-footer"><span>파일은 이 기기의 브라우저에 보관돼요.</span><div><button className="cancel-button" onClick={() => void sharePreviewFile()}>기기에서 열기</button><button className="confirm-button preview-download" onClick={downloadPreviewFile}>다운로드</button></div></footer>
        </section>
      </div>}

      {renameFolder && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRenameFolder(null); }}><section className="destination-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title"><button className="dialog-close" onClick={() => setRenameFolder(null)} aria-label="닫기">×</button><span className="dialog-kicker">FOLDER</span><h2 id="rename-title">폴더 이름 변경</h2><label className="folder-name-field"><span>폴더 이름</span><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={60} onKeyDown={(event) => { if (event.key === 'Enter') void confirmRenameFolder(); }} /></label><div className="dialog-actions"><button className="cancel-button" onClick={() => setRenameFolder(null)}>취소</button><button className="confirm-button" onClick={() => void confirmRenameFolder()}>이름 저장</button></div></section></div>}

      {folderToDelete && <div className="dialog-backdrop" role="presentation"><section className="destination-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-folder-title"><span className="dialog-kicker">DELETE FOLDER</span><h2 id="delete-folder-title">‘{folderToDelete.name}’ 폴더를 모두 삭제할까요?</h2><p className="delete-folder-copy">폴더 안의 파일과 필기도 함께 지워집니다. 이 작업은 되돌릴 수 없어요.</p><div className="dialog-actions"><button className="cancel-button" onClick={() => setFolderToDelete(null)}>취소</button><button className="confirm-button danger-confirm" onClick={() => { const target = folderToDelete; setFolderToDelete(null); void deleteFolder(target); }}>폴더와 파일 삭제</button></div></section></div>}

      {pdfEditingFile && <PdfEditor file={pdfEditingFile.file} fileId={pdfEditingFile.id} loadMarkup={loadPdfMarkup} saveMarkup={savePdfMarkup} onClose={() => setPdfEditingFile(null)} />}
    </main>
  );
}
