# Update guard

Shows which installed plugins support the DSH release a Desktop update would
install, and asks for one confirmation before the download starts.

## Compatibility

Declared range: `>=0.2.3-alpha.2`. The bundle loads on every DSH release from
0.2.3-alpha.2 onward, prereleases included, and is not capped at the next minor
line, so an update does not disable the guard that is meant to warn about it.
Development and verification used the 0.2.x line; newer lines are best effort.

What a later release can change, and what you would see:

| Dependency | If a release changes it |
|---|---|
| Host exact Fetch route (`connection.fetch.register`) | the dialog still opens and reports that compatibility could not be checked; the update can still continue |
| `pluginManager` listings | falls back to the profile `package.json`, so installed bundles are still listed |
| `shell.overlay` slot or its `hooks` projection | the dialog entry stops activating, so the update control behaves as if the bundle were absent |
| Electron `dshDesktop.updates` bridge or the shell's update control | the control is not intercepted and the download runs unchanged |
| the `settings` locale key behind the control label | interception falls back to the eight shipped translations; a renamed key with new wording is not recognised |

None of these breaks the application or the update itself: this bundle only adds
a confirmation in front of a download the shell already owns.

## What it does

The Desktop app offers a new DSH release through the update control in the
sidebar footer (labelled **Update** / **新版本**). Choosing it normally starts the
download immediately. With this bundle loaded, that one click first opens a
confirmation dialog:

- **Everything declared compatible** — the dialog reports how many plugins were
  checked and one click on **Update to …** continues the download exactly as
  before.
- **Some plugins declare no support** — the dialog names them with their
  installed version and the requirement the target release fails, for example
  `engines.dsh: >=0.2.2-rc.1 <0.2.3-0`. You can cancel, or choose
  **Update anyway**.
- **Plugins that declare no DSH requirement** are counted separately instead of
  being called compatible, so the headline never claims a support nobody
  declared.
- **Some manifests could not be read** — those plugins are named separately and
  are not counted as conflicts.
- **The check failed** — the dialog says why and offers **Retry**, **Cancel**,
  and still **Update anyway**.

A plugin that is already disabled does not count as a conflict, because DSH never
loads it; if only disabled plugins declare no support, the dialog says so. The
guard does not list itself.

Cancelling closes the dialog without downloading anything. The shell's own
download progress, verification, install confirmation, and restart stay
unchanged; the guard only adds the confirmation in front of the download.

## How compatibility is decided

The Host reproduces the rule DSH itself applies to a plugin
(`evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`):

- an own `engines.dsh` range decides alone; otherwise
- every `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peer range must match, and
- ranges are tested with SemVer including prerelease versions, so
  `^0.2.3-alpha.2` accepts `0.2.4-alpha.1` and `0.2.9`, while
  `>=0.2.2-rc.1 <0.2.3-0` rejects both.

The answer is therefore what the updated Host will apply to the same manifests.
Bundles that DSH ships with the installation are not listed: they follow the
release by construction.

## Where the data comes from

The browser half asks one authenticated route, `GET /api/dsh-update-guard/report`,
which the Host half registers while the bundle is mounted. For the requested
target release the Host reads `pluginManager.listBundles()` and
`listPlugins()`, then reads each third-party package's `package.json` from the
profile. Nothing is cached, no plugin is loaded or activated, and no network
request leaves the machine. If the plugin manager is not composed, the profile
`package.json` bundle list is used instead.

## Use it

Install the bundle, then choose **Update** / **新版本** in the sidebar footer
when one is offered. The dialog appears before anything downloads. The gate
needs the Desktop application: in an ordinary browser page there is no update
control to guard, and the bundle stays idle.

## Install

Paste either spec into **Plugins → Add plugin**:

- the npm package, once published: `@palpitation6/dsh-update-guard@1.0.2`
- this repository pinned to a commit, which DSH can later update from the same
  spec: `git+https://github.com/palpitation6/dsh-update-guard.git#<full-40-character-commit>`

The Host half activates when the bundle is selected. The dialog reaches an open
desktop window through the client bundle; a page refresh applies it when the
client bundle was not hot-reloaded.

## Update

The profile stores exactly what was installed, so an update keeps the same spec
kind:

- **Registry install** (the npm package): the Plugins page lists the newer
  published version and updates in place. Bump `version` before publishing; the
  manager only offers versions higher than the installed one.
- **Git install**: install the new commit with the same pinned form —
  `git+https://github.com/palpitation6/dsh-update-guard.git#<new-full-commit>`.
  The manager removes the installed copy, installs the new commit with the same
  selection, and reinstalls the previous copy if that fails. A branch, tag, or
  range spec cannot be updated this way, and the commit must be the full
  40-character id.
- **Local directory install**: installation links the directory, so editing the
  files is the update. Re-selecting the row recomposes it.

The Profile keeps its selected bundle across all three paths, so nothing else
needs re-enabling after an update.

## Limitations

- Only the Desktop update control in the sidebar footer is gated. The native
  application menu's **Check for Updates…** item and enterprise mandatory
  updates run in the Electron shell before any page code, so they cannot be
  intercepted from a plugin.
- The guard reads declared version ranges; it cannot know whether a plugin is
  actually broken by an update that its range permits.
- The target version is whatever the shell reports for the offered update; if
  the shell starts a download without that control, the dialog is not involved.
- Plugins installed as a `file:`/`link:` directory are checked from that
  directory's manifest, so editing it changes the answer.
- The Host locates the profile from a live plugin row that names its own
  location, then from `DSH_PROFILE_DIR`, then from the profile under the
  Harness home that selects this bundle. A Host booted without any profile
  cannot answer, and the dialog reports the failure.
- The dialog is available in English and Chinese; other application languages
  fall back to English.

## Notes

- The check reports the running Host's installed plugins; a plugin installed in
  another profile is not considered.
- Version exemptions saved for the current release do not carry over to the
  target release, so an exempted mismatch is still listed.
- A malformed `engines.dsh` is reported as a conflict, which is also how DSH
  treats such a manifest at load time.
