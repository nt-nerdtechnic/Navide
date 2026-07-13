import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * Application menu.
 *
 * This mirrors Electron's built-in default menu with ONE deliberate omission:
 * the View submenu's `resetZoom` / `zoomIn` / `zoomOut` roles. Those roles bind
 * ⌘0 / ⌘+ / ⌘- to `webContents` zoom, which scales the ENTIRE window — chrome,
 * layout, every pane — and their native accelerators fire before the renderer's
 * key handlers. Zoom in this app is per-pane content zoom only (xterm font size
 * in useTerminal.ts, Monaco font size in EditorViewMonaco.vue), so the built-in
 * roles must not exist. Installing a menu without them is the only way to drop
 * them: Electron has no API to edit the default menu in place.
 *
 * Everything else is kept because on macOS accelerators like ⌘C / ⌘V / ⌘Q only
 * work when a menu item declares them — `setApplicationMenu(null)` would break
 * copy/paste and quit.
 */
export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions,
              { role: 'delete' } as MenuItemConstructorOptions,
              { role: 'selectAll' } as MenuItemConstructorOptions
            ]
          : [
              { role: 'delete' } as MenuItemConstructorOptions,
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'selectAll' } as MenuItemConstructorOptions
            ])
      ]
    },
    {
      label: 'View',
      // No resetZoom / zoomIn / zoomOut — see the doc comment above.
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        // macOS "zoom" = maximize the window frame. Unrelated to content zoom,
        // has no accelerator, and is part of the standard Window menu.
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'front' } as MenuItemConstructorOptions
            ]
          : [{ role: 'close' } as MenuItemConstructorOptions])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
