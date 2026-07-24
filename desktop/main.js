const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let backendProcess = null;

function createWindow() {
    const win = new BrowserWindow({
        width: 1600,
        height: 900,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
        title: "SIM Telemetry Lab",
    });

    // Prevent web page from changing the window title
    win.on('page-title-updated', (e) => e.preventDefault());

    // Decide where to find the backend
    // In development, we might assume the backend is already running at 8000
    // Or we launch it from the source.
    // When packaged, we look for the exe in the resources folder
    const isPackaged = app.isPackaged;

    if (isPackaged) {
        // Path to the bundled backend binary (platform-specific name)
        const isWin = process.platform === 'win32';
        const backendDir = path.join(process.resourcesPath, 'backend-dist', 'lmu-telemetry-backend');
        const backendPath = path.join(backendDir, isWin ? 'lmu-telemetry-backend.exe' : 'lmu-telemetry-backend');

        console.log(`Launching backend at: ${backendPath}`);

        // KILL ANY PREVIOUS PROCESS ON PORT 8000 before starting
        const killExisting = () => {
            return new Promise((resolve) => {
                if (isWin) {
                    // Find PID using netstat and kill it
                    const checkCmd = `netstat -ano | findstr :8000 | findstr LISTENING`;
                    require('child_process').exec(checkCmd, (err, stdout) => {
                        if (stdout) {
                            const lines = stdout.trim().split('\n');
                            const match = lines[0].trim().match(/\s+(\d+)$/);
                            if (match && match[1]) {
                                const pid = match[1];
                                console.log(`Found stale backend on port 8000, PID: ${pid}. Killing...`);
                                require('child_process').exec(`taskkill /F /PID ${pid}`, () => resolve());
                            } else resolve();
                        } else resolve();
                    });
                } else {
                    // macOS / Linux: free the port via lsof if anything is holding it
                    require('child_process').exec(`lsof -ti tcp:8000 | xargs kill -9`, () => resolve());
                }
            });
        };

        killExisting().then(() => {
            backendProcess = spawn(backendPath, [], {
                stdio: 'ignore',
                cwd: backendDir,
                windowsHide: true,
                env: {
                    ...process.env
                }
            });

            backendProcess.on('error', (err) => {
                console.error('Failed to start backend process:', err);
                const { dialog } = require('electron');
                dialog.showErrorBox('Backend Error', `Failed to start backend: ${err.message}\nPath: ${backendPath}`);
            });
        });

        const http = require('http');
        
        const checkBackend = () => {
            return new Promise((resolve) => {
                http.get('http://127.0.0.1:8000/api/v1/health', (res) => {
                    resolve(res.statusCode === 200);
                }).on('error', (err) => {
                    console.log('Backend not ready yet:', err.message);
                    resolve(false);
                });
            });
        };

        const waitForBackend = async (maxRetries = 60) => { // Up to 30s
            for (let i = 0; i < maxRetries; i++) {
                console.log(`Checking backend health (Attempt ${i + 1}/${maxRetries})...`);
                const isHealthy = await checkBackend();
                if (isHealthy) {
                    console.log('Backend is ready!');
                    return true;
                }
                await new Promise(r => setTimeout(r, 500)); // wait 500ms
            }
            return false;
        };

        waitForBackend().then(async (isReady) => {
            if (isReady) {
                try {
                    await win.webContents.session.clearCache();
                    console.log('Cache cleared, loading app...');
                } catch (err) {
                    console.error('Failed to clear cache:', err);
                }
                win.loadURL('http://127.0.0.1:8000');
            } else {
                const { dialog } = require('electron');
                dialog.showErrorBox('Backend Timeout', 'The backend service failed to start within the expected time limit (30s). Please check the backend_debug.log file.');
            }
        });
    } else {
        // In dev mode
        win.loadURL('http://127.0.0.1:8000');
    }

    win.on('closed', () => {
        if (backendProcess) {
            backendProcess.kill();
        }
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (backendProcess) {
        backendProcess.kill();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
