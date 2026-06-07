import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, dialog } from 'electron';

/**
 * Auto-update wiring. Checks the configured GitHub Releases feed on app
 * start + every 6 hours. Downloads in the background; on completion shows
 * a quiet confirm — Install Now (relaunch) or Later (next app start).
 *
 * No-ops in dev mode. Requires:
 *   - package.json `build.publish` configured (GitHub provider)
 *   - Releases published via `npm run dist:publish` (or CI calling
 *     electron-builder with the same `--publish always` flag)
 *   - On macOS: app must be code-signed for the OS to accept the update bundle
 */
export function initAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('[updater] error', err?.message ?? err);
  });
  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update…');
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info?.version ?? '?'}`);
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date');
  });
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading ${Math.round(p.percent)}% (${Math.round(p.bytesPerSecond / 1024)} KB/s)`);
  });
  autoUpdater.on('update-downloaded', async (info) => {
    console.log(`[updater] downloaded ${info?.version ?? '?'} — prompting user`);
    const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const choice = await dialog.showMessageBox(focused, {
      type: 'info',
      buttons: ['Install Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'R2 Update Ready',
      message: `Version ${info?.version ?? '?'} is downloaded.`,
      detail: 'Install now and relaunch, or keep using the current version. The update applies automatically on next launch otherwise.'
    });
    if (choice.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  // First check after a short delay so we don't compete with boot work.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => { /* swallow */ });
  }, 30_000);
  // Then every 6 hours.
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => { /* swallow */ });
  }, 6 * 60 * 60_000);
}
