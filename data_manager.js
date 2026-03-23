/**
 * data_manager.js — Shared Data & Context Manager
 * Covers: File System Access API, IndexedDB handle persistence,
 *         global school/year context, postMessage broadcast.
 * Browser support: Chrome / Edge (write). Firefox: download fallback.
 *
 * FIXED:
 *  - Added getFolderName()
 *  - restoreDataFolder: uses only queryPermission (no user-gesture violation)
 *  - openDataFolder: tries to reuse pending handle before prompting picker
 *  - saveDocument: returns { filename, mode } so callers can distinguish
 *    folder-save vs download-fallback vs error
 */

const DataManager = (() => {
    const DB_NAME = 'portal-fs-handles';
    const STORE_NAME = 'handles';
    const HANDLE_KEY = 'data-folder';
    const CONTEXT_KEY = 'portal-context';

    // ===== IndexedDB helpers =====
    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e);
        });
    }
    async function saveHandleToDB(handle) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
            tx.oncomplete = resolve; tx.onerror = reject;
        });
    }
    async function loadHandleFromDB() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
            req.onsuccess = e => resolve(e.target.result || null);
            req.onerror = reject;
        });
    }

    // ===== Internal state =====
    let _rootHandle = null;
    let _pendingHandle = null; // handle from DB waiting for user-gesture permission

    // ===== Getters =====
    // BUG FIX: this function was missing, causing portal status display to fail
    function getFolderName() {
        return _rootHandle ? _rootHandle.name : null;
    }

    // ===== Path sanitization =====
    function sanitizeName(name) {
        return (name || 'כללי').replace(/[/\\:*?"<>|]/g, '_').trim() || 'כללי';
    }

    // ===== File System API =====
    function isSupported() { return 'showDirectoryPicker' in window; }

    async function openDataFolder() {
        if (!isSupported()) {
            alert('הדפדפן אינו תומך בכתיבת קבצים ישירה.\nאנא השתמש ב-Chrome או Edge.\nהשמירה תתבצע כהורדת קובץ.');
            return false;
        }
        try {
            // BUG FIX: If restoreDataFolder found a handle in DB but couldn't get
            // permission (no user gesture at that point), reuse that handle now
            // since we ARE inside a user gesture (button click).
            if (_pendingHandle) {
                try {
                    const perm = await _pendingHandle.requestPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        _rootHandle = _pendingHandle;
                        _pendingHandle = null;
                        await saveHandleToDB(_rootHandle);
                        return true;
                    }
                } catch (e) {
                    console.warn('Could not reuse pending handle, opening picker:', e);
                }
                _pendingHandle = null;
            }
            // Open directory picker normally
            _rootHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'portal-data' });
            await saveHandleToDB(_rootHandle);
            return true;
        } catch (e) {
            if (e.name !== 'AbortError') console.error('openDataFolder:', e);
            return false;
        }
    }

    /**
     * BUG FIX: Original code called requestPermission() during DOMContentLoaded.
     * Chrome requires requestPermission to be called from a user gesture (click).
     * Calling it without a user gesture silently fails, leaving _rootHandle null
     * even when a valid handle exists in IndexedDB.
     *
     * Fix: only use queryPermission here (passive check).
     * If not yet granted, store in _pendingHandle so openDataFolder() can
     * call requestPermission inside the user's button click.
     */
    async function restoreDataFolder() {
        try {
            const handle = await loadHandleFromDB();
            if (!handle) return false;
            const perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm === 'granted') {
                _rootHandle = handle;
                _pendingHandle = null;
                return true;
            }
            // Permission not yet granted — save for reuse in openDataFolder (user gesture)
            _pendingHandle = handle;
        } catch (e) { console.warn('restoreDataFolder:', e); }
        return false;
    }

    function isReady() { return !!_rootHandle; }
    function hasPendingHandle() { return !!_pendingHandle; }

    async function getOrCreateDir(parent, name) {
        return await parent.getDirectoryHandle(sanitizeName(name), { create: true });
    }

    // ===== Global Context (school + year) =====
    function setGlobalContext(school, year) {
        const ctx = { school: school || '', year: year || '' };
        localStorage.setItem(CONTEXT_KEY, JSON.stringify(ctx));
        return ctx;
    }

    function getGlobalContext() {
        try {
            const raw = localStorage.getItem(CONTEXT_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) { }
        return { school: '', year: 'תשפ"ו' };
    }

    async function broadcastContext(iframe, docType) {
        const ctx = getGlobalContext();
        try {
            iframe.contentWindow.postMessage({ type: 'school-changed', school: ctx.school, year: ctx.year }, '*');
        } catch (e) { }
        if (docType && ctx.school && _rootHandle) {
            const docs = await listDocuments(ctx.school, ctx.year);
            const latest = docs.find(d => d.name.startsWith(docType));
            if (latest) {
                const data = await loadDocument(ctx.school, ctx.year, latest.name);
                if (data) {
                    try { iframe.contentWindow.postMessage({ type: 'load-data', payload: data.data }, '*'); } catch (e) { }
                }
            }
        }
    }

    // ===== Document CRUD =====
    /**
     * BUG FIX: Now returns { filename, mode } instead of filename/null.
     * mode: 'folder'   = saved to the selected folder (success)
     *       'download' = no folder set, fell back to JSON download
     *       'error'    = folder was set but write failed, fell back to download
     *
     * Previously, ALL paths returned a truthy/null that the portal treated
     * identically as "success", hiding the real state from the user.
     */
    async function saveDocument(schoolName, year, docType, data) {
        const filename = `${sanitizeName(docType)}_${new Date().toISOString().slice(0, 10)}.json`;
        const payload = JSON.stringify({ schoolName, year, docType, savedAt: new Date().toISOString(), data }, null, 2);

        if (_rootHandle) {
            try {
                const schoolDir = await getOrCreateDir(_rootHandle, schoolName);
                const yearDir = await getOrCreateDir(schoolDir, year);
                const fileHandle = await yearDir.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(payload);
                await writable.close();
                return { filename, mode: 'folder' };
            } catch (e) {
                console.error('saveDocument FS error, falling back to download:', e);
                _downloadJSON(payload, filename);
                return { filename, mode: 'error' };
            }
        }

        // No folder selected — download fallback
        _downloadJSON(payload, filename);
        return { filename: null, mode: 'download' };
    }

    async function loadDocument(schoolName, year, filename) {
        if (!_rootHandle) return null;
        try {
            const schoolDir = await _rootHandle.getDirectoryHandle(sanitizeName(schoolName));
            const yearDir = await schoolDir.getDirectoryHandle(sanitizeName(year));
            const fileHandle = await yearDir.getFileHandle(filename);
            const file = await fileHandle.getFile();
            return JSON.parse(await file.text());
        } catch (e) { console.error('loadDocument:', e); return null; }
    }

    async function listDocuments(schoolName, year) {
        if (!_rootHandle) return [];
        try {
            const schoolDir = await _rootHandle.getDirectoryHandle(sanitizeName(schoolName));
            const yearDir = await schoolDir.getDirectoryHandle(sanitizeName(year));
            const files = [];
            for await (const [name, handle] of yearDir.entries()) {
                if (handle.kind === 'file' && name.endsWith('.json')) {
                    const file = await handle.getFile();
                    files.push({ name, size: file.size, lastModified: new Date(file.lastModified).toLocaleDateString('he-IL'), handle });
                }
            }
            return files.sort((a, b) => b.name.localeCompare(a.name));
        } catch (e) { return []; }
    }

    // ===== Full tree scan =====
    async function scanDataTree() {
        if (!_rootHandle) return [];
        const schools = [];
        try {
            for await (const [schoolName, schoolHandle] of _rootHandle.entries()) {
                if (schoolHandle.kind !== 'directory') continue;
                const school = { name: schoolName, years: [] };
                for await (const [yearName, yearHandle] of schoolHandle.entries()) {
                    if (yearHandle.kind !== 'directory') continue;
                    const year = { name: yearName, docs: [] };
                    for await (const [docName, docHandle] of yearHandle.entries()) {
                        if (docHandle.kind === 'file' && docName.endsWith('.json')) {
                            const file = await docHandle.getFile();
                            year.docs.push({ name: docName, size: file.size, lastModified: new Date(file.lastModified).toLocaleDateString('he-IL') });
                        }
                    }
                    year.docs.sort((a, b) => b.name.localeCompare(a.name));
                    school.years.push(year);
                }
                school.years.sort((a, b) => b.name.localeCompare(a.name));
                schools.push(school);
            }
        } catch (e) { console.warn('scanDataTree:', e); }
        return schools.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Legacy helpers
    async function listSchools() {
        if (!_rootHandle) return [];
        const s = [];
        try { for await (const [n, h] of _rootHandle.entries()) if (h.kind === 'directory') s.push(n); } catch (e) { }
        return s.sort();
    }
    async function listYears(schoolName) {
        if (!_rootHandle) return [];
        try {
            const d = await _rootHandle.getDirectoryHandle(sanitizeName(schoolName));
            const y = [];
            for await (const [n, h] of d.entries()) if (h.kind === 'directory') y.push(n);
            return y.sort().reverse();
        } catch (e) { return []; }
    }

    // ===== Doc type labels =====
    const DOC_TYPE_LABELS = {
        mtss: 'מיפוי MTSS',
        hakala: 'תוכנית עבודה — הכלה',
        yesodi: 'תוכנית עבודה — יסודי',
        independent: 'שאלון לומד עצמאי',
        questionnaire: 'שאלון מרחבי עבודה'
    };

    const APP_SOURCES = {
        mtss: 'מיפוי סביבות למידה ורשתות תמיכה MTSS/מיפוי MTSS רשתות תמיכה סביבות למידה ואוכלוסיות מיוחדות.html',
        hakala: "אפליקציית_תוכנית_עבודה/תוכנית_עבודה_הכלה.html",
        yesodi: "אפליקציית_תוכנית_עבודה/תוכנית_עבודה_יסודי.html",
        questionnaire: 'אפליקציית שאלון מרחבי עבודה יסודי עכשווי/שאלון מרחבי עבודה יסודי עכשווי.html',
        independent: 'אפליקציית מיפוי לומד עצמאי/אפליקציית מיפוי לומד עצמאי ומיומנויות למידה/שאלון מיומנויות לומד עצמאי ותפקודים ניהוליים.html'
    };

    function getDocLabel(filename) {
        for (const [key, label] of Object.entries(DOC_TYPE_LABELS)) {
            if (filename.startsWith(key)) return label;
        }
        return filename;
    }

    function getDocTypeFromFilename(filename) {
        for (const key of Object.keys(DOC_TYPE_LABELS)) {
            if (filename.startsWith(key)) return key;
        }
        return null;
    }

    // ===== postMessage bridge =====
    function requestSaveViaPortal(docType, data) {
        if (window.parent !== window) {
            window.parent.postMessage({ type: 'save-request', docType, payload: data }, '*');
            return true;
        }
        return false;
    }

    function sendDataToFrame(iframe, docData) {
        try {
            // תמיכה בשני פורמטים: { data: {...} } או ישירות {...}
            const payload = (docData && docData.data !== undefined) ? docData.data : docData;
            iframe.contentWindow.postMessage({ type: 'load-data', payload }, '*');
        } catch (e) { }
    }

    // ===== Internal helpers =====
    function _downloadJSON(text, filename) {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
    }

    return {
        isSupported, openDataFolder, restoreDataFolder, isReady, hasPendingHandle,
        getFolderName,
        setGlobalContext, getGlobalContext, broadcastContext,
        saveDocument, loadDocument, listDocuments,
        listSchools, listYears, scanDataTree,
        getDocLabel, getDocTypeFromFilename, DOC_TYPE_LABELS, APP_SOURCES,
        requestSaveViaPortal, sendDataToFrame
    };
})();
