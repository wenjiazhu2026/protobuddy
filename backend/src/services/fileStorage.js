/**
 * File storage driver dispatcher.
 *
 * - STORAGE_DRIVER=blob  -> Blob-backed store (EdgeOne Makers Cloud Functions)
 * - default              -> local filesystem store
 *
 * All exported functions are async so routes can `await` them uniformly.
 *
 * IMPORTANT (EdgeOne Makers): the local driver is loaded LAZILY via dynamic
 * import — fileStorageLocal.js runs mkdirSync at module scope, which throws on
 * the platform's read-only function filesystem. A static import would fail the
 * whole bundle at load time; dynamic import defers evaluation until the local
 * driver is actually used (never in blob mode).
 */
import { isBlobMode } from '../config.js';

let localFsPromise = null;
function localFs() {
  if (!localFsPromise) {
    localFsPromise = import('./fileStorageLocal.js').catch(err => {
      localFsPromise = null;
      throw err;
    });
  }
  return localFsPromise;
}

let blobFsPromise = null;
function blobFs() {
  if (!blobFsPromise) {
    blobFsPromise = import('./fileStorageBlob.js').catch(err => {
      blobFsPromise = null;
      throw err;
    });
  }
  return blobFsPromise;
}

function driver() {
  return isBlobMode() ? blobFs() : localFs();
}

function wrap(fn) {
  return (...args) => driver().then(m => m[fn](...args));
}

export const getProjectDir = wrap('getProjectDir');
export const unzipToProject = wrap('unzipToProject');
export const clearProjectFiles = wrap('clearProjectFiles');
export const writeUploadedFiles = wrap('writeUploadedFiles');
export const readFileContent = wrap('readFileContent');
export const writeFileContent = wrap('writeFileContent');
export const deleteFile = wrap('deleteFile');
export const findEntryPoint = wrap('findEntryPoint');
export const getProjectRoot = wrap('getProjectRoot');
export const getFileSize = wrap('getFileSize');
export const listProjectFiles = wrap('listProjectFiles');
export const ensureProjectDir = wrap('ensureProjectDir');
export const removeProjectFiles = wrap('removeProjectFiles');
export const saveChunk = wrap('saveChunk');
export const clearUploadParts = wrap('clearUploadParts');
export const readChunk = wrap('readChunk');
export const finalizeUpload = wrap('finalizeUpload');

// Pure helper, driver-independent (avoids forcing the local driver to load).
const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp4', '.mp3', '.pdf', '.zip', '.rar'];
export function isBinaryFile(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return BINARY_EXTS.some(ext => lower.endsWith(ext));
}
