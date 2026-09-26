'use client';

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type DirectoryHandle = FileSystemDirectoryHandle;
type StoredFile = { id: string; file: File; status: '저장 중' | '앱에 저장됨' | '저장 완료' | '저장 실패' };
type LibraryRecord = { id: string; file: File; savedAt: number };

const LIBRARY_DB = 'dama-file-library';
const LIBRARY_STORE = 'files';

function openLibrary(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(LIBRARY_STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getLibraryFiles(): Promise<LibraryRecord[]> {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LIBRARY_STORE, 'readonly');
    const request = transaction.objectStore(LIBRARY_STORE).getAll();
    request.onsuccess = () => resolve((request.result as LibraryRecord[]).sort((a, b) => b.savedAt - a.savedAt));
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

async function storeLibraryFile(id: string, file: File): Promise<void> {
  const db = await openLibrary();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(LIBRARY_STORE, 'readwrite');
    transaction.objectStore(LIBRARY_STORE).put({ id, file, savedAt: Date.now() } satisfies LibraryRecord);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }).finally(() => db.close());
}

async function removeLibraryFile(id: string): Promise<void> {
  const db = await openLibrary();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(LIBRARY_STORE, 'readwrite');
    transaction.objectStore(LIBRARY_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => db.close());
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
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [directory, setDirectory] = useState<DirectoryHandle | null>(null);
  const [folderName, setFolderName] = useState('폴더를 선택해 주세요');
  const [isDragging, setIsDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [canChooseFolder, setCanChooseFolder] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCanChooseFolder('showDirectoryPicker' in window);
    getLibraryFiles().then((records) => {
      setFiles(records.map(({ id, file }) => ({ id, file, status: '앱에 저장됨' })));
    }).catch(() => {
      alert('이 브라우저에서 파일 보관함을 열지 못했어요. 브라우저의 사이트 저장 공간을 확인해 주세요.');
    }).finally(() => setLibraryReady(true));
  }, []);

  const totalSize = useMemo(() => files.reduce((sum, item) => sum + item.file.size, 0), [files]);
  const savedCount = files.filter((item) => item.status === '저장 완료').length;

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    if (!list.length) return;
    const existing = new Set(files.map((item) => `${item.file.name}-${item.file.size}-${item.file.lastModified}`));
    const next = list.filter((file) => !existing.has(`${file.name}-${file.size}-${file.lastModified}`))
      .map((file) => ({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, status: '저장 중' as const }));
    setFiles((current) => [...current, ...next]);
    next.forEach((item) => {
      storeLibraryFile(item.id, item.file).then(() => {
        setFiles((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: '앱에 저장됨' } : entry));
      }).catch(() => setFiles((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: '저장 실패' } : entry)));
    });
  }, [files]);

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = '';
  };

  const selectFolder = async () => {
    const pickDirectory = (window as Window & { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (!pickDirectory) {
      setFolderName('기기의 다운로드 폴더');
      alert('현재 모바일 브라우저에서는 폴더를 직접 지정할 수 없어요. 저장한 파일은 기기의 다운로드 위치에 보관됩니다.');
      return;
    }
    try {
      const handle = await pickDirectory.call(window, { mode: 'readwrite' });
      setDirectory(handle);
      setFolderName(handle.name);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      alert('폴더를 선택하지 못했어요. 다시 시도해 주세요.');
    }
  };

  const saveFiles = async () => {
    if (!files.length || saving) return;
    if (!directory) {
      setSaving(true);
      for (const item of files) {
        const url = URL.createObjectURL(item.file);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = item.file.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setFiles((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: '저장 완료' } : entry));
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      }
      setSaving(false);
      return;
    }
    if (saving) return;
    setSaving(true);
    const result = await Promise.all(files.map(async (item) => {
      try {
        const handle = await directory.getFileHandle(item.file.name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(item.file);
        await writable.close();
        return { id: item.id, status: '저장 완료' as const };
      } catch {
        return { id: item.id, status: '저장 실패' as const };
      }
    }));
    setFiles((current) => current.map((item) => {
      const updated = result.find((entry) => entry.id === item.id);
      return updated ? { ...item, status: updated.status } : item;
    }));
    setSaving(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  };

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="폴더에 담기 홈"><span className="brand-mark"><i /><i /><i /></span><span>담아</span></a>
        <div className="topbar-note"><span className="secure-dot" /> 파일은 내 기기에 저장돼요</div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span className="eyebrow-star">✳</span> SIMPLE FILE ORGANIZER</div>
        <h1>파일을 담고,<br /><span>내 폴더에 정리해요.</span></h1>
        <p className="hero-copy">업로드한 파일을 내가 선택한 폴더에 바로 저장할 수 있어요.<br className="desktop-break" /> 복잡한 설정 없이, 간단하게 시작해 보세요.</p>
      </section>

      <section className="workspace" aria-label="파일 업로드 및 저장">
        <div className={`dropzone ${isDragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}>
          <input ref={inputRef} className="visually-hidden" type="file" multiple onChange={onInput} />
          <div className="upload-illustration"><div className="upload-cloud"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M15.5 34.5h-2a8.5 8.5 0 0 1-.2-17 12 12 0 0 1 23.2 3.8 6.8 6.8 0 0 1-1.3 13.2h-2.7"/><path d="M24 38V24m0 0-5.2 5.2M24 24l5.2 5.2"/></svg></div><span className="spark spark-one">✦</span><span className="spark spark-two">✳</span></div>
          <h2>파일을 여기에 끌어다 놓으세요</h2>
          <p>또는 <button className="text-button" onClick={() => inputRef.current?.click()}>파일 찾아보기</button></p>
          <span className="drop-hint">여러 파일을 한 번에 추가할 수 있어요</span>
        </div>

        <div className="folder-row">
          <div className="folder-info"><div className="folder-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.8A1.8 1.8 0 0 1 5.3 5h4l1.9 2h7.5a1.8 1.8 0 0 1 1.8 1.8v9.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M3.8 9.1h16.4"/></svg></div><div className="folder-label"><span>{canChooseFolder ? '저장할 폴더' : '저장 위치'}</span><strong title={folderName}>{folderName}</strong></div></div>
          <button className="folder-button" onClick={selectFolder}>{directory ? '폴더 변경' : canChooseFolder ? '폴더 선택' : '저장 위치 안내'}<span aria-hidden="true">↗</span></button>
        </div>

        {files.length > 0 && <div className="file-section">
          <div className="file-section-head"><div><h3>내 파일 보관함</h3><span>{files.length}개 · {formatSize(totalSize)}</span></div><button className="clear-button" onClick={() => { files.forEach((item) => void removeLibraryFile(item.id)); setFiles([]); }}>전체 삭제</button></div>
          <ul className="file-list">{files.map((item) => <li className="file-item" key={item.id}><FileGlyph name={item.file.name} /><div className="file-meta"><strong title={item.file.name}>{item.file.name}</strong><span>{formatSize(item.file.size)}</span></div><span className={`file-status ${item.status === '앱에 저장됨' || item.status === '저장 완료' ? 'done' : 'error'}`}>{item.status}</span><button className="open-file-button" onClick={() => { const url = URL.createObjectURL(item.file); window.open(url, '_blank', 'noopener,noreferrer'); window.setTimeout(() => URL.revokeObjectURL(url), 60000); }}>열기</button><button className="remove-button" aria-label={`${item.file.name} 삭제`} onClick={() => { setFiles((current) => current.filter((entry) => entry.id !== item.id)); void removeLibraryFile(item.id); }}>×</button></li>)}</ul>
          {files.some((item) => item.status === '저장 실패') && <p className="error-note">같은 이름의 파일이 있거나 권한이 없어 저장하지 못한 파일이 있어요. 폴더 권한을 확인하고 다시 저장해 주세요.</p>}
        </div>}

        <button className="save-button" disabled={!files.length || saving || !libraryReady || (canChooseFolder && !directory)} onClick={saveFiles}>{saving ? <><span className="spinner" /> 저장 중...</> : <><span>{directory ? '선택한 폴더에 내보내기' : canChooseFolder ? '저장 폴더를 선택해 주세요' : '기기에 파일 내보내기'}</span><span className="save-count">{files.length > 0 ? `${savedCount}/${files.length}` : '→'}</span></>}</button>
        <p className="privacy-note"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 13 3.5v3.7c0 3.2-2 5.7-5 7.1-3-1.4-5-3.9-5-7.1V3.5z"/><path d="m5.8 7.6 1.5 1.5 3-3.1"/></svg>파일은 이 기기의 브라우저에 저장돼요. 어디에도 업로드되지 않아요.</p>
      </section>

      <footer className="footer"><span>필요한 만큼 담고, 원하는 곳에 보관하세요.</span><span>담아 <b>·</b> 내 파일은 내 곁에</span></footer>
    </main>
  );
}
