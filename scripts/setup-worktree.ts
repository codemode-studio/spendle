/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell the harness spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies and links the main checkout's gitignored env files into this
 * worktree.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const ENV_FILES = ['.env.local']

const worktree = process.argv.at(2) ?? process.cwd()

// The main checkout holds the gitignored env files. It is either passed through
// the environment by the setup action or taken from the repo's common git
// directory, so the script works when run by people too.
let mainCheckout = process.env.T3CODE_PROJECT_ROOT
if (!mainCheckout) {
  const commonDir = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      cwd: worktree,
      encoding: 'utf8',
    },
  )
  if (commonDir.status !== 0) process.exit(commonDir.status ?? 1)
  // The common directory lives inside the worktree that owns the repository.
  mainCheckout = commonDir.stdout.trim().replace(/\/\.git$/, '') || undefined
}
if (!mainCheckout || realpathSync(mainCheckout) === realpathSync(worktree)) {
  console.log('No linked checkout: running in the main checkout itself.')
  mainCheckout = undefined
}

const install = spawnSync('vp install --frozen-lockfile', {
  cwd: worktree,
  shell: true,
  stdio: 'inherit',
})
if (install.status !== 0) process.exit(install.status ?? 1)

if (mainCheckout) {
  for (const file of ENV_FILES) {
    const source = join(mainCheckout, file)
    if (!existsSync(source)) continue
    const target = join(worktree, file)
    rmSync(target, { force: true })
    symlinkSync(source, target)
    console.log(`Linked ${file} from ${mainCheckout}`)
  }
}
