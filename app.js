// Firebase Config (using Compat SDK for file:/// support)
const firebaseConfig = {
    apiKey: "AIzaSyA4Z8et8ohOubuxZ0eSKBpNhlePh2jh1y8",
    authDomain: "j-instant-memo.firebaseapp.com",
    projectId: "j-instant-memo",
    storageBucket: "j-instant-memo.firebasestorage.app",
    messagingSenderId: "237007629473",
    appId: "1:237007629473:web:0549f3d5d5b0a4a242d4e0",
    measurementId: "G-YJXNN5L7XC",
    databaseURL: "https://j-instant-memo-default-rtdb.firebaseio.com"
};

let db = null;
let firebaseEnabled = false;
const SYNC_NAMESPACE_STORAGE_KEY = 'memoSyncNamespace';
const SYNC_NAMESPACE_QUERY_KEY = 'ns';

try {
    if (typeof firebase !== 'undefined') {
        firebase.initializeApp(firebaseConfig);
        db = firebase.database();
        firebaseEnabled = true;
    } else {
        console.warn('[MemoApp] Firebase SDK unavailable. Running in local-only mode.');
    }
} catch (error) {
    console.warn('[MemoApp] Firebase initialization failed. Running in local-only mode.', error);
}

function log(msg) {
    console.log(`[MemoApp] ${msg}`);
}

function sanitizeNamespace(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) return '';
    return trimmed;
}

