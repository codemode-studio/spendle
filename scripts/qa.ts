import { eq } from 'drizzle-orm'
import { shiftDays } from '../src/domain/period'
import { spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join, sep } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { openDatabase } from '../src/db/connection.server'
import { qaIds, seedQaDatabase } from '../src/db/qa-seed.server'
import * as schema from '../src/db/schema'

const root = resolve('.qa')
const command = process.argv.at(2) ?? 'start'
const argument = process.argv.at(3)
const portArgument = process.argv.at(4)
const marker = 'financas-familia-qa-v1'
function ownedRun(value: string | undefined) {
  if (!value) throw new Error('Supply the run directory printed by qa:start.')
  const path = realpathSync(value)
  if (
    !path.startsWith(`${realpathSync(root)}${sep}`) ||
    JSON.parse(readFileSync(join(path, 'run.json'), 'utf8')).kind !== marker
  ) {
    throw new Error('This directory is not an owned QA run.')
  }
  return path
}

if (command === 'inspect') {
  const directory = ownedRun(argument)
  const sqlite = new Database(join(directory, 'finance.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    console.log(
      JSON.stringify(
        {
          transactions: sqlite
            .prepare(
              'select id, posted_at, amount_cents, category_id, status from transactions order by posted_at desc, id limit 100',
            )
            .all(),
          imports: sqlite
            .prepare('select id, status, validation_status from imports')
            .all(),
          checkpoints: sqlite
            .prepare(
              'select account_id, as_of, balance_cents, review_state from balance_checkpoints',
            )
            .all(),
          foreignKeys: sqlite.pragma('foreign_key_check'),
        },
        null,
        2,
      ),
    )
  } finally {
    sqlite.close()
  }
} else if (command === 'clean') {
  const directory = ownedRun(argument)
  // Cleanup is explicit and only for a stopped run. Probe the recorded PID first.
  const metadata = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'))
  let running = false
  try {
    process.kill(metadata.pid, 0)
    running = true
  } catch {
    /* Process exited. */
  }
  if (running) throw new Error('Stop the QA server before cleaning its run.')
  rmSync(directory, { recursive: true })
  console.log(`Removed ${directory}`)
} else if (command === 'start') {
  const port = Number(argument ?? 3100)
  const extraRows = Number(portArgument ?? 0)
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isInteger(extraRows) ||
    extraRows < 0 ||
    extraRows > 100_000
  )
    throw new Error('Usage: pnpm qa:start [port] [synthetic-row-count]')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'run-'))
  const url = `http://127.0.0.1:${port}`
  // The V2 API runs beside the app, in memory, with synthetic data and a fake Pluggy.
  const apiPort = port + 1200
  const apiUrl = `http://127.0.0.1:${apiPort}`
  const month = new Date().toISOString().slice(0, 7)
  const date = `${month}-01`
  const connection = openDatabase(join(directory, 'finance.db'))
  try {
    migrate(connection.db, { migrationsFolder: resolve('drizzle') })
    await seedQaDatabase(connection.db)
    const anchorDate = shiftDays(date, -1)
    connection.db
      .insert(schema.balanceCheckpoints)
      .values({
        id: 'qa-opening',
        accountId: qaIds.brlAccount,
        kind: 'manual',
        source: 'manual',
        reviewState: 'verified',
        balanceCents: 0,
        asOf: anchorDate,
        balanceType: 'posted',
      })
      .run()
    connection.db
      .update(schema.accounts)
      .set({ statementBalanceCents: 0, statementBalanceAt: anchorDate })
      .where(eq(schema.accounts.id, qaIds.brlAccount))
      .run()
    for (let offset = 0; offset < extraRows; offset += 100) {
      connection.db
        .insert(schema.transactions)
        .values(
          Array.from(
            { length: Math.min(100, extraRows - offset) },
            (_, index) => ({
              id: `qa-volume-${String(offset + index).padStart(6, '0')}`,
              accountId: qaIds.brlAccount,
              postedAt: date,
              description: `Despesa QA ${offset + index}`,
              normalizedDescription: `despesa qa ${offset + index}`,
              amountCents: -100,
              currency: 'BRL',
              status: 'confirmed' as const,
              categoryId: qaIds.categories.groceries,
              fingerprint: `qa-volume-${offset + index}`,
            }),
          ),
        )
        .run()
    }
  } finally {
    connection.close()
  }
  const ofx = (closing: string, suffix: string) =>
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF><BANKTRANLIST><DTSTART>${month.replace('-', '')}01</DTSTART><DTEND>${month.replace('-', '')}02</DTEND><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>${month.replace('-', '')}01120000[-3:BRT]</DTPOSTED><TRNAMT>1000.00</TRNAMT><FITID>qa-income-${suffix}</FITID><NAME>Receita QA</NAME></STMTTRN><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${month.replace('-', '')}02120000[-3:BRT]</DTPOSTED><TRNAMT>-100.00</TRNAMT><FITID>qa-expense-${suffix}</FITID><NAME>Mercado QA</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>${closing}</BALAMT><DTASOF>${month.replace('-', '')}02</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
  writeFileSync(join(directory, 'balanced.ofx'), ofx('900.00', 'balanced'))
  writeFileSync(join(directory, 'unbalanced.ofx'), ofx('999.00', 'unbalanced'))
  // 121 expenses of R$ 1,00 on the first day of the month, for V2 pagination checks.
  const compact = month.replace('-', '')
  writeFileSync(
    join(directory, 'volume-121.ofx'),
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF><BANKTRANLIST><DTSTART>${compact}01</DTSTART><DTEND>${compact}01</DTEND>${Array.from(
      { length: 121 },
      (_, index) =>
        `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${compact}01120000[-3:BRT]</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>qa-volume-${index}</FITID><NAME>Despesa QA ${index}</NAME></STMTTRN>`,
    ).join(
      '',
    )}</BANKTRANLIST><LEDGERBAL><BALAMT>-121.00</BALAMT><DTASOF>${compact}01</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
  )
  writeFileSync(
    join(directory, 'run.json'),
    JSON.stringify(
      { kind: marker, pid: process.pid, url, directory, date, extraRows },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify(
      {
        url,
        apiUrl,
        directory,
        database: join(directory, 'finance.db'),
        uploads: join(directory, 'imports'),
        date,
        extraRows,
      },
      null,
      2,
    ),
  )
  const log = createWriteStream(join(directory, 'server.log'))
  const apiLog = createWriteStream(join(directory, 'server-v2.log'))
  const api = spawn(
    process.execPath,
    [resolve('packages/server/src/testing/QaServer.ts')],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SPENDLE_SERVER_PORT: String(apiPort) },
    },
  )
  api.stdout.pipe(apiLog)
  api.stderr.pipe(apiLog)
  const child = spawn(
    process.execPath,
    [
      resolve('node_modules/vite/bin/vite.js'),
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: join(directory, 'finance.db'),
        SPENDLE_API_URL: apiUrl,
        SPENDLE_API_TOKEN: '',
        // The fake Pluggy issues fake tokens: open the simulated widget instead.
        SPENDLE_PLUGGY_CONNECT: 'simulated',
        FINANCAS_QA: '1',
        FINANCAS_DEBUG: '1',
        OPENROUTER_API_KEY: '',
        OPENROUTER_MODEL: '',
      },
    },
  )
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    log.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    log.write(chunk)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      child.kill(signal)
      api.kill(signal)
    })
  child.on('exit', (code) => {
    api.kill('SIGTERM')
    log.end()
    process.exitCode = code ?? 0
  })
} else {
  throw new Error('Expected start, inspect or clean.')
}
