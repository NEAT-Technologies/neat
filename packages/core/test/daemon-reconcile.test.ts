import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  reconcileDaemonRecordSync,
  daemonJsonPath,
  daemonDiscoveryPath,
  type DaemonRecord,
} from '../src/daemon.js'

// #597 (b) — a daemon that goes down for any reason must reconcile its own
// self-description so a dead daemon never leaves a `running` record routing
// clients at a port nothing is listening on. The graceful `stop()` does this
// asynchronously; `reconcileDaemonRecordSync` is the synchronous backstop the
// process-exit handler runs for a crash or a fatal signal, where there's no
// chance to await async fs.

let home: string
let projectPath: string

function record(over: Partial<DaemonRecord> = {}): DaemonRecord {
  return {
    project: 'alpha',
    projectPath,
    pid: 4242,
    status: 'running',
    ports: { rest: 8080, otlp: 4318, web: 6328 },
    startedAt: '2026-06-13T00:00:00.000Z',
    neatVersion: '0.4.17',
    ...over,
  }
}

async function writeRunningRecord(rec: DaemonRecord): Promise<void> {
  await fs.mkdir(path.dirname(daemonJsonPath(rec.projectPath)), { recursive: true })
  await fs.writeFile(daemonJsonPath(rec.projectPath), JSON.stringify(rec, null, 2) + '\n', 'utf8')
  const discovery = daemonDiscoveryPath(rec.project, home)
  await fs.mkdir(path.dirname(discovery), { recursive: true })
  await fs.writeFile(discovery, JSON.stringify(rec, null, 2) + '\n', 'utf8')
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-reconcile-home-'))
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-reconcile-proj-'))
})

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(projectPath, { recursive: true, force: true })
})

describe('reconcileDaemonRecordSync (#597)', () => {
  it('flips neat-out/daemon.json to status=stopped and removes the discovery copy', async () => {
    const rec = record()
    await writeRunningRecord(rec)

    reconcileDaemonRecordSync(rec, home)

    const reconciled = JSON.parse(
      await fs.readFile(daemonJsonPath(projectPath), 'utf8'),
    ) as DaemonRecord
    // The neat-out/ record survives so a later read can tell "shut down
    // cleanly" from "never ran", but it must no longer claim to be running.
    expect(reconciled.status).toBe('stopped')
    expect(reconciled.ports).toEqual(rec.ports)
    // The discovery copy is gone so `neat ps` stops listing a dead daemon.
    await expect(fs.access(daemonDiscoveryPath('alpha', home))).rejects.toThrow()
  })

  it('never throws when the record files are already gone (crash backstop is best-effort)', () => {
    // No files written — an exit handler that fires twice, or after a graceful
    // stop already cleared everything, must not throw out of process exit.
    expect(() => reconcileDaemonRecordSync(record(), home)).not.toThrow()
  })
})