function getOrCreateSyncNamespace() {
    try {
        const params = new URLSearchParams(window.location.search);
        const fromQuery = sanitizeNamespace(params.get(SYNC_NAMESPACE_QUERY_KEY));
        if (fromQuery) {
            localStorage.setItem(SYNC_NAMESPACE_STORAGE_KEY, fromQuery);
            return fromQuery;
        }
    } catch (error) {
        console.warn('[MemoApp] Failed to read sync namespace from URL.', error);
    }

    try {
        const stored = sanitizeNamespace(localStorage.getItem(SYNC_NAMESPACE_STORAGE_KEY));
        if (stored) return stored;

        const generated = `local-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(SYNC_NAMESPACE_STORAGE_KEY, generated);
        return generated;
    } catch (error) {
        console.warn('[MemoApp] Failed to persist sync namespace. Using fallback.', error);
        return 'local-fallback';
    }
}

const syncNamespace = getOrCreateSyncNamespace();

function syncRef(path) {
    return db.ref(`namespaces/${syncNamespace}/${path}`);
}

const memoInput = document.getElementById('memoInput');
const addBtn = document.getElementById('addBtn');
const memoList = document.getElementById('memoList');
const activeCount = document.getElementById('activeCount');
const clearCompletedBtn = document.getElementById('clearCompleted');
const sortBtn = document.getElementById('sortBtn');
const syncStatus = document.getElementById('syncStatus');

const dateText = document.getElementById('dateText');
const dayText = document.getElementById('dayText');
const datePicker = document.getElementById('datePicker');
const prevDateBtn = document.getElementById('prevDate');
const nextDateBtn = document.getElementById('nextDate');

const viewArchiveBtn = document.getElementById('viewArchiveBtn');
const archiveInputModal = document.getElementById('archiveInputModal');
const archiveTaskText = document.getElementById('archiveTaskText');
const archiveMemoInput = document.getElementById('archiveMemoInput');
const cancelArchiveBtn = document.getElementById('cancelArchiveBtn');
const confirmArchiveBtn = document.getElementById('confirmArchiveBtn');

const archiveViewModal = document.getElementById('archiveViewModal');
const closeArchiveViewBtn = document.getElementById('closeArchiveViewBtn');
const archiveList = document.getElementById('archiveList');

const editModal = document.getElementById('editModal');
const editMemoInput = document.getElementById('editMemoInput');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const confirmEditBtn = document.getElementById('confirmEditBtn');

const themeToggle = document.getElementById('themeToggle');

const alarmModal = document.getElementById('alarmModal');
const alarmTaskText = document.getElementById('alarmTaskText');
const alarmDateTime = document.getElementById('alarmDateTime');
const alarmRepeat = document.getElementById('alarmRepeat');
const repeatOptions = document.getElementById('repeatOptions');
const repeatInterval = document.getElementById('repeatInterval');
const repeatUntil = document.getElementById('repeatUntil');
const cancelAlarmBtn = document.getElementById('cancelAlarmBtn');
const removeAlarmBtn = document.getElementById('removeAlarmBtn');
const saveAlarmBtn = document.getElementById('saveAlarmBtn');
const toastContainer = document.getElementById('toastContainer');

let allMemos = {};
let archivedMemos = [];
let memoTombstones = {};
let archiveTombstones = {};
let selectedDate = getKSTDateString(new Date());

let currentArchiveItemId = null;
let currentAlarmItemId = null;
let currentEditItemId = null;
let alarmCheckInterval = null;
let midnightRefreshTimer = null;
let activeModal = null;
let lastFocusedElement = null;

let initialMemosLoaded = false;
let initialArchivesLoaded = false;
let hasInitialSyncResolved = false;
let pendingMemoSync = false;
let pendingArchiveSync = false;
let pendingMemoTombstoneSync = false;
let pendingArchiveTombstoneSync = false;
let initialMemoTombstonesLoaded = false;
let initialArchiveTombstonesLoaded = false;
let syncHadError = false;

function init() {
    initTheme();
    updateDateDisplay();
    loadLocalData();
    startSync();
    scheduleMidnightRefresh();
    setupDragAndDrop();
    startAlarmChecker();
}

function loadLocalData() {
    allMemos = normalizeMemoMap(readStoredJSON('allMemos', {}));
    archivedMemos = normalizeArchiveCollection(readStoredJSON('archivedMemos', []));
    memoTombstones = normalizeTombstoneMap(readStoredJSON('memoTombstones', {}));
    archiveTombstones = normalizeTombstoneMap(readStoredJSON('archiveTombstones', {}));
    if (stabilizeMemoMap(allMemos)) {
        writeLocalStorage('allMemos', allMemos);
    }
    if (applyMemoTombstones(allMemos)) {
        writeLocalStorage('allMemos', allMemos);
    }
    if (applyArchiveTombstones()) {
        writeLocalStorage('archivedMemos', archivedMemos);
    }
    renderMemos();
    updateStats();
}

function startSync() {
    if (!firebaseEnabled || !db) {
        setSyncStatus('local-only', 'Local only mode');
        carryOverIncompleteTasks();
        renderMemos();
        updateStats();
        return;
    }

    setSyncStatus('syncing', 'Connecting sync...');

    syncRef('memoTombstones').on('value', (snapshot) => {
        const remoteTombstones = normalizeTombstoneMap(snapshot.val());
        const mergedTombstones = mergeTombstoneMaps(remoteTombstones, memoTombstones);
        const shouldWriteBack = JSON.stringify(remoteTombstones) !== JSON.stringify(mergedTombstones);

        memoTombstones = mergedTombstones;
        writeLocalStorage('memoTombstones', memoTombstones);
        initialMemoTombstonesLoaded = true;

        if (applyMemoTombstones(allMemos)) {
            pendingMemoSync = true;
            writeLocalStorage('allMemos', allMemos);
        }

        maybeResolveInitialSync();

        if (shouldWriteBack) {
            pendingMemoTombstoneSync = true;
            flushPendingRemoteSync();
        }

        renderMemos();
        updateStats();
    }, (error) => {
        initialMemoTombstonesLoaded = true;
        handleSyncError('Memo deletion sync unavailable', error);
        maybeResolveInitialSync();
    });

    syncRef('archiveTombstones').on('value', (snapshot) => {
        const remoteTombstones = normalizeTombstoneMap(snapshot.val());
        const mergedTombstones = mergeTombstoneMaps(remoteTombstones, archiveTombstones);
        const shouldWriteBack = JSON.stringify(remoteTombstones) !== JSON.stringify(mergedTombstones);

        archiveTombstones = mergedTombstones;
        writeLocalStorage('archiveTombstones', archiveTombstones);
        initialArchiveTombstonesLoaded = true;

        if (applyArchiveTombstones()) {
            pendingArchiveSync = true;
            writeLocalStorage('archivedMemos', archivedMemos);
        }

        maybeResolveInitialSync();

        if (shouldWriteBack) {
            pendingArchiveTombstoneSync = true;
            flushPendingRemoteSync();
        }
    }, (error) => {
        initialArchiveTombstonesLoaded = true;
        handleSyncError('Archive deletion sync unavailable', error);
        maybeResolveInitialSync();
    });

    syncRef('allMemos').on('value', (snapshot) => {
        const remoteMemos = normalizeMemoMap(snapshot.val());
        const repairedRemoteMemos = stabilizeMemoMap(remoteMemos);
        const removedRemoteMemos = applyMemoTombstones(remoteMemos);
        const mergedMemos = mergeMemoMaps(remoteMemos, allMemos);
        const repairedMergedMemos = stabilizeMemoMap(mergedMemos);
        const removedMergedMemos = applyMemoTombstones(mergedMemos);
        const shouldWriteBack = repairedRemoteMemos
            || repairedMergedMemos
            || removedRemoteMemos
            || removedMergedMemos
            || JSON.stringify(remoteMemos) !== JSON.stringify(mergedMemos);

        allMemos = mergedMemos;
        initialMemosLoaded = true;

        maybeResolveInitialSync();

        if (shouldWriteBack) {
            pendingMemoSync = true;
            flushPendingRemoteSync();
        }

        renderMemos();
        updateStats();
    }, (error) => {
        initialMemosLoaded = true;
        handleSyncError('Memo sync unavailable', error);
        maybeResolveInitialSync();
    });

    syncRef('archivedMemos').on('value', (snapshot) => {
        const remoteArchives = normalizeArchiveCollection(snapshot.val());
        const removedRemoteArchives = filterArchivesWithTombstones(remoteArchives).length !== remoteArchives.length;
        const mergedArchives = mergeArchiveCollections(remoteArchives, archivedMemos);
        const filteredArchives = filterArchivesWithTombstones(mergedArchives);
        const shouldWriteBack = removedRemoteArchives
            || filteredArchives.length !== mergedArchives.length
            || JSON.stringify(remoteArchives) !== JSON.stringify(filteredArchives);

        archivedMemos = filteredArchives;
        initialArchivesLoaded = true;
        maybeResolveInitialSync();

        if (shouldWriteBack) {
            pendingArchiveSync = true;
            flushPendingRemoteSync();
        }
    }, (error) => {
        initialArchivesLoaded = true;
        handleSyncError('Archive sync unavailable', error);
        maybeResolveInitialSync();
    });
}

function maybeResolveInitialSync() {
    if (
        hasInitialSyncResolved
        || !initialMemosLoaded
        || !initialArchivesLoaded
        || !initialMemoTombstonesLoaded
        || !initialArchiveTombstonesLoaded
    ) {
        return;
    }

    hasInitialSyncResolved = true;
    applyMemoTombstones(allMemos);
    applyArchiveTombstones();
    carryOverIncompleteTasks();
    setSyncStatus(syncHadError ? 'error' : 'online', syncHadError ? 'Sync issue - local mode active' : 'Sync connected');
    flushPendingRemoteSync();
}

function flushPendingRemoteSync() {
    if (!firebaseEnabled || !db || !hasInitialSyncResolved) {
        return;
    }

    if (pendingMemoTombstoneSync) {
        pendingMemoTombstoneSync = false;
        saveMemoTombstones();
    }

    if (pendingArchiveTombstoneSync) {
        pendingArchiveTombstoneSync = false;
        saveArchiveTombstones();
    }

    if (pendingMemoSync) {
        pendingMemoSync = false;
        saveMemos();
    }

    if (pendingArchiveSync) {
        pendingArchiveSync = false;
        saveArchivedMemos();
    }
}

function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }
    themeToggle.setAttribute('aria-pressed', document.body.classList.contains('light-theme') ? 'true' : 'false');
}

function toggleTheme() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    themeToggle.setAttribute('aria-pressed', isLight ? 'true' : 'false');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

function getKSTDateString(date) {
    const parts = getKSTDateParts(date);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function formatDateDisplay(dateStr) {
    return dateStr.replace(/-/g, '. ');
}

function carryOverIncompleteTasks(targetDate = getKSTDateString(new Date())) {
    applyMemoTombstones(allMemos);
    const sortedDates = Object.keys(allMemos).sort((a, b) => b.localeCompare(a));
    const pastDates = sortedDates.filter((dateKey) => dateKey < targetDate);

    if (pastDates.length === 0) return;

    let changed = false;
    if (!Array.isArray(allMemos[targetDate])) {
        allMemos[targetDate] = [];
    }

    const latestTaskState = {};

    [...pastDates].reverse().forEach((dateKey) => {
        const bucket = Array.isArray(allMemos[dateKey]) ? allMemos[dateKey] : [];
        bucket.forEach((task) => {
            const taskKey = getMemoLineageKey(task);
            latestTaskState[taskKey] = {
                completed: task.completed,
                date: dateKey,
                originalTask: task
            };
        });
    });

    Object.values(latestTaskState).forEach((latest) => {
        if (latest.completed) return;

        const taskKey = getMemoLineageKey(latest.originalTask);
        if (memoTombstones[taskKey]) return;

        const alreadyInTargetDate = allMemos[targetDate].some((task) => getMemoLineageKey(task) === taskKey);
        const sameContentInTargetDate = hasMemoWithSameContent(targetDate, latest.originalTask.text);

        if (!alreadyInTargetDate && !sameContentInTargetDate) {
            allMemos[targetDate].push(createCarriedMemo(latest.originalTask, latest.date, targetDate));
            changed = true;
            log(`Carried over incomplete: ${latest.originalTask.text}`);
        }
    });

    if (changed) {
        sortMemoBucket(targetDate);
        saveMemos();
    }
}

function updateDateDisplay() {
    dateText.textContent = formatDateDisplay(selectedDate);

    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const dayIndex = getKSTDayIndex(selectedDate);
    dayText.textContent = days[dayIndex];

    dayText.className = 'day-of-week';
    if (dayIndex === 0) dayText.classList.add('sunday');
    if (dayIndex === 6) dayText.classList.add('saturday');
    if (dayIndex === 5) dayText.classList.add('friday');

    datePicker.value = selectedDate;
}

function renderMemos() {
    memoList.innerHTML = '';
    const dailyMemos = Array.isArray(allMemos[selectedDate]) ? allMemos[selectedDate] : [];

    dailyMemos.forEach((memo, index) => {
        const li = document.createElement('li');
        li.className = `memo-item ${memo.completed ? 'completed' : ''}`;
        li.setAttribute('draggable', 'true');
        li.dataset.index = index;
        li.dataset.memoId = memo.id;

        li.innerHTML = `
            <label class="checkbox-container">
                <input type="checkbox" ${memo.completed ? 'checked' : ''}>
                <span class="checkmark"></span>
            </label>
            <span class="memo-text">${escapeHtml(memo.text)}</span>
            <button class="top-btn" aria-label="Move to Top" title="Move to Top">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
            <button class="edit-btn" aria-label="Edit" title="Edit Memo">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="alarm-btn ${memo.alarm ? 'active' : ''}" aria-label="Alarm" title="Set Alarm">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            </button>
            <button class="archive-btn" aria-label="Archive" title="Archive Note">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"></path><polyline points="1 3 23 3 23 8 1 8 1 3"></polyline><path d="M10 12h4"></path></svg>
            </button>
            <button class="delete-btn" aria-label="Delete" title="Remove Task Forever">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff4d4d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
            </button>
        `;

        li.querySelector('input').addEventListener('change', (event) => {
            event.stopPropagation();
            toggleMemo(index);
        });
        li.querySelector('.top-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            moveToTop(index);
        });
        li.querySelector('.edit-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            openEditModal(index);
        });
        li.querySelector('.alarm-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            openAlarmModal(index);
        });
        li.querySelector('.archive-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            openArchiveInput(index);
        });
        li.querySelector('.delete-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            deleteMemo(index);
        });

        memoList.appendChild(li);
    });
}

function addMemo() {
    const text = memoInput.value.trim();
    if (text === '') return;

    if (!Array.isArray(allMemos[selectedDate])) {
        allMemos[selectedDate] = [];
    }

    if (hasMemoWithSameContent(selectedDate, text)) {
        memoInput.focus();
        return;
    }

    allMemos[selectedDate].unshift(createMemo(text, selectedDate));
    sortMemos(true);
    updateStats();
    memoInput.value = '';
}

function toggleMemo(index) {
    if (!Array.isArray(allMemos[selectedDate]) || !allMemos[selectedDate][index]) return;

    allMemos[selectedDate][index].completed = !allMemos[selectedDate][index].completed;
    allMemos[selectedDate][index].updatedAt = nowIso();
    updateStats();
    sortMemos(true);
}

function moveToTop(index) {
    if (!Array.isArray(allMemos[selectedDate]) || !allMemos[selectedDate][index]) return;

    const now = nowIso();
    allMemos[selectedDate][index].createdAt = now;
    allMemos[selectedDate][index].updatedAt = now;
    sortMemos(true);
}

function deleteMemo(index) {
    if (!Array.isArray(allMemos[selectedDate]) || !allMemos[selectedDate][index]) {
        log(`Delete failed: Index ${index} not found on ${selectedDate}`);
        return;
    }

    const target = allMemos[selectedDate][index];
    const targetOriginId = getMemoLineageKey(target);
    removeMemoLineageForever(targetOriginId);

    log(`SCRUBBED FOREVER: ${target.text}`);
    persistPermanentMemoRemoval();
}

function clearCompleted() {
    if (!Array.isArray(allMemos[selectedDate])) return;
    allMemos[selectedDate]
        .filter((memo) => memo.completed)
        .forEach((memo) => addMemoTombstone(getMemoLineageKey(memo)));
    allMemos[selectedDate] = allMemos[selectedDate].filter((memo) => !memo.completed);
    saveMemoTombstones();
    saveMemos();
    renderMemos();
    updateStats();
}

function openEditModal(index) {
    currentEditItemIndex = index;
    const memo = allMemos[selectedDate][index];
    editMemoInput.value = memo.text;
    openModal(editModal, editMemoInput);
}

function closeEditModal() {
    closeModal(editModal);
    currentEditItemIndex = null;
}

function confirmEdit() {
    if (currentEditItemIndex === null) return;
    const newText = editMemoInput.value.trim();

    if (newText === '') {
        if (confirm('메모 내용이 비어 있습니다. 이 메모를 삭제할까요?')) {
            removeMemoLineageForever(getMemoLineageKey(allMemos[selectedDate][currentEditItemIndex]));
            persistPermanentMemoRemoval();
            closeEditModal();
        }
        return;
    }

    if (hasMemoWithSameContent(selectedDate, newText, allMemos[selectedDate][currentEditItemIndex].id)) {
        editMemoInput.focus();
        return;
    }

    allMemos[selectedDate][currentEditItemIndex].text = newText;
    allMemos[selectedDate][currentEditItemIndex].updatedAt = nowIso();
    saveMemos();
    renderMemos();
    closeEditModal();
}

function openArchiveInput(index) {
    currentArchiveItemIndex = index;
    const memo = allMemos[selectedDate][index];
    archiveTaskText.textContent = memo.text;
    archiveMemoInput.value = '';
    openModal(archiveInputModal, archiveMemoInput);
}

function closeArchiveInput() {
    closeModal(archiveInputModal);
    currentArchiveItemIndex = null;
}

function confirmArchive() {
    if (currentArchiveItemIndex === null) return;

    const memo = allMemos[selectedDate][currentArchiveItemIndex];
    const archiveText = archiveMemoInput.value.trim();
    const timestamp = nowIso();

    archivedMemos.push({
        id: memo.id,
        originId: getMemoLineageKey(memo),
        taskText: memo.text,
        archiveMemo: archiveText,
        archivedAt: timestamp,
        updatedAt: timestamp
    });

    removeMemoLineageForever(getMemoLineageKey(memo));

    saveMemoTombstones();
    saveMemos();
    saveArchivedMemos();
    renderMemos();
    updateStats();
    closeArchiveInput();
}

function saveArchivedMemos() {
    applyArchiveTombstones();
    writeLocalStorage('archivedMemos', archivedMemos);

    if (!firebaseEnabled || !db) {
        return;
    }

    if (!hasInitialSyncResolved) {
        pendingArchiveSync = true;
        return;
    }

    syncRef('archivedMemos').set(archivedMemos).then(() => {
        setSyncStatus('online', 'Sync connected');
    }).catch((error) => {
        pendingArchiveSync = true;
        handleSyncError('Archive sync failed', error);
    });
}

function openArchiveView() {
    archiveList.innerHTML = '';
    const sortedArchives = [...archivedMemos].sort((a, b) => new Date(a.archivedAt) - new Date(b.archivedAt));

    if (sortedArchives.length === 0) {
        archiveList.innerHTML = '<li style="text-align: center; color: var(--text-muted); padding: 20px;">No archived items yet.</li>';
    } else {
        sortedArchives.forEach((item) => {
            const dateStr = new Date(item.archivedAt).toLocaleString('ko-KR', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });

            const li = document.createElement('li');
            li.className = 'archive-item';

            let memoHtml = '';
            if (item.archiveMemo) {
                memoHtml = `<div class="archive-memo">${escapeHtml(item.archiveMemo).replace(/\n/g, '<br>')}</div>`;
            }

            li.innerHTML = `
                <div class="archive-date">${dateStr}</div>
                <div class="archive-task">${escapeHtml(item.taskText)}</div>
                ${memoHtml}
                <button class="delete-btn archive-delete" aria-label="Delete Archive" title="Permanently Delete">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            `;

            const originalIndex = archivedMemos.findIndex((archive) => archive.id === item.id);
            li.querySelector('.archive-delete').addEventListener('click', () => deleteArchivedMemo(originalIndex));

            archiveList.appendChild(li);
        });
    }

    openModal(archiveViewModal, closeArchiveViewBtn);
}

function deleteArchivedMemo(index) {
    if (index < 0 || !archivedMemos[index]) return;

    if (confirm('이 보관 기록을 영구적으로 삭제할까요?')) {
        addArchiveTombstone(archivedMemos[index].id);
        archivedMemos.splice(index, 1);
        saveArchiveTombstones();
        saveArchivedMemos();
        openArchiveView();
    }
}

function closeArchiveView() {
    closeModal(archiveViewModal);
}

function openAlarmModal(index) {
    currentAlarmItemIndex = index;
    const memo = allMemos[selectedDate][index];
    alarmTaskText.textContent = memo.text;

    if (memo.alarm) {
        alarmDateTime.value = toKSTDateTimeValue(memo.alarm.time);
        alarmRepeat.checked = memo.alarm.repeat;
        repeatInterval.value = memo.alarm.interval || 60;
        repeatUntil.value = memo.alarm.until ? toKSTDateTimeValue(memo.alarm.until) : '';
        removeAlarmBtn.classList.remove('hidden');
    } else {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 5);
        now.setSeconds(0);
        now.setMilliseconds(0);
        alarmDateTime.value = toKSTDateTimeValue(now);
        alarmRepeat.checked = false;
        repeatInterval.value = 60;
        repeatUntil.value = '';
        removeAlarmBtn.classList.add('hidden');
    }

    toggleRepeatOptions();
    openModal(alarmModal, alarmDateTime);
}

function closeAlarmModal() {
    closeModal(alarmModal);
    currentAlarmItemIndex = null;
}

function toggleRepeatOptions() {
    if (alarmRepeat.checked) {
        repeatOptions.classList.remove('hidden');
    } else {
        repeatOptions.classList.add('hidden');
    }
}

function saveAlarm() {
    if (currentAlarmItemIndex === null) return;

    const timeValue = alarmDateTime.value;
    if (!timeValue) {
        alert("Please select a date and time.");
        return;
    }

    allMemos[selectedDate][currentAlarmItemIndex].alarm = {
        time: kstDateTimeValueToIso(timeValue),
        repeat: alarmRepeat.checked,
        interval: Math.max(1, parseInt(repeatInterval.value, 10) || 60),
        until: repeatUntil.value ? kstDateTimeValueToIso(repeatUntil.value) : ''
    };
    allMemos[selectedDate][currentAlarmItemIndex].updatedAt = nowIso();

    saveMemos();
    renderMemos();
    closeAlarmModal();
}

function removeAlarm() {
    if (currentAlarmItemIndex === null) return;
    delete allMemos[selectedDate][currentAlarmItemIndex].alarm;
    allMemos[selectedDate][currentAlarmItemIndex].updatedAt = nowIso();
    saveMemos();
    renderMemos();
    closeAlarmModal();
}

function startAlarmChecker() {
    if (alarmCheckInterval) clearInterval(alarmCheckInterval);
    alarmCheckInterval = setInterval(checkAlarms, 10000);
}

function checkAlarms() {
    const now = new Date();

    Object.keys(allMemos).forEach((dateKey) => {
        const bucket = Array.isArray(allMemos[dateKey]) ? allMemos[dateKey] : [];

        bucket.forEach((memo) => {
            if (!memo.completed && memo.alarm) {
                const alarmTime = new Date(memo.alarm.time);
                if (now >= alarmTime) {
                    showToast(memo.text);

                    if (memo.alarm.repeat) {
                        const nextTime = advanceAlarmToFuture(alarmTime, memo.alarm.interval, now);
                        const untilTime = memo.alarm.until ? new Date(memo.alarm.until) : null;

                        if (!untilTime || nextTime <= untilTime) {
                            memo.alarm.time = nextTime.toISOString();
                            memo.updatedAt = nowIso();
                        } else {
                            delete memo.alarm;
                            memo.updatedAt = nowIso();
                        }
                    } else {
                        delete memo.alarm;
                        memo.updatedAt = nowIso();
                    }

                    saveMemos();
                    if (dateKey === selectedDate) renderMemos();
                }
            }
        });
    });
}

function showToast(text) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <button class="toast-close">&times;</button>
        <div class="toast-header">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            REMINDER
        </div>
        <div class="toast-content">${escapeHtml(text)}</div>
    `;

    toast.querySelector('.toast-close').onclick = (event) => {
        event.stopPropagation();
        removeToast(toast);
    };

    toast.onclick = () => removeToast(toast);
    toastContainer.appendChild(toast);
    setTimeout(() => removeToast(toast), 10000);
}

function removeToast(toast) {
    toast.classList.add('hidden');
    setTimeout(() => {
        if (toast.parentElement) {
            toast.parentElement.removeChild(toast);
        }
    }, 500);
}

function sortMemos(shouldSave = false) {
    if (!Array.isArray(allMemos[selectedDate])) return;
    sortMemoBucket(selectedDate);
    if (shouldSave) saveMemos();
    renderMemos();
}

function saveMemos() {
    stabilizeMemoMap(allMemos);
    applyMemoTombstones(allMemos);
    writeLocalStorage('allMemos', allMemos);

    if (!firebaseEnabled || !db) {
        return;
    }

    if (!hasInitialSyncResolved) {
        pendingMemoSync = true;
        return;
    }

    syncRef('allMemos').set(allMemos).then(() => {
        setSyncStatus('online', 'Sync connected');
    }).catch((error) => {
        pendingMemoSync = true;
        handleSyncError('Memo sync failed', error);
    });
}

function saveMemoTombstones() {
    writeLocalStorage('memoTombstones', memoTombstones);

    if (!firebaseEnabled || !db) {
        return;
    }

    if (!hasInitialSyncResolved) {
        pendingMemoTombstoneSync = true;
        return;
    }

    syncRef('memoTombstones').set(memoTombstones).then(() => {
        setSyncStatus('online', 'Sync connected');
    }).catch((error) => {
        pendingMemoTombstoneSync = true;
        handleSyncError('Memo deletion sync failed', error);
    });
}

function saveArchiveTombstones() {
    writeLocalStorage('archiveTombstones', archiveTombstones);

    if (!firebaseEnabled || !db) {
        return;
    }

    if (!hasInitialSyncResolved) {
        pendingArchiveTombstoneSync = true;
        return;
    }

    syncRef('archiveTombstones').set(archiveTombstones).then(() => {
        setSyncStatus('online', 'Sync connected');
    }).catch((error) => {
        pendingArchiveTombstoneSync = true;
        handleSyncError('Archive deletion sync failed', error);
    });
}

function updateStats() {
    const dailyMemos = Array.isArray(allMemos[selectedDate]) ? allMemos[selectedDate] : [];
    const active = dailyMemos.filter((memo) => !memo.completed).length;
    activeCount.textContent = active;
}

function changeDate(days) {
    const date = new Date(`${selectedDate}T00:00:00+09:00`);
    date.setUTCDate(date.getUTCDate() + days);
    selectedDate = getKSTDateString(date);
    carryOverIncompleteTasks(selectedDate);
    updateDateDisplay();
    renderMemos();
    updateStats();
}

function setupDragAndDrop() {
    let dragSrcEl = null;

    memoList.addEventListener('dragstart', (event) => {
        const target = event.target.closest('.memo-item');
        if (!target) return;
        dragSrcEl = target;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', target.dataset.index);
        setTimeout(() => target.classList.add('dragging'), 0);
    });

    memoList.addEventListener('dragover', (event) => {
        event.preventDefault();
        const target = event.target.closest('.memo-item');
        if (target && target !== dragSrcEl) {
            target.classList.add('drag-over');
        }
    });

    memoList.addEventListener('dragleave', (event) => {
        const target = event.target.closest('.memo-item');
        if (target) {
            target.classList.remove('drag-over');
        }
    });

    memoList.addEventListener('drop', (event) => {
        event.preventDefault();
        const target = event.target.closest('.memo-item');
        if (target && dragSrcEl !== target) {
            const fromIndex = parseInt(dragSrcEl.dataset.index, 10);
            const toIndex = parseInt(target.dataset.index, 10);
            const dailyMemos = allMemos[selectedDate];
            const [movedItem] = dailyMemos.splice(fromIndex, 1);
            dailyMemos.splice(toIndex, 0, movedItem);
            saveMemos();
            renderMemos();
        }
    });

    memoList.addEventListener('dragend', () => {
        document.querySelectorAll('.memo-item').forEach((item) => {
            item.classList.remove('dragging', 'drag-over');
        });
    });
}

function scheduleMidnightRefresh() {
    if (midnightRefreshTimer) {
        clearTimeout(midnightRefreshTimer);
    }

    midnightRefreshTimer = setTimeout(() => {
        selectedDate = getKSTDateString(new Date());
        carryOverIncompleteTasks();
        updateDateDisplay();
        renderMemos();
        updateStats();
        scheduleMidnightRefresh();
    }, getMsUntilNextKSTMidnight());
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function openModal(modal, focusTarget) {
    lastFocusedElement = document.activeElement;
    activeModal = modal;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    if (focusTarget) {
        focusTarget.focus();
    }
}

function closeModal(modal) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');

    if (activeModal === modal) {
        activeModal = null;
    }

    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
        lastFocusedElement.focus();
    }
}

