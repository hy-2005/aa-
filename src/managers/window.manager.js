const { BrowserWindow, screen, shell } = require('electron');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('WINDOW');
const config = require('../core/config');

class WindowManager {
  constructor() {
    this.windows = new Map();
    this.activeWindow = 'main';
    this.isInteractive = true; // default to interactive so windows are clickable/drag-able
    this.isVisible = false;
    this.currentDisplay = null;
    this.screenWatcher = null;
    this.desktopWatcher = null;
    this.lastActiveSpace = null;
    this.isScreenBeingShared = false;
    this.wasVisibleBeforeSharing = false;
    this.isInitialized = false;
    this.isInitializing = false;
    this.isRecording = false;
    // Overlay opacity for Alt+= / Alt+- hotkeys (main / chat / llmResponse)
    this.overlayOpacity = 1.0;
    // Set true for ~500ms after Ctrl+[ / Ctrl+] to prevent the renderer's
    // resizeWindowToContent from snapping the new height back down.
    this._suspendAutoShrink = 0;
    
    // Add debouncing to prevent excessive operations
    this.lastEnforceTime = 0;
    this.enforceDebounceMs = 1000; // Only enforce once per second
    this.focusLocked = false; // Prevent focus loops
    
    // Window binding properties
    this.bindWindows = true; // Enable window binding by default
    this.windowGap = 10; // Small gap between windows
    this.boundWindowsPosition = { x: 0, y: 0 }; // Track position of bound windows
    
    this.windowConfigs = {
      main: {
        width: 520,
        height: 35,
        minWidth: 240,
        minHeight: 70,
        // Allow the main bar to grow up to 1100 so Ctrl+] actually has
        // somewhere to go. Previously max=520 made the user hit the cap
        // after 7 presses and the resize "stopped working" while chat /
        // llmResponse kept growing — looked like "not resizing together".
        maxWidth: 1100,
        maxHeight: 600,
        useContentSize: true,
        file: 'index.html',
        title: 'OpenCluely'
      },
      chat: {
        width: 500,
        height: 700,
        minWidth: 360,
        minHeight: 320,
        maxWidth: 900,
        maxHeight: 1000,
        file: 'chat.html',
        title: 'Chat'
      },
      llmResponse: {
        width: 1280,
        height: 620,
        minWidth: 800,
        minHeight: 320,
        maxWidth: 1920,
        maxHeight: 1200,
        file: 'llm-response.html',
        title: 'AI Response',
        alwaysOnTop: true
      },
      settings: {
        width: 400,
        height: 380,
        file: 'settings.html',
        title: 'Settings',
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        alwaysOnTop: true,
        visibleOnAllWorkspaces: true,
        fullscreenable: false
      },
      onboarding: {
        width: 560,
        height: 680,
        file: 'onboarding.html',
        title: 'Welcome to OpenCluely',
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: true,
        alwaysOnTop: true,
        visibleOnAllWorkspaces: true,
        fullscreenable: false
      }
    };

    this.init();
  }

  init() {
    // ... existing initialization code ...
  }

  async initializeWindows(options = {}) {
    const { showMainWindow = true } = options;
    if (this.isInitialized || this.isInitializing) {
      logger.warn('Windows already initialized or initializing');
      return;
    }

    this.isInitializing = true;
    logger.info('Initializing application windows', { showMainWindow });
    
    try {
      // Pass autoShow so the main window doesn't flash visible during
      // first-run onboarding before the user has configured API keys.
      await this.createMainWindow({ autoShow: showMainWindow });
      await this.createChatWindow();
      await this.createLLMResponseWindow();
      await this.createSettingsWindow();
      
      this.setupWindowEventHandlers();
      this.setupScreenTracking();

      // Make windows interactive by default so they are not click-through
      this.setInteractive(true);
      
      // Optionally show the main window (deferred during onboarding)
      if (showMainWindow) {
        await this.showMainWindow();
      }
      
      this.isInitialized = true;
      this.isInitializing = false;
      logger.info('All windows initialized successfully');
    } catch (error) {
      this.isInitializing = false;
      logger.error('Failed to initialize windows', { error: error.message });
      throw error;
    }
  }

  async showMainWindow() {
    const mainWindow = this.windows.get('main');
    if (!mainWindow) return;
    
    // Immediate always-on-top enforcement for main window
    if (process.platform === 'darwin') {
      try {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 2);
      } catch (error) {
        mainWindow.setAlwaysOnTop(true, 'floating', 2);
      }
    } else {
      mainWindow.setAlwaysOnTop(true);
    }
    
    // Wait for app to fully initialize and detect current desktop
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.showOnCurrentDesktop(mainWindow);
    
