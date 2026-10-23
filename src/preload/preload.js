const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
	openSupportPage: () => ipcRenderer.invoke('open-support-page'),
	scanFolder: (folderPath, scanFilters, requestId) => ipcRenderer.invoke('scan-folder', folderPath, scanFilters, requestId),
	cancelScan: (requestId) => ipcRenderer.invoke('cancel-scan', requestId),
	listDrives: () => ipcRenderer.invoke('list-drives'),
	volumeCapacity: (scanId) => ipcRenderer.invoke('volume-capacity', scanId),
	listSavedScans: () => ipcRenderer.invoke('list-saved-scans'),
	activateSavedScan: (folderPath) => ipcRenderer.invoke('activate-saved-scan', folderPath),
	showFolderDialog: () => ipcRenderer.invoke('show-folder-dialog'),
	saveScanArchive: (scanId) => ipcRenderer.invoke('save-scan-archive', scanId),
	openScanArchive: (requestId) => ipcRenderer.invoke('open-scan-archive', requestId),
	compareWithCurrent: (requestId) => ipcRenderer.invoke('compare-with-current', requestId),
	comparePage: (kind, options) => ipcRenderer.invoke('compare-page', kind, options),
	findDuplicates: (drivePath, requestId, scope) => ipcRenderer.invoke('find-duplicates', drivePath, requestId, scope),
	refreshTree: (folderPath, scanFilters, requestId) => ipcRenderer.invoke('refresh-tree', folderPath, scanFilters, requestId),
	getFolderPage: (scanId, folderId, offset, limit, sortType, extensions, scanFilters) => ipcRenderer.invoke('get-folder-page', scanId, folderId, offset, limit, sortType, extensions, scanFilters),
	getFolderAncestors: (scanId, folderId, extensions, scanFilters) => ipcRenderer.invoke('get-folder-ancestors', scanId, folderId, extensions, scanFilters),
	sortTree: (folderPath, sortType, scanId, extensions, scanFilters) => ipcRenderer.invoke('sort-tree', folderPath, sortType, scanId, extensions, scanFilters),
	filterByExtension: (folderPath, extensions, scanId, sortType, scanFilters) => ipcRenderer.invoke('filter-by-extension', folderPath, extensions, scanId, sortType, scanFilters),
	searchFiles: (scanId, query, extensions, offset, limit, scanFilters) => ipcRenderer.invoke('search-files', scanId, query, extensions, offset, limit, scanFilters),
	exportCsv: (scanId) => ipcRenderer.invoke('export-csv', scanId),
	analysisPage: (scanId, options) => ipcRenderer.invoke('analysis-page', scanId, options),
	actionHistory: () => ipcRenderer.invoke('action-history'),
	restoreName: (id, scanId) => ipcRenderer.invoke('restore-name', id, scanId),
	copyItem: (filePath, scanId, mode) => ipcRenderer.invoke('copy-item', filePath, scanId, mode),
	moveHistoryAction: (id) => ipcRenderer.invoke('move-history-action', id),
	clearCopySelection: () => ipcRenderer.invoke('clear-copy-selection'),
	pasteItem: (scanId, folderId) => ipcRenderer.invoke('paste-item', scanId, folderId),
	cancelCopy: () => ipcRenderer.invoke('cancel-copy'),
	copyHistoryAction: (id) => ipcRenderer.invoke('copy-history-action', id),
	restoreRecycledItem: (id) => ipcRenderer.invoke('restore-recycled-item', id),
	onCopyProgress: (callback) => {
		const listener = (_event, progress) => callback(progress);
		ipcRenderer.on('copy-progress', listener);
		return () => ipcRenderer.removeListener('copy-progress', listener);
	},
	onLiveUpdate: (callback) => {
		const listener = (_event, update) => callback(update);
		ipcRenderer.on('live-update', listener);
		return () => ipcRenderer.removeListener('live-update', listener);
	},
	readTextPreview: (scanId, filePath, page, revision) => ipcRenderer.invoke('read-text-preview', scanId, filePath, page, revision),
	copyPath: (filePath) => ipcRenderer.invoke('copy-path', filePath),
	revealInExplorer: (filePath) => ipcRenderer.invoke('reveal-in-explorer', filePath),
	renameFile: (filePath, newName, scanId) => ipcRenderer.invoke('rename-file', filePath, newName, scanId),
	deleteFile: (filePath, scanId) => ipcRenderer.invoke('delete-file', filePath, scanId),
	createFolder: (scanId, folderId, name) => ipcRenderer.invoke('create-folder', scanId, folderId, name),
	confirmRecycle: (requestId, accepted) => ipcRenderer.invoke('confirm-recycle', requestId, accepted),
	onRecycleConfirmation: (callback) => {
		const listener = (_event, request) => callback(request);
		ipcRenderer.on('recycle-confirmation', listener);
		return () => ipcRenderer.removeListener('recycle-confirmation', listener);
	},
	onRecycleConfirmationClosed: (callback) => {
		const listener = (_event, requestId) => callback(requestId);
		ipcRenderer.on('recycle-confirmation-closed', listener);
		return () => ipcRenderer.removeListener('recycle-confirmation-closed', listener);
	},
	onDuplicateProgress: (callback) => {
		const listener = (_event, progress) => callback(progress);
		ipcRenderer.on('duplicate-progress', listener);
		return () => ipcRenderer.removeListener('duplicate-progress', listener);
	},
	onScanProgress: (callback) => {
		const listener = (_event, progress) => callback(progress);
		ipcRenderer.on('scan-progress', listener);
		return () => ipcRenderer.removeListener('scan-progress', listener);
	}
});