function closeActiveModal() {
    if (activeModal === archiveInputModal) closeArchiveInput();
    if (activeModal === archiveViewModal) closeArchiveView();
    if (activeModal === alarmModal) closeAlarmModal();
    if (activeModal === editModal) closeEditModal();
}

function trapModalFocus(event) {
    if (!activeModal || event.key !== 'Tab') return;

    const focusableElements = activeModal.querySelectorAll(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
    );
    const focusable = Array.from(focusableElements).filter((element) => !element.disabled);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function handleGlobalKeydown(event) {
    if (event.key === 'Escape' && activeModal) {
        event.preventDefault();
        closeActiveModal();
        return;
    }

    trapModalFocus(event);
}

function readStoredJSON(key, fallbackValue) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallbackValue;
        return JSON.parse(raw);
    } catch (error) {
        console.warn(`[MemoApp] Failed to parse ${key}. Resetting local cache.`, error);
        return fallbackValue;
    }
}

function writeLocalStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.warn(`[MemoApp] Failed to persist ${key}.`, error);
        setSyncStatus('error', 'Storage issue detected');
    }
}

function nowIso() {
    return new Date().toISOString();
}

function createId(seed = '') {
    if (window.crypto && typeof window.crypto.randomUUID === 'function' && !seed) {
        return window.crypto.randomUUID();
    }

    const randomPart = Math.random().toString(36).slice(2, 10);
    const timePart = Date.now().toString(36);
    return `memo-${seed || timePart}-${randomPart}`;
}

function hashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function isValidIsoString(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function normalizeAlarm(alarm) {
    if (!alarm || typeof alarm !== 'object' || !alarm.time) return null;

    const time = normalizeAlarmDateTime(alarm.time);
    const until = alarm.until ? normalizeAlarmDateTime(alarm.until) : '';
    if (!time) return null;

    return {
        time,
        repeat: Boolean(alarm.repeat),
        interval: Math.max(1, parseInt(alarm.interval, 10) || 60),
        until
    };
}

function getLegacyMemoId(memo, dateKey, index) {
    const createdAt = isValidIsoString(memo?.createdAt) ? memo.createdAt : `${dateKey || 'unknown'}T00:00:00.000Z`;
    const seed = `${dateKey || 'unknown'}|${memo?.text || ''}|${createdAt}|${memo?.carriedFrom || ''}`;
    return `legacy-${hashString(seed)}`;
}

function normalizeMemo(memo, dateKey, index) {
    const base = memo && typeof memo === 'object' ? memo : {};
    const createdAt = isValidIsoString(base.createdAt) ? base.createdAt : `${dateKey || 'unknown'}T00:00:00.000Z`;
    const id = typeof base.id === 'string' && base.id ? base.id : getLegacyMemoId(base, dateKey, index);
    const originId = typeof base.originId === 'string' && base.originId ? base.originId : id;
    const normalized = {
        ...base,
        id,
        originId,
        text: typeof base.text === 'string' ? base.text : '',
        completed: Boolean(base.completed),
        createdAt,
        updatedAt: isValidIsoString(base.updatedAt) ? base.updatedAt : createdAt
    };

    const alarm = normalizeAlarm(base.alarm);
    if (alarm) {
        normalized.alarm = alarm;
    } else {
        delete normalized.alarm;
    }

    return normalized;
}

function normalizeMemoMap(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {};
    }

    const normalized = {};

    Object.entries(data).forEach(([dateKey, bucket]) => {
        if (!Array.isArray(bucket)) {
            normalized[dateKey] = [];
            return;
        }

        normalized[dateKey] = bucket
            .map((memo, index) => normalizeMemo(memo, dateKey, index))
            .filter((memo) => memo.text !== '');
        sortMemoBucket(dateKey, normalized);
    });

    return normalized;
}

