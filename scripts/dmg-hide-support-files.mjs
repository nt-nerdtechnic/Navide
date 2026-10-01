// electron-builder beforePack hook: park the DMG's support files outside the
// Finder window.
//
// dmgbuild writes .background.tiff and .VolumeIcon.icns into the volume root.
// With "Show hidden files" on, Finder lays them out over the
// Navide.app → Applications arrangement. dmgbuild accepts `type: "position"`
// contents entries that only set an icon location, but electron-builder
// 26.16.1's config schema rejects that type (it allows dir/file/link only),
// so the entries are appended here, after schema validation. dmg-builder
// passes `type` through to dmgbuild unchanged.
//
// The DMG target holds a reference to `config.dmg` before this hook runs, so
// `dmg.contents` must already be declared in package.json; this hook mutates
// that same array in place.

// The window is sized to the 540×380 default background; y = 600 is below it.
const PARKED = [
  { x: 130, y: 600, type: 'position', path: '.background.tiff' },
  { x: 410, y: 600, type: 'position', path: '.VolumeIcon.icns' },
]

export function beforePack(context) {
  const contents = context.packager.config.dmg?.contents
  if (!Array.isArray(contents)) return
  for (const entry of PARKED) {
    if (!contents.some((c) => c.path === entry.path)) contents.push({ ...entry })
  }
}
