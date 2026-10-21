const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
	scanFolder: (folderPath, scanFilters) => ipcRenderer.invoke('scan-folder', folderPath, scanFilters),
	listDrives: () => ipcRenderer.invoke('list-drives'),
	showFolderDialog: () => ipcRenderer.invoke('show-folder-dialog'),
	refreshTree: (folderPath, scanFilters) => ipcRenderer.invoke('refresh-tree', folderPath, scanFilters),
	getFolderPage: (scanId, folderId, offset, limit, sortType, extensions, scanFilters) => ipcRenderer.invoke('get-folder-page', scanId, folderId, offset, limit, sortType, extensions, scanFilters),
	getFolderAncestors: (scanId, folderId, extensions, scanFilters) => ipcRenderer.invoke('get-folder-ancestors', scanId, folderId, extensions, scanFilters),
	sortTree: (folderPath, sortType, scanId, extensions, scanFilters) => ipcRenderer.invoke('sort-tree', folderPath, sortType, scanId, extensions, scanFilters),
	filterByExtension: (folderPath, extensions, scanId, sortType, scanFilters) => ipcRenderer.invoke('filter-by-extension', folderPath, extensions, scanId, sortType, scanFilters),
	searchFiles: (scanId, query, extensions, offset, limit, scanFilters) => ipcRenderer.invoke('search-files', scanId, query, extensions, offset, limit, scanFilters),
	exportCsv: (scanId) => ipcRenderer.invoke('export-csv', scanId),
	copyPath: (filePath) => ipcRenderer.invoke('copy-path', filePath),
	revealInExplorer: (filePath) => ipcRenderer.invoke('reveal-in-explorer', filePath),
	renameFile: (filePath, newName) => ipcRenderer.invoke('rename-file', filePath, newName),
	deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
	onScanProgress: (callback) => {
		const listener = (_event, progress) => callback(progress);
		ipcRenderer.on('scan-progress', listener);
		return () => ipcRenderer.removeListener('scan-progress', listener);
	}
});