function normalizeArchiveItem(item, index) {
    const base = item && typeof item === 'object' ? item : {};
    const archivedAt = isValidIsoString(base.archivedAt) ? base.archivedAt : nowIso();
    const id = typeof base.id === 'string' && base.id ? base.id : `archive-${hashString(`${base.taskText || ''}|${archivedAt}|${index}`)}`;

    return {
        ...base,
        id,
        originId: typeof base.originId === 'string' && base.originId ? base.originId : id,
        taskText: typeof base.taskText === 'string' ? base.taskText : '',
        archiveMemo: typeof base.archiveMemo === 'string' ? base.archiveMemo : '',
        archivedAt,
        updatedAt: isValidIsoString(base.updatedAt) ? base.updatedAt : archivedAt
    };
}

function normalizeArchiveCollection(data) {
    if (!Array.isArray(data)) return [];
    return data
        .map((item, index) => normalizeArchiveItem(item, index))
        .filter((item) => item.taskText !== '');
}

function normalizeTombstoneMap(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {};
    }

    return Object.entries(data).reduce((normalized, [key, timestamp]) => {
        if (typeof key === 'string' && key && isValidIsoString(timestamp)) {
            normalized[key] = timestamp;
        }
        return normalized;
    }, {});
}

function getMemoLineageKey(memo) {
    return memo?.originId || memo?.id || '';
}

function getMemoContentKey(value) {
    const text = typeof value === 'string' ? value : value?.text;
    return typeof text === 'string' ? text.trim() : '';
}

function hasMemoWithSameContent(dateKey, text, excludedMemoId = '') {
    const contentKey = getMemoContentKey(text);
    if (!contentKey || !Array.isArray(allMemos[dateKey])) return false;

    return allMemos[dateKey].some((memo) => {
        if (excludedMemoId && memo.id === excludedMemoId) return false;
        return getMemoContentKey(memo) === contentKey;
    });
}

function addMemoTombstone(lineageKey) {
    if (!lineageKey) return;
    memoTombstones[lineageKey] = nowIso();
}

function addArchiveTombstone(archiveId) {
    if (!archiveId) return;
    archiveTombstones[archiveId] = nowIso();
}

function mergeTombstoneMaps(remoteMap, localMap) {
    const merged = { ...remoteMap };

    Object.entries(localMap).forEach(([key, localTimestamp]) => {
        const remoteTimestamp = merged[key];
        if (!remoteTimestamp || Date.parse(localTimestamp) >= Date.parse(remoteTimestamp)) {
            merged[key] = localTimestamp;
        }
    });

    return merged;
}

function applyMemoTombstones(sourceMap) {
    if (!sourceMap || typeof sourceMap !== 'object') {
        return false;
    }

    let changed = false;

    Object.keys(sourceMap).forEach((dateKey) => {
        const bucket = Array.isArray(sourceMap[dateKey]) ? sourceMap[dateKey] : [];
        const filteredBucket = bucket.filter((memo) => !memoTombstones[getMemoLineageKey(memo)]);

        if (filteredBucket.length !== bucket.length) {
            sourceMap[dateKey] = filteredBucket;
            changed = true;
        }
    });

    return changed;
}

function removeMemoLineageForever(lineageKey) {
    if (!lineageKey) return false;

    addMemoTombstone(lineageKey);
    let changed = false;

    Object.keys(allMemos).forEach((dateKey) => {
        const bucket = Array.isArray(allMemos[dateKey]) ? allMemos[dateKey] : [];
        const filteredBucket = bucket.filter((memo) => getMemoLineageKey(memo) !== lineageKey);
        if (filteredBucket.length !== bucket.length) {
            allMemos[dateKey] = filteredBucket;
            changed = true;
        }
    });

    return changed;
}

function persistPermanentMemoRemoval() {
    saveMemoTombstones();
    saveMemos();
    renderMemos();
    updateStats();
}

function filterArchivesWithTombstones(items) {
    return items.filter((item) => !archiveTombstones[item.id]);
}

function applyArchiveTombstones() {
    const filteredArchives = filterArchivesWithTombstones(archivedMemos);
    const changed = filteredArchives.length !== archivedMemos.length;
    archivedMemos = filteredArchives;
    return changed;
}

function isLegacyLineageId(value) {
    return typeof value === 'string' && value.startsWith('legacy-');
}

function createCanonicalLegacyOriginId(memo, dateKey, index) {
    const seed = `${memo?.text || ''}|${memo?.createdAt || ''}|${dateKey || ''}`;
    return `legacy-origin-${hashString(seed)}`;
}