    // Additional enforcement after showing
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!mainWindow.isDestroyed()) {
      if (process.platform === 'darwin') {
        try {
          mainWindow.setAlwaysOnTop(true, 'screen-saver', 2);
        } catch (error) {
          mainWindow.setAlwaysOnTop(true, 'floating', 2);
        }
      } else {
        mainWindow.setAlwaysOnTop(true);
      }
    }
    
    this.isVisible = true;
    logger.info('Main window displayed');
    // Notify renderer to refresh speech availability
    mainWindow.webContents.send('main-window-shown', {});
  }

  async createMainWindow(options = {}) {
    const { autoShow = true } = options;
    if (this.windows.has('main')) {
      return this.windows.get('main');
    }
    const window = await this.createWindow('main', false); // Don't show during creation
    this.windows.set('main', window);

    // Always-on-top must be set even when we're deferring the visual
    // show — it persists into the future showOnCurrentDesktop call.
    if (process.platform === 'darwin') {
      try {
        window.setAlwaysOnTop(true, 'screen-saver', 2);
      } catch (error) {
        window.setAlwaysOnTop(true, 'floating', 2);
      }
    } else {
      window.setAlwaysOnTop(true);
    }

    // Only auto-show when explicitly allowed (e.g. not during first-run
    // onboarding). The single entry point for showing the overlay is
    // `showMainWindow()` — callers control timing via the flag below.
    if (autoShow) {
      // Wait for app to fully initialize and detect current desktop
      setTimeout(() => {
        this.showOnCurrentDesktop(window);
        // Additional enforcement after showing
        setTimeout(() => {
          if (!window.isDestroyed()) {
            if (process.platform === 'darwin') {
              try {
                window.setAlwaysOnTop(true, 'screen-saver', 2);
              } catch (error) {
                window.setAlwaysOnTop(true, 'floating', 2);
              }
            } else {
              window.setAlwaysOnTop(true);
            }
          }
        }, 200);
      }, 100);
    }

    return window;
  }

  async createChatWindow() {
    if (this.windows.has('chat')) {
      return this.windows.get('chat');
    }
    const window = await this.createWindow('chat');
    this.windows.set('chat', window);
    window.hide();
    return window;
  }

  async createLLMResponseWindow() {
    if (this.windows.has('llmResponse')) {
      return this.windows.get('llmResponse');
    }
    const window = await this.createWindow('llmResponse');
    this.windows.set('llmResponse', window);

    // Add console message listener to see renderer logs in main process
    window.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (message.includes('LLM-RESPONSE')) {
        logger.info(`[RENDERER] ${message}`);
      }
    });

    // After the renderer is fully ready (post-recovery or first launch),
    // replay any IPC messages that arrived while the window was dead.
    // showLLMResponse / showLLMLoading queue them into _pendingLLMIpc;
    // without this drain the user would see an empty window after a crash
    // even though the LLM answer was actually delivered moments earlier.
    window.webContents.once('did-finish-load', () => {
      try { this.flushPendingLLMIpc(); } catch (_) { /* ignore */ }
    });

    window.hide();
    return window;
  }

  async createSettingsWindow() {
    if (this.windows.has('settings')) {
      return this.windows.get('settings');
    }
    const window = await this.createWindow('settings');
    this.windows.set('settings', window);
    window.hide();
    return window;
  }

  async createWindow(type, showOnCreate = false) {
    const windowConfig = this.windowConfigs[type];
    if (!windowConfig) {
      throw new Error(`Unknown window type: ${type}`);
    }

    // Base options
    const baseOptions = {
      width: windowConfig.width,
      height: windowConfig.height,
      webPreferences: {
        ...config.get('window.webPreferences'),
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        devTools: true, // Enable DevTools for debugging
      },
      show: false, // Never show during creation, use showOnCurrentDesktop instead
      title: windowConfig.title,
      skipTaskbar: true,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      fullscreenable: false,
      // Platform-specific always-on-top settings
      ...(process.platform === 'darwin' && {
        level: 'floating' // Start with floating level for macOS
      })
    };

    // Type-specific window configurations
    let browserWindowOptions;
    
    if (type === 'settings') {
      // Settings window. Native-framed + opaque on Windows for the same
      // IME/TSF main-thread deadlock reason as the onboarding window —
      // users type API keys here with real IMEs. (macOS keeps the panel
      // style; the deadlock is Windows/TSF specific.)
      browserWindowOptions = {
        ...baseOptions,
        frame: process.platform === 'darwin',
        titleBarStyle: process.platform === 'darwin' ? 'hidden' : undefined,
        transparent: process.platform === 'darwin',
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: true,
        hasShadow: true,
        backgroundColor: process.platform === 'darwin' ? '#00000000' : '#101014',
        level: process.platform === 'darwin' ? 'floating' : undefined,
        // Additional macOS flags for better always-on-top behavior
        ...(process.platform === 'darwin' && {
          type: 'panel',
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        })
      };
  } else if (type === 'onboarding') {
      // First-run onboarding wizard.
      // NOTE: deliberately NATIVE-FRAMED and opaque. On Windows, IME (TSF)
      // input runs on the window-owning thread — the Electron main process —
      // and the frameless+transparent combination is a known main-thread
      // deadlock there (Windows logs "Application Hang / AppHangB1" and the
      // user kills the ghosted app). A native frame costs nothing for a
      // one-time setup dialog and removes the entire failure class.
      browserWindowOptions = {
        ...baseOptions,
        frame: true,
        transparent: false,
        resizable: false,
        minimizable: true,
        maximizable: false,
        closable: true,
        hasShadow: true,
        backgroundColor: '#0a0a0a',
        ...(process.platform === 'darwin' && {
          type: 'panel',
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        })
      };
  } else if (type === 'main') {
      // Main window configuration - fit to content, completely frameless
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: false,
        transparent: true,
        backgroundColor: '#00000000',
  // Allow resizing so users can adjust width; we will lock height in handlers
  resizable: true,
    // Keep the original max width as cap; allow small min width so it can collapse to one icon
    minWidth: 60,
    maxWidth: this.windowConfigs.main.maxWidth,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        useContentSize: windowConfig.useContentSize || false,
        thickFrame: false,
        focusable: true,
        ...(process.platform === 'darwin' && {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else if (type === 'llmResponse') {
      // LLM Response window - completely frameless, just content
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        backgroundColor: '#00000000',
        resizable: true,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        thickFrame: false,
        ...(process.platform === 'darwin' && {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else if (type === 'chat') {
      // Chat window - frameless without window controls
      browserWindowOptions = {
        ...baseOptions,
        minWidth: config.get('window.minWidth'),
        minHeight: config.get('window.minHeight'),
        maxWidth: config.get('window.maxWidth'),
        maxHeight: config.get('window.maxHeight'),
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: true,
        ...(process.platform === 'darwin' && {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else {
      // Other windows (skills)
      browserWindowOptions = {
        ...baseOptions,
        minWidth: config.get('window.minWidth'),
        minHeight: config.get('window.minHeight'),
        maxWidth: config.get('window.maxWidth'),
        maxHeight: config.get('window.maxHeight'),
        frame: true,
        titleBarStyle: 'default',
        transparent: false,
        resizable: true,
        minimizable: false,
        maximizable: true,
        closable: true,
        hasShadow: true,
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    }

    // Windows-specific settings
    if (process.platform === 'win32') {
      browserWindowOptions = {
        ...browserWindowOptions,
        parent: null,
        modal: false,
        thickFrame: false,
      };
    }

    browserWindowOptions.kiosk = false;
    browserWindowOptions.simpleFullscreen = false;

  const window = new BrowserWindow(browserWindowOptions);

    // Crash observability: without these hooks a renderer/GPU death is
    // completely silent — the window just vanishes or whites out and the
    // main-process log stops, which is indistinguishable from a hang.
    window.webContents.on('render-process-gone', (_e, details) => {
      logger.error('Renderer process gone', {
        windowType: type,
        reason: details.reason,
        exitCode: details.exitCode,
        url: window.webContents.getURL()
      });
      // Recreate the window automatically. Without this the user takes a
      // screenshot, the LLM renderer crashes mid-response, and every
      // subsequent "Ctrl+Alt+D" silently no-ops because the window we
      // try to `send` / `show` was already destroyed. The user reports
      // "AI response doesn't show" — it's actually "AI response window
      // died and nobody noticed, so the next show() goes to /dev/null".
      //
      // Only auto-recreate the overlay windows (main / chat / llmResponse).
      // Settings / onboarding are user-initiated and have their own recovery
      // paths; recreating them mid-onboarding would lose state.
      const recoverable = ['main', 'chat', 'llmResponse'].includes(type);
      if (!recoverable) return;
      const existing = this.windows.get(type);
      if (existing && existing !== window) return; // already replaced
      // Drop the dead handle so createWindow() doesn't return the cached one.
      this.windows.delete(type);
      // Recreate off the current call stack so we don't interfere with
      // whatever caused the crash (e.g. a still-firing IPC handler).
      setImmediate(async () => {
        try {
          if (type === 'main') {
            await this.createMainWindow({ autoShow: false });
            await this.showMainWindow();
          } else if (type === 'chat') {
            await this.createChatWindow();
          } else if (type === 'llmResponse') {
            await this.createLLMResponseWindow();
          }
          // Re-apply current interaction mode so the new window isn't
          // stuck in the wrong click-through state.
          if (this.isInteractive) {
            const fresh = this.windows.get(type);
            if (fresh && !fresh.isDestroyed()) fresh.setIgnoreMouseEvents(false);
          }
          logger.info('Window recovered after renderer crash', { windowType: type });
        } catch (recoverErr) {
          logger.error('Window recovery failed', { windowType: type, error: recoverErr.message });
        }
      });
    });
    window.webContents.on('unresponsive', () => {
      logger.error('Renderer unresponsive', { windowType: type });
    });
    window.webContents.on('did-fail-load', (_e, errorCode, errorDescription, failedUrl, isMainFrame) => {
      if (isMainFrame) {
        logger.error('Window failed to load', { windowType: type, errorCode, errorDescription, failedUrl });
      }
    });

    // Pin zoom: if a +/- hotkey ever fails to register system-wide, the
    // keypress lands in the focused Chromium window and zooms the UI.
    // Block every zoom combo at the renderer boundary and hold zoom level 0.
    window.webContents.setZoomLevel(0);
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = (input.key || '').toLowerCase();
      if ((input.control || input.alt) && ['+', '-', '=', '0', '_'].includes(key)) {
        event.preventDefault();
        window.webContents.setZoomLevel(0);
      }
    });

    // External links (GitHub, the website, Google AI Studio, etc.) must open in
    // the user's real browser, never inside the frameless overlay windows.
    // Deny any in-app window.open and hand http(s) URLs to the OS browser, and
    // block the current window from navigating away to an external site.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (/^https?:\/\//i.test(url) && url !== window.webContents.getURL()) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });

  // Load the HTML file
    await window.loadFile(windowConfig.file);
    
  // Position the window
    this.positionWindow(window, type);
    
  // Apply simplified stealth measures
    this.applyStealthMeasures(window, type);
    
  // Initialize interaction mode based on current state for ALL windows
    if (this.isInteractive) {
      window.setIgnoreMouseEvents(false);
    } else {
      window.setIgnoreMouseEvents(true, { forward: true });
    }

    // Horizontal-only resize behavior for main overlay window
    if (type === 'main') {
      try {
        // Small practical minimum width so it can collapse to roughly one icon width
        // Height is managed dynamically; don't lock here to allow programmatic changes
        if (typeof window.setMinimumSize === 'function') {
          // Set a conservative minimum width; height will be adjusted via IPC as needed
          window.setMinimumSize(60, windowConfig.height);
        }

        // Intercept user-initiated resizes to lock height and allow width changes only
        window.on('will-resize', (event, newBounds) => {
          // Skip when the resize was triggered by our own Ctrl+[ / Ctrl+]
          // shortcut — that path already knows the target dimensions and
          // wants them applied verbatim, not collapsed to current height.
          if (this._resizingByShortcut) return;
          try {
            // Keep current content height; only apply the new width
            const [_, currentContentHeight] = window.getContentSize();
            event.preventDefault();
            // Enforce width within min/max bounds
            const minW = 60;
            const maxW = this.windowConfigs.main.maxWidth || this.windowConfigs.main.width;
            const desiredW = Math.max(minW, Math.min(maxW, Math.round(newBounds.width || minW)));
            window.setContentSize(desiredW, Math.max(1, currentContentHeight));
          } catch (e) {
            // Fallback: lock window height using window size
            try {
              const [__w, currentWindowHeight] = window.getSize();
              event.preventDefault();
              const minW = 60;
              const maxW = this.windowConfigs.main.maxWidth || this.windowConfigs.main.width;
              const desiredW = Math.max(minW, Math.min(maxW, Math.round(newBounds.width || minW)));
              window.setSize(desiredW, Math.max(1, currentWindowHeight));
            } catch { /* noop */ }
          }
        });

        // When resized (by user or programmatically), keep LLM just under main
        // — NOT the old "snap both to top-center" positionBoundWindows, which
        // was jumping main back to a fixed location every time the user
        // resized anything. We only nudge LLM down so it stays glued to main.
        window.on('resize', () => {
          this.positionLLMRelativeToMain();
        });
      } catch { /* ignore */ }
    }
    
    // Show window on current desktop if requested
    if (showOnCreate) {
      this.showOnCurrentDesktop(window);
    }

    logger.debug('Window created successfully', {
      type,
      title: windowConfig.title,
      dimensions: `${windowConfig.width}x${windowConfig.height}`,
      showOnCreate: showOnCreate
    });

    return window;
  }

  applyStealthMeasures(window, type) {
    // Enhanced always-on-top enforcement for all platforms
    if (process.platform === 'darwin') {
      // macOS: Use native window level constants for maximum effectiveness
      try {
        // Try the most aggressive levels first
        const levels = [
          'screen-saver',    // Highest level
          'pop-up-menu',     // Menu level
          'modal-panel',     // Modal panel level
          'floating',        // Floating level
          'normal'           // Fallback to normal with alwaysOnTop
        ];
        
        let levelSet = false;
        for (const level of levels) {
          try {
            window.setAlwaysOnTop(true, level, 1);
            levelSet = true;
            logger.debug(`Successfully set always-on-top with level: ${level}`, { type });
            break;
          } catch (levelError) {
            logger.debug(`Failed to set level: ${level}`, { error: levelError.message });
          }
        }
        
        if (!levelSet) {
          // Final fallback
          window.setAlwaysOnTop(true);
        }
        
        // Additional macOS-specific enforcement
        setTimeout(() => {
          if (!window.isDestroyed()) {
            try {
              // Force re-application of always-on-top
              window.setAlwaysOnTop(false);
              setTimeout(() => {
                if (!window.isDestroyed()) {
                  window.setAlwaysOnTop(true, 'floating', 1);
                }
              }, 50);
            } catch (error) {
              logger.warn('Error in macOS re-enforcement', { error: error.message });
            }
          }
        }, 200);
        
      } catch (error) {
        logger.warn('Error setting always-on-top for macOS', { error: error.message });
        // Absolute fallback
        window.setAlwaysOnTop(true);
      }
    } else if (process.platform === 'win32') {
      // Windows: Multiple enforcement attempts
      window.setAlwaysOnTop(true);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 100);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 500);
      
    } else {
      // Linux and other platforms
      window.setAlwaysOnTop(true);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 100);
    }

    // Ensure window appears on all workspaces/desktops initially
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    
    // Hide from taskbar to maintain stealth
    window.setSkipTaskbar(true);
    
    // Make window undetectable by screen capture (if supported)
    try {
      window.setContentProtection(true);
      if (process.platform === 'linux' && !this._warnedNoContentProtection) {
        this._warnedNoContentProtection = true;
        logger.warn('Screen-capture protection is unavailable on Linux (Electron limitation). The overlay WILL be visible in screen shares. This stealth feature only works on macOS and Windows.');
      }
    } catch (error) {
      logger.debug('Content protection not supported on this platform');
    }
    
    // More aggressive event listeners to maintain always-on-top behavior
    const enforceAlwaysOnTop = () => {
      if (!window.isDestroyed()) {
        try {
          if (process.platform === 'darwin') {
            // Try multiple levels on macOS
            window.setAlwaysOnTop(true, 'floating', 1);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'screen-saver', 1);
              }
            }, 50);
          } else {
            window.setAlwaysOnTop(true);
          }
        } catch (error) {
          logger.debug('Error in enforceAlwaysOnTop', { error: error.message });
        }
      }
    };
    
    // Event-based enforcement
    window.on('blur', () => {
      setTimeout(enforceAlwaysOnTop, 50);
      setTimeout(enforceAlwaysOnTop, 200);
      setTimeout(enforceAlwaysOnTop, 500);
    });
    
    window.on('show', () => {
      setTimeout(enforceAlwaysOnTop, 50);
      setTimeout(enforceAlwaysOnTop, 200);
    });
    
    window.on('focus', () => {
      setTimeout(enforceAlwaysOnTop, 50);
    });
    
    window.on('restore', () => {
      setTimeout(enforceAlwaysOnTop, 50);
    });
    
    // Periodic enforcement every 3 seconds (more frequent)
    const periodicEnforcement = setInterval(() => {
      if (window.isDestroyed()) {
        clearInterval(periodicEnforcement);
        return;
      }
      enforceAlwaysOnTop();
    }, 3000);
    
    logger.debug('Applied enhanced stealth measures with aggressive always-on-top', {
      type,
      platform: process.platform,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true
    });
  }

  positionWindow(window, type) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    
    if (this.bindWindows && (type === 'main' || type === 'llmResponse')) {
      // Position bound windows together
      this.positionBoundWindows();
      return;
    }
    
    // All windows positioned at top of screen with small margin
    const topMargin = 20;
    const [windowWidth] = window.getSize();
    
    const positions = {
      main: { x: displayX + 50, y: displayY + topMargin },
      chat: { x: displayX + screenWidth - windowWidth - 50, y: displayY + topMargin },
      llmResponse: { x: displayX + (screenWidth - windowWidth) / 2, y: displayY + topMargin },
      settings: { x: displayX + (screenWidth - windowWidth) / 2, y: displayY + topMargin }
    };

    const position = positions[type] || { x: displayX + 100, y: displayY + topMargin };
    window.setPosition(position.x, position.y);
    
    logger.debug('Positioned window at top', {
      type,
      position: `${position.x},${position.y}`,
      topMargin,
      display: display.id || 'primary'
    });
  }

  // New method to position bound windows (vertical column layout) - Always at top
  positionBoundWindows() {
    const mainWindow = this.windows.get('main');
    const llmWindow = this.windows.get('llmResponse');

    if (!mainWindow || !llmWindow) return;

    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;

    const [mainWidth, mainHeight] = mainWindow.getSize();
    const [llmWidth, llmHeight] = llmWindow.getSize();

    // Always position at the top of the screen with small margin
    const topMargin = 20;
    const startY = displayY + topMargin;

    // Use the wider window for horizontal centering
    const maxWidth = Math.max(mainWidth, llmWidth);

    // Center horizontally on the display
    const xPosition = displayX + Math.round((screenWidth - maxWidth) / 2);

    // Ensure windows don't go outside screen bounds horizontally
    const adjustedMainX = Math.max(displayX, Math.min(displayX + screenWidth - mainWidth, xPosition));
    const adjustedLlmX = Math.max(displayX, Math.min(displayX + screenWidth - llmWidth, xPosition));

    // Position main window (top)
    const mainX = adjustedMainX;
    const mainY = startY;
    mainWindow.setPosition(mainX, mainY);

    // Position LLM response window below with gap
    const llmX = adjustedLlmX;
    const llmY = startY + mainHeight + this.windowGap;
    llmWindow.setPosition(llmX, llmY);

    // Update stored position (use main window position as reference)
    this.boundWindowsPosition = { x: adjustedMainX, y: startY };

    logger.debug('Positioned bound windows at top (column layout)', {
      mainPosition: `${mainX},${mainY}`,
      llmPosition: `${llmX},${llmY}`,
      gap: this.windowGap,
      topMargin: topMargin,
      display: display.id
    });
  }

  /**
   * Slide the LLM window so it sits directly under the main router window
   * with the configured gap, keeping the SAME x as main. This is what the
   * user actually wants: "AI response should appear below the router I'm
   * currently using", not "snap to top-center of the screen on every
   * event". Also used as the resize handler on main — keeps the two glued
   * together without yanking main back to a fixed location.
   *
   * No-op if main or llmResponse is missing/destroyed, or if LLM is
   * currently the only window being shown at top-center (initial state).
   */
  positionLLMRelativeToMain() {
    const mainWin = this.windows.get('main');
    const llmWin = this.windows.get('llmResponse');
    if (!mainWin || mainWin.isDestroyed()) return;
    if (!llmWin || llmWin.isDestroyed()) return;

    const [mainX, mainY] = mainWin.getPosition();
    const [mainW, mainH] = mainWin.getSize();
    const [llmW, llmH] = llmWin.getSize();

    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenW, height: screenH } = display.workArea;
    const topMargin = 20;

    // Same X as main, Y = mainY + mainH + gap. Clamp to screen so the LLM
    // never ends up half off-screen when main is dragged into a corner.
    const desiredX = mainX;
    const desiredY = mainY + mainH + this.windowGap;
    const x = Math.max(displayX, Math.min(displayX + screenW - llmW, desiredX));
    const y = Math.max(displayY + topMargin, Math.min(displayY + screenH - llmH, desiredY));

    llmWin.setPosition(x, y);

    logger.debug('LLM window positioned relative to main', {
      main: { x: mainX, y: mainY, w: mainW, h: mainH },
      llm: { x, y, w: llmW, h: llmH }
    });
  }

  // Move all overlay windows together (main + chat + llmResponse) by a delta,