function compareMemoChronology(a, b) {
    const createdDiff = new Date(a.createdAt) - new Date(b.createdAt);
    if (createdDiff !== 0) return createdDiff;

    const updatedDiff = new Date(a.updatedAt) - new Date(b.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;

    return String(a.id).localeCompare(String(b.id));
}

function dedupeMemoMapByLineage(sourceMap) {
    let changed = false;

    Object.keys(sourceMap).forEach((dateKey) => {
        const bucket = Array.isArray(sourceMap[dateKey]) ? sourceMap[dateKey] : [];
        const bucketByLineage = new Map();

        bucket.forEach((memo) => {
            const lineageKey = getMemoLineageKey(memo) || memo.id;
            bucketByLineage.set(lineageKey, chooseLatest(bucketByLineage.get(lineageKey), memo));
        });

        const dedupedBucket = Array.from(bucketByLineage.values());
        sortMemoBucket(dateKey, { [dateKey]: dedupedBucket });

        if (dedupedBucket.length !== bucket.length || JSON.stringify(dedupedBucket) !== JSON.stringify(bucket)) {
            sourceMap[dateKey] = dedupedBucket;
            changed = true;
        }
    });

    return changed;
}

function dedupeMemoMapByContent(sourceMap) {
    let changed = false;

    Object.keys(sourceMap).forEach((dateKey) => {
        const bucket = Array.isArray(sourceMap[dateKey]) ? sourceMap[dateKey] : [];
        const bucketByContent = new Map();

        bucket.forEach((memo) => {
            const contentKey = getMemoContentKey(memo);
            if (!contentKey) return;
            bucketByContent.set(contentKey, chooseLatest(bucketByContent.get(contentKey), memo));
        });

        const dedupedBucket = Array.from(bucketByContent.values());
        sortMemoBucket(dateKey, { [dateKey]: dedupedBucket });

        if (dedupedBucket.length !== bucket.length || JSON.stringify(dedupedBucket) !== JSON.stringify(bucket)) {
            sourceMap[dateKey] = dedupedBucket;
            changed = true;
        }
    });

    return changed;
}

function stabilizeMemoMap(sourceMap) {
    if (!sourceMap || typeof sourceMap !== 'object') {
        return false;
    }

    let changed = false;
    const sortedDates = Object.keys(sourceMap).sort();

    sortedDates.forEach((dateKey) => {
        const bucket = Array.isArray(sourceMap[dateKey]) ? sourceMap[dateKey] : [];

        bucket.forEach((memo, index) => {
            if (!memo.carriedFrom && isLegacyLineageId(memo.originId)) {
                const canonicalOriginId = createCanonicalLegacyOriginId(memo, dateKey, index);
                if (memo.originId !== canonicalOriginId) {
                    memo.originId = canonicalOriginId;
                    changed = true;
                }
            }
        });

        const carryGroups = new Map();
        bucket.forEach((memo, index) => {
            if (!memo.carriedFrom || !isLegacyLineageId(memo.originId)) {
                return;
            }

            const groupKey = `${memo.carriedFrom}\u0000${memo.text}`;
            if (!carryGroups.has(groupKey)) {
                carryGroups.set(groupKey, []);
            }

            carryGroups.get(groupKey).push({ memo, index });
        });

        carryGroups.forEach((entries, groupKey) => {
            const [sourceDate, text] = groupKey.split('\u0000');
            const sourceBucket = Array.isArray(sourceMap[sourceDate]) ? sourceMap[sourceDate] : [];
            const sourceCandidates = sourceBucket
                .filter((memo) => memo.text === text)
                .slice()
                .sort(compareMemoChronology);

            entries
                .slice()
                .sort((left, right) => compareMemoChronology(left.memo, right.memo))
                .forEach((entry, index) => {
                    const sourceMemo = sourceCandidates[Math.min(index, sourceCandidates.length - 1)];
                    const nextOriginId = sourceMemo
                        ? getMemoLineageKey(sourceMemo)
                        : createCanonicalLegacyOriginId(entry.memo, dateKey, entry.index);

                    if (entry.memo.originId !== nextOriginId) {
                        entry.memo.originId = nextOriginId;
                        changed = true;
                    }
                });
        });
    });

    const dedupedByLineage = dedupeMemoMapByLineage(sourceMap);
    const dedupedByContent = dedupeMemoMapByContent(sourceMap);
    return dedupedByLineage || dedupedByContent || changed;
}

function chooseLatest(remoteItem, localItem) {
    if (!remoteItem) return localItem;
    if (!localItem) return remoteItem;

    const remoteTime = Date.parse(remoteItem.updatedAt || remoteItem.createdAt || remoteItem.archivedAt || 0);
    const localTime = Date.parse(localItem.updatedAt || localItem.createdAt || localItem.archivedAt || 0);
    return localTime >= remoteTime ? localItem : remoteItem;
}

function mergeMemoMaps(remoteMap, localMap) {
    const merged = {};
    const allDates = new Set([...Object.keys(remoteMap), ...Object.keys(localMap)]);

    allDates.forEach((dateKey) => {
        const bucketById = new Map();
        const remoteBucket = Array.isArray(remoteMap[dateKey]) ? remoteMap[dateKey] : [];
        const localBucket = Array.isArray(localMap[dateKey]) ? localMap[dateKey] : [];

        remoteBucket.forEach((memo) => bucketById.set(memo.id, memo));
        localBucket.forEach((memo) => bucketById.set(memo.id, chooseLatest(bucketById.get(memo.id), memo)));

        merged[dateKey] = Array.from(bucketById.values());
        sortMemoBucket(dateKey, merged);
    });

    stabilizeMemoMap(merged);
    return merged;
}

function mergeArchiveCollections(remoteItems, localItems) {
    const archiveById = new Map();
    remoteItems.forEach((item) => archiveById.set(item.id, item));
    localItems.forEach((item) => archiveById.set(item.id, chooseLatest(archiveById.get(item.id), item)));
    return Array.from(archiveById.values()).sort((a, b) => new Date(a.archivedAt) - new Date(b.archivedAt));
}

function createMemo(text) {
    const timestamp = nowIso();
    const id = createId();
    return {
        id,
        originId: id,
        text,
        completed: false,
        createdAt: timestamp,
        updatedAt: timestamp
    };
}

function createCarriedMemo(sourceMemo, carriedFromDate) {
    const timestamp = nowIso();
    return {
        ...sourceMemo,
        id: createId(),
        originId: getMemoLineageKey(sourceMemo),
        completed: false,
        carriedFrom: carriedFromDate,
        createdAt: timestamp,
        updatedAt: timestamp,
        alarm: sourceMemo.alarm ? { ...sourceMemo.alarm } : undefined
    };
}

function sortMemoBucket(dateKey, sourceMap = allMemos) {
    if (!Array.isArray(sourceMap[dateKey])) return;

    sourceMap[dateKey].sort((a, b) => {
        if (a.completed !== b.completed) {
            return a.completed ? 1 : -1;
        }
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
}

function setSyncStatus(mode, text) {
    if (!syncStatus) return;
    syncStatus.textContent = text;
    syncStatus.dataset.mode = mode;
}

function handleSyncError(message, error) {
    syncHadError = true;
    console.warn(`[MemoApp] ${message}`, error);
    setSyncStatus('error', 'Sync issue - local mode active');
}

function getKSTDateParts(date) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const getValue = (type) => parts.find((part) => part.type === type)?.value;

    return {
        year: parseInt(getValue('year'), 10),
        month: parseInt(getValue('month'), 10),
        day: parseInt(getValue('day'), 10)
    };
}

function getKSTDayIndex(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        weekday: 'short'
    }).format(utcDate);
    const weekdayMap = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6
    };
    return weekdayMap[weekday];
}

function normalizeAlarmDateTime(value) {
    if (typeof value !== 'string' || !value) return '';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
        return kstDateTimeValueToIso(value);
    }
    if (isValidIsoString(value)) {
        return new Date(value).toISOString();
    }
    return '';
}

function kstDateTimeValueToIso(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) return '';

    const [, year, month, day, hour, minute] = match.map(Number);
    const utcMs = Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0);
    return new Date(utcMs).toISOString();
}

function toKSTDateTimeValue(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(date);
    const getValue = (type) => parts.find((part) => part.type === type)?.value;

    return `${getValue('year')}-${getValue('month')}-${getValue('day')}T${getValue('hour')}:${getValue('minute')}`;
}

function getMsUntilNextKSTMidnight() {
    const now = new Date();
    const parts = getKSTDateParts(now);
    const nextMidnightUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 15, 0, 0, 0);
    return Math.max(1000, nextMidnightUtc - now.getTime());
}

function advanceAlarmToFuture(alarmTime, intervalMinutes, now) {
    const intervalMs = Math.max(1, intervalMinutes) * 60000;
    let nextTime = new Date(alarmTime.getTime() + intervalMs);

    while (nextTime <= now) {
        nextTime = new Date(nextTime.getTime() + intervalMs);
    }

    return nextTime;
}

function getMemoIndexById(dateKey, memoId) {
    if (!memoId || !Array.isArray(allMemos[dateKey])) return -1;
    return allMemos[dateKey].findIndex((memo) => memo.id === memoId);
}

function getMemoOrderValue(memo, fallbackValue) {
    const value = Number(memo?.sortOrder);
    return Number.isFinite(value) ? value : fallbackValue;
}

function getMemoFallbackOrderFromTime(memo) {
    const createdAt = Date.parse(memo?.createdAt || 0);
    if (!Number.isNaN(createdAt)) return -createdAt;
    const updatedAt = Date.parse(memo?.updatedAt || 0);
    return Number.isNaN(updatedAt) ? 0 : -updatedAt;
}

function compareMemoRecentDesc(left, right) {
    const createdDiff = new Date(right.createdAt) - new Date(left.createdAt);
    if (createdDiff !== 0) return createdDiff;

    const updatedDiff = new Date(right.updatedAt) - new Date(left.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;

    return String(left.id).localeCompare(String(right.id));
}

function getNextTopOrder(bucket) {
    if (!Array.isArray(bucket) || bucket.length === 0) return 1024;

    let minOrder = Number.POSITIVE_INFINITY;
    bucket.forEach((memo, index) => {
        const fallback = getMemoFallbackOrderFromTime(memo) || (index + 1) * 1024;
        const order = getMemoOrderValue(memo, fallback);
        if (order < minOrder) minOrder = order;
    });

    if (!Number.isFinite(minOrder)) return 1024;
    return minOrder - 1024;
}

function normalizeBucketOrder(dateKey, touchUpdatedAt = false) {
    if (!Array.isArray(allMemos[dateKey])) return;

    const timestamp = touchUpdatedAt ? nowIso() : null;
    allMemos[dateKey].forEach((memo, index) => {
        memo.sortOrder = (index + 1) * 1024;
        if (touchUpdatedAt) {
            memo.updatedAt = timestamp;
        }
    });
}

function resetDailyOrderByRecency(dateKey) {
    if (!Array.isArray(allMemos[dateKey])) return;

    allMemos[dateKey].sort((left, right) => {
        if (left.completed !== right.completed) {
            return left.completed ? 1 : -1;
        }
        return compareMemoRecentDesc(left, right);
    });

    normalizeBucketOrder(dateKey, true);
}

function updateDateDisplay() {
    dateText.textContent = formatDateDisplay(selectedDate);

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayIndex = getKSTDayIndex(selectedDate);
    dayText.textContent = days[dayIndex];

    dayText.className = 'day-of-week';
    if (dayIndex === 0) dayText.classList.add('sunday');
    if (dayIndex === 6) dayText.classList.add('saturday');
    if (dayIndex === 5) dayText.classList.add('friday');

    datePicker.value = selectedDate;
}

function renderMemos() {
    memoList.innerHTML = '';
    const dailyMemos = Array.isArray(allMemos[selectedDate]) ? allMemos[selectedDate] : [];

    dailyMemos.forEach((memo, index) => {
        const li = document.createElement('li');
        li.className = `memo-item ${memo.completed ? 'completed' : ''}`;
        li.setAttribute('draggable', 'true');
        li.dataset.index = index;
        li.dataset.memoId = memo.id;

        li.innerHTML = `
            <label class="checkbox-container">
                <input type="checkbox" ${memo.completed ? 'checked' : ''}>
                <span class="checkmark"></span>
            </label>
            <span class="memo-text">${escapeHtml(memo.text)}</span>
            <button class="top-btn" aria-label="Move to Top" title="Move to Top">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
            <button class="edit-btn" aria-label="Edit" title="Edit Memo">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="alarm-btn ${memo.alarm ? 'active' : ''}" aria-label="Alarm" title="Set Alarm">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            </button>
            <button class="archive-btn" aria-label="Archive" title="Archive Note">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"></path><polyline points="1 3 23 3 23 8 1 8 1 3"></polyline><path d="M10 12h4"></path></svg>
            </button>
            <button class="delete-btn" aria-label="Delete" title="Remove Task Forever">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff4d4d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
            </button>
        `;

        li.querySelector('input').addEventListener('change', (event) => {
            event.stopPropagation();
            toggleMemo(memo.id);
        });
        li.querySelector('.top-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            moveToTop(memo.id);
        });
        li.querySelector('.edit-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            openEditModal(memo.id);
        });
        li.querySelector('.alarm-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            openAlarmModal(memo.id);
        });
        li.querySelector('.archive-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            openArchiveInput(memo.id);
        });
        li.querySelector('.delete-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            deleteMemo(memo.id);
        });

        memoList.appendChild(li);
    });
}

function addMemo() {
    const text = memoInput.value.trim();
    if (text === '') return;

    if (!Array.isArray(allMemos[selectedDate])) {
        allMemos[selectedDate] = [];
    }

    if (hasMemoWithSameContent(selectedDate, text)) {
        memoInput.focus();
        return;
    }

    allMemos[selectedDate].push(createMemo(text, selectedDate));
    sortMemos(true);
    updateStats();
    memoInput.value = '';
}

function toggleMemo(memoId) {
    const index = getMemoIndexById(selectedDate, memoId);
    if (index < 0) return;

    allMemos[selectedDate][index].completed = !allMemos[selectedDate][index].completed;
    allMemos[selectedDate][index].updatedAt = nowIso();
    updateStats();
    sortMemos(true);
}

function moveToTop(memoId) {
    const index = getMemoIndexById(selectedDate, memoId);
    if (index < 0) return;

    allMemos[selectedDate][index].sortOrder = getNextTopOrder(allMemos[selectedDate]);
    allMemos[selectedDate][index].updatedAt = nowIso();
    sortMemos(true);
}

function deleteMemo(memoId) {
    const index = getMemoIndexById(selectedDate, memoId);
    if (index < 0) {
        log(`Delete failed: ID ${memoId} not found on ${selectedDate}`);
        return;
    }

    const target = allMemos[selectedDate][index];
    const targetOriginId = getMemoLineageKey(target);
    removeMemoLineageForever(targetOriginId);

    log(`SCRUBBED FOREVER: ${target.text}`);
    persistPermanentMemoRemoval();
}

function openEditModal(memoId) {
    const memoIndex = getMemoIndexById(selectedDate, memoId);
    if (memoIndex < 0) return;

    currentEditItemId = memoId;
    editMemoInput.value = allMemos[selectedDate][memoIndex].text;
    openModal(editModal, editMemoInput);
}

function closeEditModal() {
    closeModal(editModal);
    currentEditItemId = null;
}

function confirmEdit() {
    if (currentEditItemId === null) return;

    const memoIndex = getMemoIndexById(selectedDate, currentEditItemId);
    if (memoIndex < 0) {
        closeEditModal();
        return;
    }

    const newText = editMemoInput.value.trim();

    if (newText === '') {
        if (confirm('Memo is empty. Delete this memo?')) {
            removeMemoLineageForever(getMemoLineageKey(allMemos[selectedDate][memoIndex]));
            persistPermanentMemoRemoval();
            closeEditModal();
        }
        return;
    }

    if (hasMemoWithSameContent(selectedDate, newText, allMemos[selectedDate][memoIndex].id)) {
        editMemoInput.focus();
        return;
    }

    allMemos[selectedDate][memoIndex].text = newText;
    allMemos[selectedDate][memoIndex].updatedAt = nowIso();
    saveMemos();
    renderMemos();
    closeEditModal();
}

function openArchiveInput(memoId) {
    const memoIndex = getMemoIndexById(selectedDate, memoId);
    if (memoIndex < 0) return;

    currentArchiveItemId = memoId;
    archiveTaskText.textContent = allMemos[selectedDate][memoIndex].text;
    archiveMemoInput.value = '';
    openModal(archiveInputModal, archiveMemoInput);
}

function closeArchiveInput() {
    closeModal(archiveInputModal);
    currentArchiveItemId = null;
}

function confirmArchive() {
    if (currentArchiveItemId === null) return;

    const memoIndex = getMemoIndexById(selectedDate, currentArchiveItemId);
    if (memoIndex < 0) {
        closeArchiveInput();
        return;
    }

    const memo = allMemos[selectedDate][memoIndex];
    const archiveText = archiveMemoInput.value.trim();
    const timestamp = nowIso();

    archivedMemos.push({
        id: memo.id,
        originId: getMemoLineageKey(memo),
        taskText: memo.text,
        archiveMemo: archiveText,
        archivedAt: timestamp,
        updatedAt: timestamp
    });

    removeMemoLineageForever(getMemoLineageKey(memo));

    saveMemoTombstones();
    saveMemos();
    saveArchivedMemos();
    renderMemos();
    updateStats();
    closeArchiveInput();
}

function deleteArchivedMemo(index) {
    if (index < 0 || !archivedMemos[index]) return;

    if (confirm('Permanently delete this archive entry?')) {
        addArchiveTombstone(archivedMemos[index].id);
        archivedMemos.splice(index, 1);
        saveArchiveTombstones();
        saveArchivedMemos();
        openArchiveView();
    }
}

function openAlarmModal(memoId) {
    const memoIndex = getMemoIndexById(selectedDate, memoId);
    if (memoIndex < 0) return;

    currentAlarmItemId = memoId;
    const memo = allMemos[selectedDate][memoIndex];
    alarmTaskText.textContent = memo.text;

    if (memo.alarm) {
        alarmDateTime.value = toKSTDateTimeValue(memo.alarm.time);
        alarmRepeat.checked = memo.alarm.repeat;
        repeatInterval.value = memo.alarm.interval || 60;
        repeatUntil.value = memo.alarm.until ? toKSTDateTimeValue(memo.alarm.until) : '';
        removeAlarmBtn.classList.remove('hidden');
    } else {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 5);
        now.setSeconds(0);
        now.setMilliseconds(0);
        alarmDateTime.value = toKSTDateTimeValue(now);
        alarmRepeat.checked = false;
        repeatInterval.value = 60;
        repeatUntil.value = '';
        removeAlarmBtn.classList.add('hidden');
    }

    toggleRepeatOptions();
    openModal(alarmModal, alarmDateTime);
}