// with screen bounds clamping. Works regardless of bindWindows state so
// Alt+arrow / Ctrl+arrow always respond, even when window binding is off.
  moveBoundWindows(deltaX, deltaY) {
    const mainWindow = this.windows.get('main');
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;
    const topMargin = 20;

    // Anchor on main window for bounds calculations
    const [mainX, mainY] = mainWindow.getPosition();
    const [mainWidth, mainHeight] = mainWindow.getSize();

    // New main position clamped to screen
    const newMainX = Math.max(displayX, Math.min(displayX + screenWidth - mainWidth, mainX + deltaX));
    const newMainY = Math.max(displayY + topMargin, Math.min(displayY + screenHeight - mainHeight, mainY + deltaY));

    const dxApplied = newMainX - mainX;
    const dyApplied = newMainY - mainY;

    mainWindow.setPosition(newMainX, newMainY);

    // Move chat + llmResponse by the same applied delta so they stay in
    // lockstep with main. If bindWindows is on we re-stack (vertical
    // column); otherwise we just translate by the same delta.
    ['chat', 'llmResponse'].forEach((type) => {
      const w = this.windows.get(type);
      if (!w || w.isDestroyed()) return;
      const [x, y] = w.getPosition();
      const [width, height] = w.getSize();
      let nx = Math.max(displayX, Math.min(displayX + screenWidth - width, x + dxApplied));
      let ny = Math.max(displayY, Math.min(displayY + screenHeight - height, y + dyApplied));
      if (this.bindWindows && type === 'llmResponse') {
        // Column layout: pin llmResponse below main with the gap
        ny = newMainY + mainHeight + this.windowGap;
        // Clamp horizontal again in case main moved beyond screen
        nx = Math.max(displayX, Math.min(displayX + screenWidth - width, nx));
      }
      w.setPosition(nx, ny);
    });

    this.boundWindowsPosition.x = newMainX;
    this.boundWindowsPosition.y = newMainY;

    logger.debug('Moved overlay windows', {
      delta: `${deltaX},${deltaY}`,
      applied: `${dxApplied},${dyApplied}`,
      newMainPosition: `${newMainX},${newMainY}`,
      boundWindows: this.bindWindows
    });
  }

  showOnCurrentDesktop(win) {
    if (!win || win.isDestroyed()) return;

    const llmWin = this.windows.get('llmResponse');
    const isLLM = llmWin && !llmWin.isDestroyed() && win.id === llmWin.id;

    if (process.platform === 'darwin') {
      // macOS: prevent space switching and keep visibility stable
      win.hide();
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

      const setMacOSAlwaysOnTop = () => {
        if (win.isDestroyed()) return;
        try {
          win.setAlwaysOnTop(true, 'screen-saver', 2);
        } catch {
          try { win.setAlwaysOnTop(true, 'pop-up-menu', 2); }
          catch { try { win.setAlwaysOnTop(true, 'floating', 2); }
          catch { win.setAlwaysOnTop(true); }}
        }
      };

      setMacOSAlwaysOnTop();

      setTimeout(() => {
        if (win.isDestroyed()) return;
        win.show();
        win.focus();
        setMacOSAlwaysOnTop();
        setTimeout(() => { if (!win.isDestroyed()) setMacOSAlwaysOnTop(); }, 100);
        // Keep LLM window visible across workspaces; others revert
        setTimeout(() => {
          if (win.isDestroyed()) return;
          if (!isLLM) {
            win.setVisibleOnAllWorkspaces(false);
          }
          setMacOSAlwaysOnTop();
        }, 300);
      }, 50);
    } else {
      // Linux/Windows
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true);
      win.show();
      win.focus();
      setTimeout(() => {
        if (win.isDestroyed()) return;
        if (!isLLM) {
          win.setVisibleOnAllWorkspaces(false);
        }
        win.setAlwaysOnTop(true);
      }, 500);
    }

    logger.debug('Showing window on current desktop with enhanced always-on-top', {
      platform: process.platform,
      windowId: win.id,
      isDestroyed: win.isDestroyed()
    });
  }
  
  setupWindowEventHandlers() {
    this.windows.forEach((window, type) => {
      window.on('closed', () => {
        logger.debug('Window closed', { type });
        this.windows.delete(type);
      });

      // The settings window now has a native frame (IME/TSF deadlock fix),
      // so its X button actually closes. showSettings() only shows an
      // existing window, so intercept close → hide to keep it reusable.
      if (type === 'settings') {
        window.on('close', (e) => {
          if (!window.isDestroyed()) {
            e.preventDefault();
            window.hide();
          }
        });
      }

      window.on('focus', () => {
        this.activeWindow = type;
        logger.debug('Window focused', { type });
      });

      // SIMPLIFIED blur handler - no aggressive re-focusing
      window.on('blur', () => {
        // Only log, don't force focus back
        logger.debug('Window blurred', { type });
      });

      window.on('show', () => {
        logger.debug('Window shown', { type });
      });

      window.on('hide', () => {
        logger.debug('Window hidden', { type });
      });

      // Handle window minimize attempts
      window.on('minimize', (event) => {
        event.preventDefault();
        logger.debug('Prevented window minimize', { type });
      });

      window.on('restore', () => {
        // Simplified restore handling
        logger.debug('Window restored', { type });
      });
    });
  }

  startScreenSharingMode() {
    if (!this.isScreenBeingShared) {
      this.isScreenBeingShared = true;
      this.wasVisibleBeforeSharing = this.isVisible;
      this.handleScreenSharingStarted();
    }
  }

  stopScreenSharingMode() {
    if (this.isScreenBeingShared) {
      this.isScreenBeingShared = false;
      this.handleScreenSharingStopped();
    }
  }

  handleScreenSharingStarted() {
    logger.info('Screen sharing mode enabled - hiding windows');
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.hide();
        window.setPosition(-10000, -10000);
      }
    });
  }

  handleScreenSharingStopped() {
    logger.info('Screen sharing mode disabled - restoring windows');
    
    if (this.wasVisibleBeforeSharing) {
      this.moveWindowsToActiveScreen();
      this.showAllWindows();
    }
  }

  switchToWindow(windowType) {
    if (this.windows.has('chat') && this.windows.get('chat').isVisible()) {
      this.hideChatWindow();
      return;
    }

    if (!this.windowConfigs[windowType]) {
      logger.warn('Attempted to switch to unknown window type', { windowType });
      return;
    }

    if (this.isScreenBeingShared) {
      return;
    }

    const targetWindow = this.windows.get(windowType);
    if (targetWindow) {
      this.showOnCurrentDesktop(targetWindow);

      this.activeWindow = windowType;
      
      logger.info('Switched to window', {
        windowType,
        isVisible: this.isVisible
      });
    }
  }

  showAllWindows() {
    if (this.isScreenBeingShared) {
      return;
    }

    this.windows.forEach((window, type) => {
      if (type !== 'llmResponse') { // Don't show LLM response unless it has content
        this.showOnCurrentDesktop(window);
      }
    });
    
    this.isVisible = true;
    const activeWindow = this.windows.get(this.activeWindow);
    if (activeWindow) {
      activeWindow.focus();
    }
    
    logger.info('All windows shown on current desktop', { 
      activeWindow: this.activeWindow,
      windowCount: this.windows.size 
    });
  }

  hideAllWindows() {
    this.windows.forEach((window, type) => {
      if (type !== 'llmResponse') {
        window.hide();
      }
    });
    
    this.isVisible = false;
    logger.info('All windows hidden');
  }

  toggleVisibility() {
    if (this.isScreenBeingShared) {
      return this.isVisible;
    }

    if (this.isVisible) {
      this.hideAllWindows();
    } else {
      this.showAllWindows();
    }
    
    return this.isVisible;
  }

  setInteractive(interactive) {
    this.isInteractive = interactive;
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        if (interactive) {
          // Interactive mode: allow mouse events for all windows
          window.setIgnoreMouseEvents(false);
        } else {
          // Non-interactive mode: enable click-through with forwarding for all windows
          window.setIgnoreMouseEvents(true, { forward: true });
        }
        window.webContents.send('interaction-mode-changed', interactive);
      }
    });
    
    logger.info('Window interaction mode changed', { 
      interactive,
      clickThrough: !interactive,
      affectedWindows: Array.from(this.windows.keys())
    });
  }

  toggleInteraction() {
    this.setInteractive(!this.isInteractive);
    
    // Ensure all windows remain always-on-top after interaction mode change
    this.enforceAlwaysOnTopForAllWindows();
    
    return this.isInteractive;
  }

  // New method to enforce always-on-top for all windows
  enforceAlwaysOnTopForAllWindows() {
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        try {
          if (process.platform === 'darwin') {
            // Try multiple levels for macOS
            window.setAlwaysOnTop(true, 'pop-up-menu', 1);
            
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'floating', 1);
              }
            }, 100);
            
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'screen-saver', 1);
              }
            }, 200);
          } else {
            // Windows and Linux
            window.setAlwaysOnTop(true);
            
            // Additional enforcement after a short delay
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true);
              }
            }, 100);
          }
        } catch (error) {
          logger.warn('Error enforcing always-on-top', { 
            type, 
            error: error.message 
          });
          // Fallback to basic always-on-top
          try {
            window.setAlwaysOnTop(true);
          } catch (fallbackError) {
            logger.error('Fallback always-on-top failed', { 
              type, 
              error: fallbackError.message 
            });
          }
        }
      }
    });
    
    logger.debug('Enforced always-on-top for all windows with aggressive strategy', {
      platform: process.platform,
      windowCount: this.windows.size
    });
  }

  // Public method to manually enforce always-on-top for all windows
  forceAlwaysOnTopForAllWindows() {
    this.enforceAlwaysOnTopForAllWindows();
    logger.info('Manually enforced always-on-top for all windows');
  }

  // Debug method to test and verify always-on-top functionality
  testAlwaysOnTopForAllWindows() {
    const results = {};
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        try {
          const isAlwaysOnTop = window.isAlwaysOnTop();
          
          if (process.platform === 'darwin') {
            // Test different levels on macOS
            window.setAlwaysOnTop(true, 'screen-saver', 2);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'pop-up-menu', 2);
                setTimeout(() => {
                  if (!window.isDestroyed()) {
                    window.setAlwaysOnTop(true, 'floating', 2);
                  }
                }, 50);
              }
            }, 50);
          } else {
            // For other platforms
            window.setAlwaysOnTop(true);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true);
              }
            }, 50);
          }
          
          results[type] = {
            success: true,
            isAlwaysOnTop: isAlwaysOnTop,
            isVisible: window.isVisible(),
            isDestroyed: window.isDestroyed()
          };
          
        } catch (error) {
          results[type] = {
            success: false,
            error: error.message,
            isDestroyed: window.isDestroyed()
          };
        }
      } else {
        results[type] = {
          success: false,
          error: 'Window is destroyed'
        };
      }
    });
    
    logger.info('Always-on-top test results', { 
      platform: process.platform,
      results 
    });
    
    return results;
  }

  showLLMResponse(content, metadata = {}) {
    logger.debug('showLLMResponse called', {
      isScreenBeingShared: this.isScreenBeingShared,
      contentLength: content ? content.length : 0,
      skill: metadata.skill
    });

    if (this.isScreenBeingShared) {
      logger.warn('LLM response blocked due to screen sharing mode');
      return;
    }

    let llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || llmWindow.isDestroyed()) {
      // The render-process-gone handler auto-recreates the window in the
      // background. If it hasn't finished by the time the LLM answer
      // arrives (or it never fires because the GPU was the culprit), the
      // IPC send below would silently no-op. Bring the window to front
      // first so recovery has a chance to start, then check again before
      // sending the IPC. We can't synchronously await the recreate here
      // without blocking the LLM response callback, so we queue the send
      // and replay it once the window is alive.
      logger.warn('LLM response window missing/destroyed — queueing replay', {
        hasHandle: !!llmWindow,
        destroyed: !!(llmWindow && llmWindow.isDestroyed())
      });
      this._pendingLLMIpc = this._pendingLLMIpc || [];
      this._pendingLLMIpc.push({ channel: 'display-llm-response', payload: { content, metadata, timestamp: new Date().toISOString() } });
      this.bringLLMWindowToFront('response');
      return;
    }

    logger.debug('Sending display-llm-response event to window');
    try {
      llmWindow.webContents.send('display-llm-response', {
        content,
        metadata,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      logger.warn('display-llm-response send failed; queueing replay', { err: e.message });
      this._pendingLLMIpc = this._pendingLLMIpc || [];
      this._pendingLLMIpc.push({ channel: 'display-llm-response', payload: { content, metadata, timestamp: new Date().toISOString() } });
    }

    this.bringLLMWindowToFront('response');

    // Don't call `positionBoundWindows` here anymore — it yanks the main
    // router bar back to top-center on every screenshot/send, which is
    // exactly the "every shortcut jumps the window" complaint.
    // `bringLLMWindowToFront` already positions the LLM relative to main.

    logger.info('LLM response displayed', {
      contentLength: content ? content.length : 0,
      skill: metadata.skill,
      windowVisible: llmWindow.isVisible(),
      boundWindows: this.bindWindows
    });
  }

  showLLMLoading() {
    if (this.isScreenBeingShared) {
      logger.warn('LLM loading blocked due to screen sharing mode');
      return;
    }

    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || llmWindow.isDestroyed()) {
      // Same defense-in-depth as showLLMResponse: queue the IPC and let
      // bringLLMWindowToFront trigger recovery + replay.
      logger.warn('LLM window missing/destroyed for loading state — queueing replay', {
        hasHandle: !!llmWindow,
        destroyed: !!(llmWindow && llmWindow.isDestroyed())
      });
      this._pendingLLMIpc = this._pendingLLMIpc || [];
      this._pendingLLMIpc.push({ channel: 'show-loading', payload: null });
      this.bringLLMWindowToFront('loading');
      return;
    }
    try {
      llmWindow.webContents.send('show-loading');
    } catch (e) {
      logger.warn('show-loading send failed; queueing replay', { err: e.message });
      this._pendingLLMIpc = this._pendingLLMIpc || [];
      this._pendingLLMIpc.push({ channel: 'show-loading', payload: null });
    }
    this.bringLLMWindowToFront('loading');
    // `bringLLMWindowToFront` already slides LLM under main. No extra
    // positionBoundWindows() call — that was the "always jump to center"
    // bug the user reported.
  }

  /**
   * Drain any queued LLM IPC messages onto the freshly-recreated window.
   * Called from `did-finish-load` after the render-process-gone handler
   * rebuilds llmResponse. Without this, the "show loading" / "display
   * response" signals that arrived while the window was dead would be
   * permanently lost and the user would see an empty window after
   * recovery.
   */
  flushPendingLLMIpc() {
    const queue = this._pendingLLMIpc || [];
    if (!queue.length) return;
    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || llmWindow.isDestroyed() || !llmWindow.webContents) {
      return; // still not ready, try again next tick
    }
    this._pendingLLMIpc = [];
    logger.info('Replaying queued LLM IPC after window recovery', { count: queue.length });
    queue.forEach(({ channel, payload }) => {
      try {
        if (payload == null) {
          llmWindow.webContents.send(channel);
        } else {
          llmWindow.webContents.send(channel, payload);
        }
      } catch (e) {
        logger.warn('Failed to replay queued LLM IPC', { channel, err: e.message });
      }
    });
  }

  hideLLMResponse() {
    const llmWindow = this.windows.get('llmResponse');
    if (llmWindow) {
      llmWindow.hide();
    }
  }

  /**
   * Step overlay-window opacity for the Alt+= / Alt+- shortcuts.
   * Applies to the stealth overlay windows only (main / chat / llmResponse);
   * framed dialogs (settings / onboarding) keep full opacity.
   */
  setOverlayOpacity(delta) {
    const MIN = 0;
    const MAX = 1.0;
    const next = Math.min(MAX, Math.max(MIN, Math.round((this.overlayOpacity + delta) * 100) / 100));
    if (next === this.overlayOpacity) return this.overlayOpacity;
    this.overlayOpacity = next;
    ['main', 'chat', 'llmResponse'].forEach((type) => {
      const win = this.windows.get(type);
      if (win && !win.isDestroyed()) {
        try { win.setOpacity(this.overlayOpacity); } catch (_) { /* ignore */ }
      }
    });
    logger.info('Overlay opacity changed', { opacity: this.overlayOpacity });
    return this.overlayOpacity;
  }

  /** Alt+0 — bring all overlay windows back to full opacity. */
  resetOverlayOpacity() {
    this.overlayOpacity = 0.999;
    return this.setOverlayOpacity(0.001);
  }

  /**
   * Hide every visible overlay window so a capture doesn't include our
   * own UI. Returns the list that was hidden so the caller can restore.
   * Framed dialogs (onboarding, settings) are left alone.
   */
  hideOverlaysForCapture() {
    const hidden = [];
    ['main', 'chat', 'llmResponse'].forEach((type) => {
      const win = this.windows.get(type);
      if (win && !win.isDestroyed() && win.isVisible()) {
        try { win.hide(); hidden.push(type); } catch (_) { /* ignore */ }
      }
    });
    return hidden;
  }

  /**
   * Force every renderer to schedule a fresh paint frame immediately, so
   * the compositor commits the hide before desktopCapturer.getSources()
   * reads the desktop. Without this, on Windows the capture often arrives
   * a frame or two before Chromium has actually repainted without the
   * overlay, so the screenshot includes our own chat/llm-response chrome.
   */
  invalidateOverlaysForCapture() {
    ['main', 'chat', 'llmResponse'].forEach((type) => {
      const win = this.windows.get(type);
      if (win && !win.isDestroyed()) {
        try {
          if (win.webContents && !win.webContents.isDestroyed()) {
            win.webContents.invalidate?.();
          }
        } catch (_) { /* ignore */ }
      }
    });
  }

  restoreOverlaysAfterCapture(hiddenTypes) {
    if (!Array.isArray(hiddenTypes)) return;
    for (const type of hiddenTypes) {
      const win = this.windows.get(type);
      if (win && !win.isDestroyed()) {
        try { win.show(); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Ctrl+[ / Ctrl+] — step the main overlay window's size. Clamped so it
   * never collapses to nothing or outgrows the configured max. The previous
   * "only resize width" implementation conflicted with resizeWindowToContent
   * in main-window.js, which auto-shrinks height to whatever the .command-tab
   * measures (a 35px bar) — the user reported the window collapsing to a
   * thin strip. The shortcuts now resize BOTH width and height, and the
   * renderer is told to skip the next auto-shrink so the resize sticks.
   */
  stepOverlayWindowSize(delta) {
    // Ctrl+[ / Ctrl+] — resize ALL stealth overlay windows together (main
    // bar, chat, llm response). Each window has its own min/max bounds so
    // they each clamp independently, but the delta is shared so pressing
    // Ctrl+] makes the whole UI bigger in lockstep. Each window also gets
    // the "I was resized by a shortcut" IPC so the renderer skips its next
    // auto-shrink tick (otherwise main's setContentSize gets undone 16ms
    // later by the .command-tab measure).
    //
    // The window size itself isn't the whole story — the content INSIDE
    // also has to scale, otherwise pressing Ctrl+] just adds whitespace
    // around 11px-tall buttons. We apply `setZoomFactor = currentSize /
    // baselineSize` so the icons, text, padding, code blocks, and layout
    // all grow proportionally with the window. The factor is clamped to
    // [MIN_ZOOM, MAX_ZOOM] so the text never becomes unreadable at either
    // extreme.
    const targets = ['main', 'chat', 'llmResponse'];
    const MIN_ZOOM = 0.7;
    const MAX_ZOOM = 2.0;

    // Set the auto-shrink guard BEFORE the resize, not after. The renderer
    // fires a resize event synchronously after setContentSize, and if the
    // IPC hasn't reached it yet it can call resize-window to undo our
    // height change before `_suspendAutoShrink` is set.
    this._suspendAutoShrink = Date.now() + 1000;

    // Mark the resize so main's `will-resize` handler knows to let the
    // height change through (it normally locks height to currentContentHeight
    // for user drag-resizes). Without this flag the user would press Ctrl+]
    // and main would silently stay 35px tall.
    this._resizingByShortcut = true;
    let anyResized = false;
    try {
      for (const type of targets) {
        const win = this.windows.get(type);
        if (!win || win.isDestroyed()) continue;
        const cfg = this.windowConfigs?.[type] || {};
        const minW = cfg.minWidth || 200;
        const minH = cfg.minHeight || 70;
        const maxW = cfg.maxWidth || cfg.width || 1920;
        const maxH = cfg.maxHeight || cfg.height || 1200;
        const baselineW = cfg.width || 800;
        const baselineH = cfg.height || 600;
        const [w, h] = win.getContentSize();
        const newW = Math.max(minW, Math.min(maxW, Math.round(w + delta)));
        const newH = Math.max(minH, Math.min(maxH, Math.round(h + delta)));
        if (newW === w && newH === h) continue;
        win.setContentSize(newW, newH);
        // Scale the renderer content by the same ratio so the icons,
        // padding, and text inside grow / shrink in lockstep with the
        // window frame. Width is the anchor; height follows the same
        // factor so the proportions stay correct.
        const rawFactor = newW / baselineW;
        const factor = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, rawFactor));
        try {
          win.webContents.setZoomFactor(factor);
        } catch (_) { /* ignore */ }
        try {
          win.webContents.send('window-resized-by-shortcut', {
            width: newW,
            height: newH,
            zoom: factor
          });
        } catch (_) { /* ignore */ }
        logger.info('Overlay window resized via shortcut', {
          type,
          from: { w, h },
          to: { w: newW, h: newH },
          zoom: factor
        });
        anyResized = true;
      }
    } finally {
      // Reset shortly after the synchronous setContentSize calls return.
      // Will-resize (if it fires at all for programmatic resize) has already
      // been observed by then.
      setTimeout(() => { this._resizingByShortcut = false; }, 50);
    }
    if (anyResized) {
      // Slide LLM directly under main so they stay glued together — NOT
      // `positionBoundWindows`, which used to snap BOTH windows back to
      // top-center of the display on every shortcut press.
      this.positionLLMRelativeToMain();
    }
  }

  /**
   * Backward-compat shim — some older call sites still pass to the old name.
   * New code should use `stepOverlayWindowSize`.
   */
  stepMainWindowSize(delta) {
    return this.stepOverlayWindowSize(delta);
  }

  /**
   * Called from main.js's resize-window handler. Returns the height the
   * renderer requested clamped to a minimum so the window can never look
   * like a flat strip. (Height-clamping only fires when the renderer
   * didn't just receive a manual resize — otherwise it'd undo the
   * shortcut immediately.)
   */
  getMinMainHeight() {
    return 70;
  }

  isAutoShrinkSuspended() {
    return this._suspendAutoShrink && Date.now() < this._suspendAutoShrink;
  }

  /**
   * Show the LLM response window in "screenshot queue" mode — the window
   * renders queued-shot thumbnails from broadcast events, so all this does
   * is make sure it's visible. New windows default to full opacity.
   *
   * The previous version just called `showOnCurrentDesktop` and trusted the
   * window to re-show at its last position, which left three failure modes
   * that all looked like "screenshot didn't work":
   *
   *   1. The window had been moved offscreen / behind another window and
   *      `show()` re-emerged it there. `centerWindow` puts it back at top-
   *      center where users actually look.
   *   2. The user had been mashing Alt+- to make overlays transparent; the
   *      cap of `Math.max(this.overlayOpacity, 0.6)` was supposed to guard
   *      against this but if the previous overlayOpacity was 0 the window
   *      ended up at 0.6 — visible, but easy to overlook if the user
   *      expected full opacity. We now force full opacity for this one
   *      window so the queue is impossible to miss.
   *   3. `restoreOverlaysAfterCapture` was restoring `main`/`chat`
   *      *before* `showScreenshotQueue` ran in some racing captures, so the
   *      user saw their old chat window but no queue. The order in
   *      `_captureOneScreenshot` already handles this, but we also
   *      `moveTop()` here as belt-and-suspenders.
   */
  showScreenshotQueue() {
    const win = this.windows.get('llmResponse');
    if (!win || win.isDestroyed()) return;
    this.bringLLMWindowToFront('queue');
    logger.info('Screenshot queue shown', {
      visible: win.isVisible(),
      bounds: win.getBounds ? win.getBounds() : null
    });
  }

  /**
   * Single source of truth for "make the LLM response window visible".
   * Three call sites used to duplicate this logic (showLLMResponse /
   * showLLMLoading / showScreenshotQueue) and each one inherited the same
   * failure modes: an offscreen position from a previous session, a
   * zero-opacity overlay from a previous Alt+- spree, or a competing focus
   * owner. Now all three go through here and the window pops up reliably
   * at top-center, full opacity, on top.
   */
  bringLLMWindowToFront(reason = 'response') {
    const win = this.windows.get('llmResponse');
    if (!win || win.isDestroyed()) {
      // Belt-and-suspenders: the render-process-gone handler should have
      // already recreated the window. If we still see no live handle, try
      // to recreate it synchronously here so the user doesn't get a silent
      // no-op (the previous failure mode was: user presses Ctrl+Alt+D,
      // the LLM window died earlier, nothing pops up, user blames the
      // app for "broken window display").
      logger.warn('bringLLMWindowToFront: no llmResponse window, attempting recovery', { reason });
      try {
        // createLLMResponseWindow is async — fire-and-forget here; the
        // caller (showLLMResponse / showLLMLoading) will have already
        // queued the IPC message that will be delivered once the window
        // finishes loading. Don't block the caller waiting for it.
        this.createLLMResponseWindow().then(() => {
          const fresh = this.windows.get('llmResponse');
          if (fresh && !fresh.isDestroyed()) {
            // Apply current global overlayOpacity so the recovered window
            // matches the user's Alt+= / Alt+- setting instead of jumping
            // back to fully opaque while the other overlays stay dim.
            try { fresh.setOpacity(this.overlayOpacity); } catch (_) { /* ignore */ }
            try { this.positionLLMRelativeToMain(); } catch (_) { /* ignore */ }
            try { this.showOnCurrentDesktop(fresh); } catch (_) { /* ignore */ }
            logger.info('LLM window recovered on-demand', { reason });
          }
        }).catch((err) => {
          logger.error('LLM window recovery failed', { reason, error: err.message });
        });
      } catch (err) {
        logger.error('Could not schedule LLM window recovery', { reason, error: err.message });
      }
      return;
    }
    logger.info('bringLLMWindowToFront:start', { reason });
    // Sync the AI response / screenshot-queue window's opacity to the
    // global `overlayOpacity` (the value the user sets via Alt+= / Alt+- /
    // Alt+0). We deliberately do NOT force 1.0 here — previously this
    // window would pop up fully opaque while main/chat stayed dim, which
    // is jarring: the user moves the slider down for stealth and one
    // window "leaks" at full brightness. Now all three stealth overlays
    // (main / chat / llmResponse) move together as one opacity group.
    try { win.setOpacity(this.overlayOpacity); } catch (e) { logger.warn('setOpacity failed', { err: e.message }); }
    // Position the LLM window RELATIVE to wherever the main router window
    // currently is — same x, just below it with the configured gap. We no
    // longer call `centerWindow(win)` here, because that was snapping the
    // window back to top-center every time the user pressed Ctrl+Alt+S/D/X,
    // and the user reported "the LLM window keeps jumping around and ends
    // up invisible". Relative positioning keeps the user's chosen layout
    // intact across screenshot / send / clear actions.
    try { this.positionLLMRelativeToMain(); } catch (e) { logger.warn('positionLLMRelativeToMain failed', { err: e.message }); }
    try { this.showOnCurrentDesktop(win); } catch (e) { logger.warn('showOnCurrentDesktop failed', { err: e.message }); }
    try { win.moveTop(); } catch (e) { logger.warn('moveTop failed', { err: e.message }); }
    try { win.focus(); } catch (e) { logger.warn('focus failed', { err: e.message }); }
    logger.info('LLM window brought to front', {
      reason,
      visible: win.isVisible(),
      bounds: win.getBounds ? win.getBounds() : null
    });
  }

  showSettings() {
    if (this.isScreenBeingShared) return;

    const settingsWindow = this.windows.get('settings');
    if (settingsWindow) {
      this.showOnCurrentDesktop(settingsWindow);
      this.centerWindow(settingsWindow); // This now positions at top-center
      
      // Notify that settings window is shown
      setTimeout(() => {
        settingsWindow.webContents.send('settings-window-shown');
      }, 50);
      
      logger.info('Settings window displayed at top');
    }
  }

  hideSettings() {
    const settingsWindow = this.windows.get('settings');
    if (settingsWindow) {
      settingsWindow.hide();
    }
  }

  async showOnboarding() {
    if (this.isScreenBeingShared) return null;

    let onboardingWindow = this.windows.get('onboarding');
    if (!onboardingWindow) {
      onboardingWindow = await this.createWindow('onboarding');
      this.windows.set('onboarding', onboardingWindow);

      // Once the wizard renderer signals it's ready, send it the
      // current first-run status so it can pre-populate correctly.
      onboardingWindow.webContents.once('did-finish-load', () => {
        logger.info('Onboarding window loaded');
      });
    }

    this.showOnCurrentDesktop(onboardingWindow);
    this.centerWindow(onboardingWindow);
    onboardingWindow.focus();
    logger.info('Onboarding window displayed');
    return onboardingWindow;
  }

  hideOnboarding() {
    const onboardingWindow = this.windows.get('onboarding');
    if (onboardingWindow) {
      onboardingWindow.hide();
    }
  }

  closeOnboarding() {
    const onboardingWindow = this.windows.get('onboarding');
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
    this.windows.delete('onboarding');
  }

  expandLLMWindow(contentMetrics = null) {
    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || this.isScreenBeingShared) return;

    const optimalSize = this.calculateOptimalWindowSize(contentMetrics);

    // Ensure we have valid numbers for setSize
    const width = Math.round(Number(optimalSize.width)) || 1280;
    const height = Math.round(Number(optimalSize.height)) || 620;

    llmWindow.setSize(width, height);

    // If windows are bound, position them together; otherwise center the LLM window
    if (this.bindWindows) {
      this.positionBoundWindows();
    } else {
      this.centerWindow(llmWindow);
    }

    logger.debug('LLM window resized', {
      newSize: `${width}x${height}`,
      basedOnContent: !!contentMetrics,
      boundWindows: this.bindWindows
    });
  }

  calculateOptimalWindowSize(contentMetrics) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;

    let width = 1280; // Default LLM window width - wide by default so code is fully visible
    let height = 620; // Default LLM window height

    if (contentMetrics && typeof contentMetrics === 'object') {
      const lineCount = Number(contentMetrics.lineCount) || 20;
      const avgLineLength = Number(contentMetrics.avgLineLength) || 80;
      const hasCode = !!contentMetrics.hasCode;
      // When there's code, give the code panel ~60% of the window width so long
      // lines don't get clipped behind a horizontal scrollbar.
      const widthPerChar = hasCode ? 12 : 9;
      const minWidth = hasCode ? 1100 : 900;

      width = Math.min(Math.max(avgLineLength * widthPerChar, minWidth), screenWidth * 0.95);
      height = Math.min(Math.max(lineCount * 24 + 160, 400), screenHeight * 0.9);
    }

    return {
      width: Math.round(Number(width)) || 1280,
      height: Math.round(Number(height)) || 620
    };
  }

  centerWindow(window) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    const [windowWidth, windowHeight] = window.getSize();
    
    // Center horizontally but position at top
    const topMargin = 20;
    const x = displayX + Math.round((screenWidth - windowWidth) / 2);
    const y = displayY + topMargin;
    
    window.setPosition(x, y);
    
    logger.debug('Positioned window at top-center', {
      position: `${x},${y}`,
      topMargin,
      display: display.id || 'primary'
    });
  }

  broadcastToAllWindows(channel, data) {
    const windowStates = {};

    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
        windowStates[type] = {
          isVisible: window.isVisible(),
          isDestroyed: window.isDestroyed(),
          hasWebContents: !!window.webContents
        };
      } else {
        windowStates[type] = { isDestroyed: true };
      }
    });

    // Per-chunk streaming broadcasts (e.g. transcription-llm-response-chunk
    // fires every ~10ms during a response) used to log a multi-line JSON
    // block here. At one response per minute that produced ~150k log lines
    // per day and buried the actual crash signatures. Keep the loud logs
    // for the meaningful channels and drop the rest to debug.
    const isHighFrequency = typeof channel === 'string' &&
      (channel.endsWith('-chunk') || channel === 'voice-stream' || channel === 'transcript-partial');
    if (isHighFrequency) {
      logger.debug('Broadcast sent to all windows', {
        channel,
        windowCount: this.windows.size
      });
    } else {
      logger.info('Broadcast sent to all windows', {
        channel,
        windowCount: this.windows.size,
        windowStates,
        dataKeys: data ? Object.keys(data) : [],
        // Fixed: Check for 'content' instead of 'response' to match actual data structure
        dataPreview: data && data.content ? data.content.substring(0, 50) + '...' :
                     data && data.response ? data.response.substring(0, 50) + '...' : 'No response'
      });
    }
  }

  getWindow(type) {
    return this.windows.get(type);
  }

  getActiveWindow() {
    return this.windows.get(this.activeWindow);
  }

  getWindowStats() {
    const stats = {};
    
    this.windows.forEach((window, type) => {
      stats[type] = {
        isVisible: window.isVisible(),
        isFocused: window.isFocused(),
        position: window.getPosition(),
        size: window.getSize()
      };
    });
    
    return {
      windows: stats,
      activeWindow: this.activeWindow,
      isInteractive: this.isInteractive,
      isVisible: this.isVisible,
      isScreenBeingShared: this.isScreenBeingShared
    };
  }

  destroyAllWindows() {
    this.windows.forEach((window, type) => {
      logger.debug('Destroying window', { type });
      if (!window.isDestroyed()) {
        window.destroy();
      }
    });
    
    this.windows.clear();
    
    // Clean up all watchers
    if (this.screenWatcher) {
      clearInterval(this.screenWatcher);
      this.screenWatcher = null;
    }
    
    if (this.desktopWatcher) {
      clearInterval(this.desktopWatcher);
      this.desktopWatcher = null;
    }

    logger.info('All windows destroyed');
  }

  setupScreenTracking() {
    // Initialize with current cursor position to get the active display
    const cursorPoint = screen.getCursorScreenPoint();
    this.currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
    
    screen.on('display-added', () => {
      logger.debug('Display added');
      this.handleDisplayChange();
    });

    screen.on('display-removed', () => {
      logger.debug('Display removed');
      this.handleDisplayChange();
    });

    screen.on('display-metrics-changed', () => {
      logger.debug('Display metrics changed');
      this.handleDisplayChange();
    });

    // More frequent tracking during initialization
    this.screenWatcher = setInterval(() => {
      this.trackActiveScreen();
    }, 2000);

    // SIMPLIFIED desktop tracking
    this.setupDesktopTracking();

    logger.info('Screen and desktop tracking initialized', {
      currentDisplay: this.currentDisplay.id,
      cursorPosition: cursorPoint
    });
  }

  handleDisplayChange() {
    setTimeout(() => {
      this.moveWindowsToActiveScreen();
    }, 500);
  }

  trackActiveScreen() {
    if (this.isScreenBeingShared) return;

    const cursorPoint = screen.getCursorScreenPoint();
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);
    
    if (!this.currentDisplay || activeDisplay.id !== this.currentDisplay.id) {
      this.currentDisplay = activeDisplay;
      this.moveWindowsToActiveScreen();
      
      logger.debug('Active screen changed', {
        displayId: activeDisplay.id,
        bounds: activeDisplay.bounds
      });
    }
  }

  moveWindowsToActiveScreen() {
    if (!this.currentDisplay || this.isScreenBeingShared) return;

    const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = this.currentDisplay.workArea;
    
    // Handle bound windows specially
    if (this.bindWindows) {
      const mainWindow = this.windows.get('main');
      const llmWindow = this.windows.get('llmResponse');
      
      if (mainWindow && llmWindow && !mainWindow.isDestroyed() && !llmWindow.isDestroyed()) {
        // Position bound windows on the new screen and ensure they appear on current desktop
        this.positionBoundWindows();
        if (mainWindow.isVisible()) this.showOnCurrentDesktop(mainWindow);
        if (llmWindow.isVisible()) this.showOnCurrentDesktop(llmWindow);
      }
    }
    
    this.windows.forEach((window, type) => {
      if (window && !window.isDestroyed()) {
        // Skip main and llmResponse if they're bound (already handled above)
        if (this.bindWindows && (type === 'main' || type === 'llmResponse')) {
          return;
        }
        
        const [windowWidth, windowHeight] = window.getSize();
        
        let newX, newY;
        
        // All windows positioned at top of screen
        const topMargin = 20;
        
        switch (type) {
          case 'main':
            newX = displayX + 50;
            newY = displayY + topMargin;
            break;
          case 'chat':
            newX = displayX + displayWidth - windowWidth - 50;
            newY = displayY + topMargin;
            break;
          case 'skills':
            newX = displayX + 50;
            newY = displayY + topMargin + 100; // Slightly lower to avoid overlap
            break;
          case 'llmResponse':
            newX = displayX + (displayWidth - windowWidth) / 2;
            newY = displayY + topMargin;
            break;
          case 'settings':
            newX = displayX + (displayWidth - windowWidth) / 2;
            newY = displayY + topMargin;
            break;
          default:
            newX = displayX + 100;
            newY = displayY + topMargin;
        }
        
        window.setPosition(Math.round(newX), Math.round(newY));
        
        // Ensure always-on-top is maintained after moving
        if (process.platform === 'darwin') {
          window.setAlwaysOnTop(true, 'screen-saver', 1);
        } else {
          window.setAlwaysOnTop(true);
        }
        
        // Ensure window appears on current desktop if it's visible
        if (window.isVisible()) {
          this.showOnCurrentDesktop(window);
        }
        
        logger.debug('Window moved to active screen and shown on current desktop', {
          type,
          position: `${newX},${newY}`,
          isVisible: window.isVisible(),
          displayId: this.currentDisplay.id
        });
      }
    });
  }

  setupDesktopTracking() {
    // MUCH less aggressive desktop tracking
    this.desktopWatcher = setInterval(() => {
      this.trackDesktopChanges();
    }, 10000); // Changed from 1500ms to 10000ms (10 seconds)

    logger.info('Desktop tracking initialized');
  }

  trackDesktopChanges() {
    if (this.isScreenBeingShared) return;

    // Simplified tracking - just log changes
    if (process.platform === 'darwin') {
      const cursorPoint = screen.getCursorScreenPoint();
      const currentSpaceSignature = `${cursorPoint.x}_${cursorPoint.y}`;
      
      if (this.lastActiveSpace && this.lastActiveSpace !== currentSpaceSignature) {
        logger.debug('Desktop space might have changed');
      }
      
      this.lastActiveSpace = currentSpaceSignature;
    }
  }

  // REMOVED all the aggressive enforcement methods that were causing flickering:
  // - handlePossibleSpaceChange()
  // - handleSpaceChange() 
  // - ensureWindowVisibility()
  // - enforceWindowProperties()
  // - enforceAllWindowProperties()
  // - enforceAlwaysOnTop()

  // Public methods for manual screen sharing control
  enableScreenSharingMode() {
    this.startScreenSharingMode();
  }

  disableScreenSharingMode() {
    this.stopScreenSharingMode();
  }

  isInScreenSharingMode() {
    return this.isScreenBeingShared;
  }

  // Window binding management methods
  setWindowBinding(enabled) {
    this.bindWindows = enabled;
    
    if (enabled) {
      // Position bound windows when binding is enabled
      const mainWindow = this.windows.get('main');
      const llmWindow = this.windows.get('llmResponse');
      
      if (mainWindow && llmWindow) {
        this.positionBoundWindows();
      }
      
      logger.info('Window binding enabled');
    } else {
      logger.info('Window binding disabled');
    }
    
    return this.bindWindows;
  }

  toggleWindowBinding() {
    return this.setWindowBinding(!this.bindWindows);
  }

  getWindowBindingStatus() {
    return {
      enabled: this.bindWindows,
      gap: this.windowGap,
      position: this.boundWindowsPosition
    };
  }

  setWindowGap(gap) {
    this.windowGap = Math.max(0, gap);
    
    // Re-position if currently bound
    if (this.bindWindows) {
      this.positionBoundWindows();
    }
    
    logger.debug('Window gap updated', { gap: this.windowGap });
    return this.windowGap;
  }

  showChatWindow() {
    const chatWindow = this.windows.get('chat');
    if (chatWindow && !chatWindow.isDestroyed()) {
      this.showOnCurrentDesktop(chatWindow);
      // Multiple always-on-top windows stack; without raise+focus the chat
      // window appears behind the overlay and users report "chat won't open".
      chatWindow.moveTop();
      chatWindow.focus();
      logger.debug('Chat window shown');
    }
  }

  hideChatWindow() {
    const chatWindow = this.windows.get('chat');
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.hide();
      logger.debug('Chat window hidden');
    }
  }

  handleRecordingStarted() {
    this.isRecording = true;
    this.showChatWindow();
    // Notify all windows about recording state
    this.broadcastToAllWindows('recording-started');
    logger.debug('Recording started, chat window shown');
  }

  handleRecordingStopped() {
    this.isRecording = false;
    // Notify all windows about recording state
    this.broadcastToAllWindows('recording-stopped');
    logger.debug('Recording stopped, chat window kept visible for the response');
  }

  broadcastSkillChange(skill) {
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.webContents.send('skill-changed', { skill });
      }
    });
    
    logger.info('Skill change broadcasted to all windows', { 
      skill,
      windowCount: this.windows.size 
    });
    }
}

module.exports = new WindowManager();