function closeAlarmModal() {
    closeModal(alarmModal);
    currentAlarmItemId = null;
}

function saveAlarm() {
    if (currentAlarmItemId === null) return;

    const memoIndex = getMemoIndexById(selectedDate, currentAlarmItemId);
    if (memoIndex < 0) {
        closeAlarmModal();
        return;
    }

    const timeValue = alarmDateTime.value;
    if (!timeValue) {
        alert('Please select a date and time.');
        return;
    }

    allMemos[selectedDate][memoIndex].alarm = {
        time: kstDateTimeValueToIso(timeValue),
        repeat: alarmRepeat.checked,
        interval: Math.max(1, parseInt(repeatInterval.value, 10) || 60),
        until: repeatUntil.value ? kstDateTimeValueToIso(repeatUntil.value) : ''
    };
    allMemos[selectedDate][memoIndex].updatedAt = nowIso();

    saveMemos();
    renderMemos();
    closeAlarmModal();
}

function removeAlarm() {
    if (currentAlarmItemId === null) return;

    const memoIndex = getMemoIndexById(selectedDate, currentAlarmItemId);
    if (memoIndex < 0) {
        closeAlarmModal();
        return;
    }

    delete allMemos[selectedDate][memoIndex].alarm;
    allMemos[selectedDate][memoIndex].updatedAt = nowIso();
    saveMemos();
    renderMemos();
    closeAlarmModal();
}

function sortMemos(shouldSave = false, resetByRecency = false) {
    if (!Array.isArray(allMemos[selectedDate])) return;

    if (resetByRecency) {
        resetDailyOrderByRecency(selectedDate);
    }

    sortMemoBucket(selectedDate);
    if (shouldSave) saveMemos();
    renderMemos();
}

function setupDragAndDrop() {
    let dragSrcEl = null;

    memoList.addEventListener('dragstart', (event) => {
        const target = event.target.closest('.memo-item');
        if (!target) return;
        dragSrcEl = target;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', target.dataset.memoId || '');
        setTimeout(() => target.classList.add('dragging'), 0);
    });

    memoList.addEventListener('dragover', (event) => {
        event.preventDefault();
        const target = event.target.closest('.memo-item');
        if (target && target !== dragSrcEl) {
            target.classList.add('drag-over');
        }
    });

    memoList.addEventListener('dragleave', (event) => {
        const target = event.target.closest('.memo-item');
        if (target) {
            target.classList.remove('drag-over');
        }
    });

    memoList.addEventListener('drop', (event) => {
        event.preventDefault();
        const target = event.target.closest('.memo-item');
        if (!target || dragSrcEl === target) return;

        const sourceMemoId = event.dataTransfer.getData('text/plain') || dragSrcEl?.dataset.memoId || '';
        const targetMemoId = target.dataset.memoId || '';
        if (!sourceMemoId || !targetMemoId || sourceMemoId === targetMemoId) return;
        if (!Array.isArray(allMemos[selectedDate])) return;

        const fromIndex = getMemoIndexById(selectedDate, sourceMemoId);
        const toIndex = getMemoIndexById(selectedDate, targetMemoId);
        if (fromIndex < 0 || toIndex < 0) return;

        const [movedItem] = allMemos[selectedDate].splice(fromIndex, 1);
        const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        allMemos[selectedDate].splice(adjustedToIndex, 0, movedItem);
        normalizeBucketOrder(selectedDate, true);
        saveMemos();
        renderMemos();
    });

    memoList.addEventListener('dragend', () => {
        document.querySelectorAll('.memo-item').forEach((item) => {
            item.classList.remove('dragging', 'drag-over');
        });
    });
}

function normalizeMemo(memo, dateKey, index) {
    const base = memo && typeof memo === 'object' ? memo : {};
    const createdAt = isValidIsoString(base.createdAt) ? base.createdAt : `${dateKey || 'unknown'}T00:00:00.000Z`;
    const id = typeof base.id === 'string' && base.id ? base.id : getLegacyMemoId(base, dateKey, index);
    const originId = typeof base.originId === 'string' && base.originId ? base.originId : id;
    const fallbackOrder = getMemoFallbackOrderFromTime(base) || (index + 1) * 1024;
    const normalized = {
        ...base,
        id,
        originId,
        sortOrder: getMemoOrderValue(base, fallbackOrder),
        text: typeof base.text === 'string' ? base.text : '',
        completed: Boolean(base.completed),
        createdAt,
        updatedAt: isValidIsoString(base.updatedAt) ? base.updatedAt : createdAt
    };

    const alarm = normalizeAlarm(base.alarm);
    if (alarm) {
        normalized.alarm = alarm;
    } else {
        delete normalized.alarm;
    }

    return normalized;
}

function createMemo(text, dateKey = selectedDate) {
    const timestamp = nowIso();
    const id = createId();
    const bucket = Array.isArray(allMemos[dateKey]) ? allMemos[dateKey] : [];
    return {
        id,
        originId: id,
        sortOrder: getNextTopOrder(bucket),
        text,
        completed: false,
        createdAt: timestamp,
        updatedAt: timestamp
    };
}

function createCarriedMemo(sourceMemo, carriedFromDate, targetDate = selectedDate) {
    const timestamp = nowIso();
    const bucket = Array.isArray(allMemos[targetDate]) ? allMemos[targetDate] : [];
    return {
        ...sourceMemo,
        id: createId(),
        originId: getMemoLineageKey(sourceMemo),
        sortOrder: getNextTopOrder(bucket),
        completed: false,
        carriedFrom: carriedFromDate,
        createdAt: timestamp,
        updatedAt: timestamp,
        alarm: sourceMemo.alarm ? { ...sourceMemo.alarm } : undefined
    };
}

function sortMemoBucket(dateKey, sourceMap = allMemos) {
    if (!Array.isArray(sourceMap[dateKey])) return;

    sourceMap[dateKey].sort((left, right) => {
        if (left.completed !== right.completed) {
            return left.completed ? 1 : -1;
        }

        const leftFallback = getMemoFallbackOrderFromTime(left);
        const rightFallback = getMemoFallbackOrderFromTime(right);
        const leftOrder = getMemoOrderValue(left, leftFallback);
        const rightOrder = getMemoOrderValue(right, rightFallback);
        if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
        }

        return compareMemoRecentDesc(left, right);
    });
}

addBtn.addEventListener('click', addMemo);
memoInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') addMemo();
});
clearCompletedBtn.addEventListener('click', clearCompleted);
sortBtn.addEventListener('click', () => sortMemos(true, true));

prevDateBtn.addEventListener('click', () => changeDate(-1));
nextDateBtn.addEventListener('click', () => changeDate(1));
datePicker.addEventListener('change', (event) => {
    selectedDate = event.target.value;
    carryOverIncompleteTasks(selectedDate);
    updateDateDisplay();
    renderMemos();
    updateStats();
});

function openDatePicker() {
    try {
        datePicker.showPicker();
    } catch (error) {
        datePicker.click();
    }
}

document.getElementById('currentDateDisplay').addEventListener('click', openDatePicker);
document.getElementById('currentDateDisplay').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDatePicker();
    }
});

cancelArchiveBtn.addEventListener('click', closeArchiveInput);
confirmArchiveBtn.addEventListener('click', confirmArchive);
viewArchiveBtn.addEventListener('click', openArchiveView);
closeArchiveViewBtn.addEventListener('click', closeArchiveView);
archiveViewModal.addEventListener('click', (event) => {
    if (event.target === archiveViewModal) closeArchiveView();
});
archiveInputModal.addEventListener('click', (event) => {
    if (event.target === archiveInputModal) closeArchiveInput();
});

themeToggle.addEventListener('click', toggleTheme);

alarmRepeat.addEventListener('change', toggleRepeatOptions);
cancelAlarmBtn.addEventListener('click', closeAlarmModal);
removeAlarmBtn.addEventListener('click', removeAlarm);
saveAlarmBtn.addEventListener('click', saveAlarm);
alarmModal.addEventListener('click', (event) => {
    if (event.target === alarmModal) closeAlarmModal();
});

cancelEditBtn.addEventListener('click', closeEditModal);
confirmEditBtn.addEventListener('click', confirmEdit);
editMemoInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') confirmEdit();
});
editModal.addEventListener('click', (event) => {
    if (event.target === editModal) closeEditModal();
});

document.addEventListener('keydown', handleGlobalKeydown);

init();
